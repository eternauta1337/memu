// Control-plane HTTP — el puente entre la web pública (host-web, en ejemplo.com) y el backend de Memo
// (host-backend, donde viven wacli + registry + stores + GPU). host-web NO puede parear WhatsApp (es
// serverless-ish y no tiene el store ni corre el follow); llama acá server-side, por Tailscale,
// con un bearer token. Este proceso aprovisiona usuarios nuevos y los parea por pairing-code
// (`wacli auth --phone --events`, mismo patrón que el enrollment de proyecto-interno).
//
// SEGURIDAD: no se expone a internet. Bindear a la interfaz Tailscale (CONTROL_PLANE_HOST) o a
// 0.0.0.0 con el bearer token SIEMPRE obligatorio. El token es el único gate a "crear usuario +
// parear WhatsApp", así que va fuerte y secreto (CONTROL_PLANE_TOKEN).
//
// Correr en host-backend: `pnpm control-plane`.

import "./env.ts";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { getRegistry } from "./registry.ts";
import { wacliStoreDir } from "./users.ts";

const HOST = process.env.CONTROL_PLANE_HOST ?? "0.0.0.0";
const PORT = Number(process.env.CONTROL_PLANE_PORT ?? 8788);
const TOKEN = process.env.CONTROL_PLANE_TOKEN ?? "";
const WACLI_BIN = process.env.WACLI_BIN ?? "wacli";
const DEVICE_LABEL = process.env.WACLI_DEVICE_LABEL ?? "Memo";
const ENROLL_WAIT_MS = Number(process.env.CP_ENROLL_WAIT_MS ?? 240_000); // espera a que ingrese el código
const BOOTSTRAP_MS = Number(process.env.CP_BOOTSTRAP_MS ?? 120_000); // margen tras conectar (backfill)

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const registry = getRegistry();

type PairStatus = "pairing" | "connected" | "failed";
interface Job {
  userId: number;
  status: PairStatus;
  code?: string; // pairing-code para mostrarle al usuario
  error?: string;
  startedAt: number;
}
const jobs = new Map<number, Job>();

const normalizePhone = (p: string): string => p.replace(/[^0-9]/g, "");

/** Arranca `wacli auth --phone` para un usuario, parsea los eventos NDJSON y actualiza el job +
 *  el registro. Al conectar → status del usuario 'active'. */
function startPairing(userId: number, phone: string): void {
  const store = wacliStoreDir(String(userId));
  const job: Job = { userId, status: "pairing", startedAt: Date.now() };
  jobs.set(userId, job);

  const child = spawn(WACLI_BIN, ["auth", "--phone", phone, "--store", store, "--events"], {
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, WACLI_DEVICE_LABEL: DEVICE_LABEL },
  });

  let settled = false;
  const finish = (status: "connected" | "failed", error?: string): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    job.status = status;
    if (error) job.error = error;
    registry.setStatus(userId, status === "connected" ? "active" : "disabled");
    if (status === "connected") registry.touchActive(userId);
    console.log(dim(`[cp] u${userId} pairing → ${status}${error ? `: ${error}` : ""}`));
    if (status === "connected") setTimeout(() => child.kill("SIGTERM"), BOOTSTRAP_MS).unref();
    else if (!child.killed) child.kill("SIGTERM");
  };

  const timer = setTimeout(() => finish("failed", "timeout esperando el código"), ENROLL_WAIT_MS);

  if (child.stderr) {
    const rl = createInterface({ input: child.stderr });
    rl.on("line", (line) => {
      const s = line.trim();
      if (!s.startsWith("{")) return;
      try {
        const e = JSON.parse(s) as { event?: string; data?: Record<string, unknown> };
        if (e.event === "pair_code" && typeof e.data?.code === "string") {
          job.code = e.data.code;
          console.log(dim(`[cp] u${userId} pair_code emitido`));
        } else if (e.event === "connected") {
          finish("connected");
        }
      } catch {
        /* línea no-JSON (logs) → ignorar */
      }
    });
  }
  child.on("error", (err) => finish("failed", err.message));
  child.on("exit", () => finish("failed", "wacli auth salió sin conectar"));
}

// --- HTTP ---------------------------------------------------------------------------------

function send(res: ServerResponse, code: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json" });
  res.end(s);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function authed(req: IncomingMessage): boolean {
  const h = req.headers.authorization ?? "";
  return TOKEN.length > 0 && h === `Bearer ${TOKEN}`;
}

const server = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? "/", "http://x");
    if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true });

    if (!authed(req)) return send(res, 401, { error: "unauthorized" });

    // POST /provision { email, phone } → crea (o reusa) el usuario y arranca el pairing.
    if (req.method === "POST" && url.pathname === "/provision") {
      const body = await readJson(req).catch((): Record<string, unknown> => ({}));
      const email = String(body.email ?? "").trim().toLowerCase() || null;
      const phone = normalizePhone(String(body.phone ?? ""));
      if (phone.length < 8) return send(res, 400, { error: "teléfono inválido" });

      // Dedup por teléfono. Si ya está activo, no re-pareamos.
      const existing = registry.getUserByPhone(phone);
      let userId: number;
      if (existing) {
        if (existing.status === "active") return send(res, 200, { userId: existing.id, status: "connected" });
        userId = existing.id;
      } else {
        userId = registry.addUser(phone, { status: "pending" }).id;
      }
      registry.setStatus(userId, "pending");
      startPairing(userId, String(body.phone ?? phone));
      console.log(dim(`[cp] provision u${userId} (${email ?? "s/email"}) phone=${phone}`));

      // Esperamos brevemente el pair_code para devolverlo en la misma respuesta.
      const started = Date.now();
      while (Date.now() - started < 15_000) {
        const j = jobs.get(userId);
        if (j?.code) return send(res, 200, { userId, status: "pairing", code: j.code });
        if (j?.status === "failed") return send(res, 502, { userId, status: "failed", error: j.error });
        await new Promise((r) => setTimeout(r, 400));
      }
      return send(res, 202, { userId, status: "pairing" }); // sin código aún → que polee /status
    }

    // GET /status/:userId → estado del pairing.
    const m = url.pathname.match(/^\/status\/(\d+)$/);
    if (req.method === "GET" && m) {
      const userId = Number(m[1]);
      const j = jobs.get(userId);
      const user = registry.getUser(userId);
      if (!j && !user) return send(res, 404, { error: "no existe" });
      const status: PairStatus = user?.status === "active" ? "connected" : (j?.status ?? "pairing");
      return send(res, 200, { userId, status, code: j?.code, error: j?.error });
    }

    return send(res, 404, { error: "not found" });
  })().catch((e) => {
    console.error(`[cp] error: ${(e as Error).message}`);
    if (!res.headersSent) send(res, 500, { error: "internal" });
  });
});

if (!TOKEN) {
  console.error("⚠️  CONTROL_PLANE_TOKEN vacío — el control-plane NO arranca sin token (sería abrir el pairing a cualquiera).");
  process.exit(1);
}
server.listen(PORT, HOST, () => {
  console.log(`control-plane escuchando en ${HOST}:${PORT} (bearer token requerido)`);
});
