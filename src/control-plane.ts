// Control-plane HTTP — el puente entre la web pública (host-web, en ejemplo.com) y el backend de Memu
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
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { normalizePhone } from "./phone.ts";
import { getRegistry } from "./registry.ts";
import { wacliStoreDir } from "./users.ts";

// Token de login por WhatsApp: prefijo reconocible (el bot lo detecta con regex) + 6 chars sin
// ambigüedades. El usuario lo manda al bot por WhatsApp y eso lo verifica. Ver central-bot.ts.
const TOKEN_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function genLoginToken(): string {
  const b = randomBytes(6);
  let s = "MEMU-";
  for (let i = 0; i < 6; i++) s += TOKEN_CHARS[b[i] % TOKEN_CHARS.length];
  return s;
}

const HOST = process.env.CONTROL_PLANE_HOST ?? "0.0.0.0";
const PORT = Number(process.env.CONTROL_PLANE_PORT ?? 8788);
const TOKEN = process.env.CONTROL_PLANE_TOKEN ?? "";
const WACLI_BIN = process.env.WACLI_BIN ?? "wacli";
const DEVICE_LABEL = process.env.WACLI_DEVICE_LABEL ?? "Memu";
const ENROLL_WAIT_MS = Number(process.env.CP_ENROLL_WAIT_MS ?? 240_000); // espera a que ingrese el código
const BOOTSTRAP_MS = Number(process.env.CP_BOOTSTRAP_MS ?? 120_000); // margen tras conectar (backfill)

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const registry = getRegistry();

// (la normalización de teléfono vive en phone.ts — E.164 canónico con libphonenumber)

type PairStatus = "pairing" | "connected" | "failed";
interface Job {
  userId: number;
  status: PairStatus;
  code?: string; // pairing-code para mostrarle al usuario
  codeAt?: number; // cuándo se emitió el código (los de WhatsApp caducan ~1-2 min)
  error?: string;
  startedAt: number;
  child?: ChildProcess; // proceso wacli auth (para poder matarlo al refrescar un código vencido)
}
const jobs = new Map<number, Job>();
const CODE_TTL_MS = 90_000; // pasado esto, un re-provision genera un código nuevo

/** Arranca `wacli auth --phone` para un usuario, parsea los eventos NDJSON y actualiza el job +
 *  el registro. Al conectar → status del usuario 'active'. */
