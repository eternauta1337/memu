// Servidor HTTP loopback que consume el stream de `wacli sync --webhook`.
//
// wacli postea un JSON `ParsedMessage` por evento vivo, con un header
// `X-Wacli-Signature: sha256=<hmac-hex>`. Verificamos el HMAC con el mismo secreto que le
// pasamos a wacli al spawnear el follow, y entregamos el payload parseado al handler.
//
// Bindea a 127.0.0.1: wacli corre en la misma box, así que loopback alcanza y mantiene el
// webhook fuera de cualquier interfaz externa (wacli pide `--webhook-allow-private` para
// aceptar una URL loopback — lo agrega el spawn del follow).
// Portado de otro proyecto interno con el mismo canal de WhatsApp (sin cambios).

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { WacliWebhookMessage } from "./wacli-webhook-types.ts";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

export interface WebhookServerOptions {
  /** Secreto HMAC-SHA256. Se genera si se omite. */
  secret?: string;
  /** Sólo loopback por default; override sólo para tests. */
  host?: string;
  /** Puerto efímero libre si se omite. */
  port?: number;
  /** Base del path del webhook. Default `/wacli`; cada usuario postea a `<basePath>/<userId>`. */
  basePath?: string;
}

export class WacliWebhookServer {
  private readonly secret: string;
  private readonly host: string;
  private readonly requestedPort: number;
  private readonly basePath: string;
  private server: Server | null = null;
  private boundPort = 0;
  private handler: ((userId: string, msg: WacliWebhookMessage) => void | Promise<void>) | null = null;

  constructor(opts?: WebhookServerOptions) {
    this.secret = opts?.secret ?? randomBytes(32).toString("hex");
    this.host = opts?.host ?? "127.0.0.1";
    this.requestedPort = opts?.port ?? 0;
    this.basePath = opts?.basePath ?? "/wacli";
  }

  /** URL del webhook para un usuario: `http://host:port/wacli/<userId>` (multi-tenant). */
  urlFor(userId: string): string {
    if (!this.boundPort) throw new Error("webhook server todavía no escucha");
    return `http://${this.host}:${this.boundPort}${this.basePath}/${encodeURIComponent(userId)}`;
  }

  get webhookSecret(): string {
    return this.secret;
  }

  /** Handler por mensaje. Recibe el `userId` extraído del path (`<basePath>/<userId>`). */
  onMessage(handler: (userId: string, msg: WacliWebhookMessage) => void | Promise<void>): void {
    this.handler = handler;
  }

  async listen(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const server = createServer((req, res) => {
        void this.handleRequest(req, res).catch((err) => {
          console.log(dim(`[webhook] handler crashed: ${String(err)}`));
          if (!res.headersSent) {
            res.writeHead(500, { "content-type": "text/plain" });
            res.end("internal error");
          }
        });
      });
      server.once("error", reject);
      server.listen(this.requestedPort, this.host, () => {
        const addr = server.address();
        if (addr && typeof addr === "object") this.boundPort = addr.port;
        this.server = server;
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => {
      this.server?.close(() => resolve());
    });
    this.server = null;
  }

  private async handleRequest(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ): Promise<void> {
    // Ruteo multi-tenant: el path es `<basePath>/<userId>`. Extraemos el userId (un solo segmento).
    const pathname = req.url ? new URL(req.url, `http://${this.host}`).pathname : "";
    const prefix = `${this.basePath}/`;
    const userId = pathname.startsWith(prefix) ? decodeURIComponent(pathname.slice(prefix.length)) : "";
    if (req.method !== "POST" || !userId || userId.includes("/")) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);

    const signatureHeader = req.headers["x-wacli-signature"];
    if (!verifySignature(this.secret, body, signatureHeader)) {
      console.log(dim("[webhook] firma inválida — rechazado"));
      res.writeHead(401, { "content-type": "text/plain" });
      res.end("signature mismatch");
      return;
    }

    let msg: WacliWebhookMessage;
    try {
      msg = JSON.parse(body.toString("utf8")) as WacliWebhookMessage;
    } catch (err) {
      console.log(dim(`[webhook] payload no-JSON: ${String(err)}`));
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("bad payload");
      return;
    }

    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");

    if (this.handler) {
      try {
        await this.handler(userId, msg);
      } catch (err) {
        console.log(dim(`[webhook] handler threw: ${String(err)} (u${userId} id ${msg.ID})`));
      }
    }
  }
}

function verifySignature(secret: string, body: Buffer, header: string | string[] | undefined): boolean {
  if (!header || Array.isArray(header)) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
