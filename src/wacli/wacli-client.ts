// Cliente del binario `wacli` (whatsmeow, Go): spawnea subcomandos cortos
// (`send text|voice|file|react`, `auth status`) contra el `--store` y parsea el envelope
// JSON `{success,data,error}`. Es la parte de SALIDA; la entrada llega por el webhook de
// `wacli sync --follow` (ver wacli-webhook-server.ts).
// Portado de proyecto-interno/packages/channels/src/wacli-client.ts (sin cambios).
//
// Convive con el `sync --follow` sin pisarlo: wacli ≥0.11 detecta que el store está lockeado
// por el follow y DELEGA el envío al proceso del follow por IPC (`<store>/.send.sock`), que lo
// manda por su conexión ya abierta. No abre un 2º socket ni corta el follow.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface WacliClientOptions {
  /** Path al binario wacli. Default `wacli` (vía PATH) o WACLI_BIN. */
  bin?: string;
  /** Directorio `--store` (frontera de tenant de wacli: auth + SQLite de whatsmeow). */
  store: string;
  /** Timeout por invocación (no-sync). Default: el de wacli (5min). */
  timeoutMs?: number;
}

export class WacliClient {
  private readonly bin: string;
  private readonly store: string;
  private readonly timeoutMs?: number;

  constructor(opts: WacliClientOptions) {
    this.bin = opts.bin ?? process.env.WACLI_BIN ?? "wacli";
    this.store = opts.store;
    this.timeoutMs = opts.timeoutMs;
  }

  get binary(): string {
    return this.bin;
  }

  get storeDir(): string {
    return this.store;
  }

  /**
   * Corre un subcomando wacli y parsea stdout como el envelope `{success,data,error}`.
   * `--json` y `--store` se anteponen automáticamente. Throw si `success:false`.
   */
  private async runJson<T>(subcommand: string[]): Promise<T> {
    const args = ["--json", "--store", this.store, ...subcommand];
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync(this.bin, args, {
        timeout: this.timeoutMs ?? 0,
        maxBuffer: 16 * 1024 * 1024,
      }));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`no encuentro el binario wacli (WACLI_BIN=${this.bin})`);
      }
      throw err;
    }
    const parsed = JSON.parse(stdout) as WacliEnvelope<T>;
    if (!parsed.success) {
      throw new Error(`wacli ${subcommand.join(" ")} falló: ${parsed.error ?? "error desconocido"}`);
    }
    return parsed.data;
  }

  /** `wacli auth status` — `{ authenticated, linked_jid?, phone?, pushname? }`. */
  async authStatus(): Promise<AuthStatus> {
    return this.runJson<AuthStatus>(["auth", "status"]);
  }

  /** Manda un texto. Devuelve la respuesta de wacli (incluye el id del mensaje). */
  async sendText(to: string, message: string, opts?: { replyTo?: string }): Promise<SendResult> {
    const args = ["send", "text", "--to", to, "--message", message];
    if (opts?.replyTo) args.push("--reply-to", opts.replyTo);
    return this.runJson<SendResult>(args);
  }

  /** Manda una nota de voz (OGG/Opus). */
  async sendVoice(to: string, file: string, opts?: { replyTo?: string }): Promise<SendResult> {
    const args = ["send", "voice", "--to", to, "--file", file];
    if (opts?.replyTo) args.push("--reply-to", opts.replyTo);
    return this.runJson<SendResult>(args);
  }

  /** Manda un archivo (imagen/video/audio/documento). El MIME se autodetecta. */
  async sendFile(
    to: string,
    file: string,
    opts?: { caption?: string; filename?: string; replyTo?: string },
  ): Promise<SendResult> {
    const args = ["send", "file", "--to", to, "--file", file];
    if (opts?.caption) args.push("--caption", opts.caption);
    if (opts?.filename) args.push("--filename", opts.filename);
    if (opts?.replyTo) args.push("--reply-to", opts.replyTo);
    return this.runJson<SendResult>(args);
  }

  /** Manda un indicador de presencia: "typing" (composing) o "paused". WhatsApp expira el
   *  "composing" solo a los pocos segundos → hay que refrescarlo si el trabajo tarda. */
  async presence(to: string, state: "typing" | "paused"): Promise<void> {
    await this.runJson(["presence", state, "--to", to]);
  }

  /** Reacciona con un emoji. `reaction=""` lo quita. `sender` hace falta en grupos. */
  async sendReact(
    to: string,
    messageId: string,
    reaction: string,
    opts?: { sender?: string },
  ): Promise<SendResult> {
    const args = ["send", "react", "--to", to, "--id", messageId, "--reaction", reaction];
    if (opts?.sender) args.push("--sender", opts.sender);
    return this.runJson<SendResult>(args);
  }
}

export interface SendResult {
  sent?: boolean;
  id?: string;
  to?: string;
  [k: string]: unknown;
}

export interface AuthStatus {
  authenticated: boolean;
  /** JID linkeado tras parear, ej. `59899…@s.whatsapp.net`. */
  linked_jid?: string;
  jid?: string;
  /** Número en E.164 sin `+`. */
  phone?: string;
  pushname?: string;
}

interface WacliEnvelope<T> {
  success: boolean;
  data: T;
  error: string | null;
}