function startPairing(userId: number, phone: string): void {
  const store = wacliStoreDir(String(userId));
  const job: Job = { userId, status: "pairing", startedAt: Date.now() };
  jobs.set(userId, job);

  const child = spawn(WACLI_BIN, ["auth", "--phone", `+${phone}`, "--store", store, "--events"], {
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, WACLI_DEVICE_LABEL: DEVICE_LABEL },
  });
  job.child = child;

  let settled = false;
  const finish = (status: "connected" | "failed", error?: string): void => {
    if (settled) return;
    // Si este job ya fue reemplazado (código refrescado), no tocar el estado compartido del usuario.
    if (jobs.get(userId) !== job) {
      settled = true;
      clearTimeout(timer);
      return;
    }
    settled = true;
    clearTimeout(timer);
    job.status = status;
    if (error) job.error = error;
    registry.setStatus(userId, status === "connected" ? "active" : "disabled");
    if (status === "connected") {
      registry.touchActive(userId);
      // Recién vinculado → entra a la fase de INDEXADO (el bot lo avisa y retiene la inferencia
      // hasta que el historial esté leído). Ver central-bot.ts. Solo si no estaba ya activo/indexado.
      const u = registry.getUser(userId);
      if (u?.onboardingState !== "activo") registry.setOnboardingState(userId, "indexando");
    }
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
          job.codeAt = Date.now();
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
      if (!phone) {
        return send(res, 400, { error: "Número inválido. Poné tu WhatsApp con código de país (ej. +54 9 11…)." });
      }

      // Dedup por teléfono (ya normalizado a E.164). Si ya está activo, no re-pareamos.
      const existing = registry.getUserByPhone(phone);
      let userId: number;
      if (existing) {
        userId = existing.id;
      } else {
        userId = registry.addUser(phone, { status: "pending", email }).id;
      }
      if (email) registry.setEmail(userId, email); // atar el login al usuario (para el "¿ya vinculaste?")
      if (existing?.status === "active") return send(res, 200, { userId, status: "connected" });
      // Idempotente: si ya hay un pairing en curso, NO spawneamos otro wacli (evita doble-pairing /
      // lock) y reusamos el código. PERO si el código ya venció (>CODE_TTL), matamos el viejo y
      // arrancamos uno fresco — así el usuario que tardó puede pedir otro con solo re-escribir.
      const active = jobs.get(userId);
      const codeStale = active?.status === "pairing" && active.code != null && Date.now() - (active.codeAt ?? 0) > CODE_TTL_MS;
      if (!active || active.status !== "pairing" || codeStale) {
        if (codeStale && active?.child && !active.child.killed) active.child.kill("SIGTERM");
        registry.setStatus(userId, "pending");
        startPairing(userId, phone);
      }
      console.log(
        dim(
          `[cp] provision u${userId} (${email ?? "s/email"}) phone=${phone}` +
            (codeStale ? " [código vencido → refresco]" : active?.status === "pairing" ? " [job en curso]" : ""),
        ),
      );

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

    // POST /login/start → crea un token de login por WhatsApp. El usuario se lo manda al bot.
    if (req.method === "POST" && url.pathname === "/login/start") {
      const token = genLoginToken();
      registry.createLogin(token);
      console.log(dim(`[cp] login start ${token}`));
      return send(res, 200, { token });
    }

    // POST /billing { phone?, customerId?, subscriptionId?, status } → actualiza la suscripción de
    // Stripe (lo llama el webhook de memu-web). Resuelve el usuario por teléfono (client_reference_id
    // del checkout → lo crea si es nuevo) o por customerId (eventos de subscription.updated/deleted).
    if (req.method === "POST" && url.pathname === "/billing") {
      const body = await readJson(req).catch((): Record<string, unknown> => ({}));
      const status = String(body.status ?? "").trim() || undefined;
      const customerId = String(body.customerId ?? "").trim() || undefined;
      const subscriptionId = String(body.subscriptionId ?? "").trim() || undefined;
      const phone = body.phone ? normalizePhone(String(body.phone)) : null;

      let user = phone ? registry.getUserByPhone(phone) : customerId ? registry.getUserByStripeCustomer(customerId) : null;
      if (!user && phone) user = registry.addUser(phone, { status: "pending" }); // signup implícito al pagar
      if (!user) return send(res, 404, { error: "usuario no encontrado (falta phone o customer conocido)" });

      registry.setBilling(user.id, { status, customerId, subscriptionId });
      console.log(dim(`[cp] billing u${user.id} → ${status ?? "?"}${customerId ? ` (${customerId.slice(0, 14)}…)` : ""}`));
      return send(res, 200, { userId: user.id, ok: true });
    }

    // GET /login/status?token= → estado del token (pending | verified + userId/phone).
    if (req.method === "GET" && url.pathname === "/login/status") {
      const token = (url.searchParams.get("token") ?? "").trim();
      const login = token ? registry.getLogin(token) : null;
      if (!login) return send(res, 200, { status: "unknown" });
      return send(res, 200, login);
    }

    // GET /user?id= | ?email= → estado de vinculación del usuario (para el "¿ya vinculaste?").
    if (req.method === "GET" && url.pathname === "/user") {
      const id = (url.searchParams.get("id") ?? "").trim();
      const email = (url.searchParams.get("email") ?? "").trim().toLowerCase();
      const user = id ? registry.getUser(Number(id)) : email ? registry.getUserByEmail(email) : null;
      if (!id && !email) return send(res, 400, { error: "falta id o email" });
      if (!user) return send(res, 200, { status: "none" });
      const status = user.status === "active" ? "connected" : user.status === "pending" ? "pending" : "none";
      return send(res, 200, { userId: user.id, status, phone: user.phone });
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
