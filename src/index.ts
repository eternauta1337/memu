// Orquestador multi-tenant. Levanta el webhook (ruteo `/wacli/<userId>`), crea un runtime por
// cada usuario activo del registro (registry.ts), y un pool controla qué usuarios tienen follow
// activo (cap + escalonado + prioridad por actividad, ver follow-pool.ts). Cada runtime maneja
// su store aislado, su answer loop y sus sweeps (ver user-runtime.ts).
//
// Correr: `pnpm ingest` (tras `pnpm add-user` / `pnpm pair`). Ctrl-C para cortar.

import "./env.ts";
import { createFollowPool } from "./follow-pool.ts";
import { getRegistry } from "./registry.ts";
import { closeAllStores } from "./store.ts";
import { createUserRuntime, type UserRuntime } from "./user-runtime.ts";
import { WacliWebhookServer } from "./wacli/wacli-webhook-server.ts";

const WACLI_BIN = process.env.WACLI_BIN ?? "wacli";
const POOL_SIZE = Number(process.env.MEMO_FOLLOW_POOL_SIZE) || 50; // máx follows concurrentes
const STAGGER_MS = Number(process.env.MEMO_FOLLOW_STAGGER_MS) || 3000; // delay entre arranques
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

async function main(): Promise<void> {
  const registry = getRegistry();
  const users = registry.listUsers({ status: "active" });
  if (users.length === 0) {
    console.warn("No hay usuarios activos en el registro. Agregá uno (pnpm add-user --phone …) y reiniciá.");
  }

  // Un webhook compartido para todos; el userId sale del path (`/wacli/<userId>`).
  const webhook = new WacliWebhookServer();
  const runtimes = new Map<string, UserRuntime>();
  webhook.onMessage((userId, raw) => {
    const rt = runtimes.get(userId);
    if (rt) rt.handleWebhook(raw);
    else console.log(dim(`[webhook] mensaje para usuario desconocido u${userId} — ignorado`));
  });
  await webhook.listen();

  // Pool de follows: decide QUÉ usuarios tienen `wacli sync --follow` (cap + escalonado).
  const pool = createFollowPool({
    runtimes,
    priorityOrder: () => registry.listUsers({ status: "active" }).map((u) => String(u.id)),
    cap: POOL_SIZE,
    staggerMs: STAGGER_MS,
    log: (m) => console.log(dim(`[pool] ${m}`)),
  });

  for (const user of users) {
    const userId = String(user.id);
    const rt = await createUserRuntime({
      userId,
      webhookUrl: webhook.urlFor(userId),
      webhookSecret: webhook.webhookSecret,
      wacliBin: WACLI_BIN,
      onActivity: () => {
        registry.touchActive(user.id);
        pool.noteActivity(userId);
      },
    });
    runtimes.set(userId, rt);
  }
  const authed = [...runtimes.values()].filter((r) => r.authenticated).length;
  console.log(`✅ ${runtimes.size} usuario(s) · ${authed} pareado(s) · pool cap=${POOL_SIZE} (webhook loopback listo)`);
  pool.reconcile(); // prende follows escalonados hasta el cap

  // Reconcile periódico: llena huecos (follows nuevos / usuarios recién activos). No evicta.
  const reconcileTimer = setInterval(() => pool.reconcile(), 60_000);
  reconcileTimer.unref();

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(reconcileTimer);
    console.log(`\n${dim("cerrando…")}`);
    pool.stopAll();
    for (const rt of runtimes.values()) rt.close();
    closeAllStores();
    void webhook.close();
    setTimeout(() => process.exit(0), 800).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main();
