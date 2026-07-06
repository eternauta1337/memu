// Orquestador multi-tenant. Levanta el webhook (ruteo `/wacli/<userId>`), crea un runtime por
// cada usuario activo del registro (registry.ts), y un pool controla qué usuarios tienen follow
// activo (cap + escalonado + prioridad por actividad, ver follow-pool.ts). Cada runtime maneja
// su store aislado, su answer loop y sus sweeps (ver user-runtime.ts).
//
// Correr: `pnpm ingest` (tras `pnpm add-user` / `pnpm pair`). Ctrl-C para cortar.

import "./env.ts";
import { createCentralBot, type CentralBot } from "./central-bot.ts";
import { createFollowPool } from "./follow-pool.ts";
import { importHistoryForUser } from "./import-history.ts";
import { getRegistry } from "./registry.ts";
import { closeAllStores, getStore } from "./store.ts";
import { createUserRuntime, type UserRuntime } from "./user-runtime.ts";
import { WacliWebhookServer } from "./wacli/wacli-webhook-server.ts";

const WACLI_BIN = process.env.WACLI_BIN ?? "wacli";
const POOL_SIZE = Number(process.env.MEMU_FOLLOW_POOL_SIZE) || 50; // máx follows concurrentes
const STAGGER_MS = Number(process.env.MEMU_FOLLOW_STAGGER_MS) || 3000; // delay entre arranques
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
  let centralBot: CentralBot | null = null;
  webhook.onMessage((userId, raw) => {
    if (userId === "central") {
      centralBot?.handleWebhook(raw); // DM al número central → ruteo por remitente
      return;
    }
    const rt = runtimes.get(userId);
    if (rt) rt.handleWebhook(raw);
    else console.log(dim(`[webhook] mensaje para usuario desconocido u${userId} — ignorado`));
  });
  await webhook.listen();

  // Bot central: la conexión ÚNICA (número dedicado) por donde la gente conversa con Memu —
  // recibe DMs, identifica al usuario por su teléfono y corre su agente (ver central-bot.ts).
  centralBot = await createCentralBot({
    webhookUrl: webhook.urlFor("central"),
    webhookSecret: webhook.webhookSecret,
    wacliBin: WACLI_BIN,
  });
  centralBot.startFollow();

  // Pool de follows: decide QUÉ usuarios tienen `wacli sync --follow` (cap + escalonado).
  const pool = createFollowPool({
    runtimes,
    priorityOrder: () => registry.listUsers({ status: "active" }).map((u) => String(u.id)),
    cap: POOL_SIZE,
    staggerMs: STAGGER_MS,
    log: (m) => console.log(dim(`[pool] ${m}`)),
  });

  // Auto-import del histórico (wacli.db → memu.db) la primera vez. RETRIABLE: si el memu.db sigue
  // vacío (el backfill del pairing todavía no pobló wacli.db), se reintenta en el próximo tick —
  // así no se pierde por un race entre el hot-add y el backfill. Al importar algo, deja de correr.
  const importing = new Set<string>();
  const maybeImport = (userId: string): void => {
    if (importing.has(userId) || getStore(userId).count() > 0) return;
    importing.add(userId);
    void (async () => {
      try {
        const { inserted } = await importHistoryForUser(userId);
        if (inserted) console.log(dim(`[sync] u${userId} histórico importado: +${inserted}`));
      } catch (e) {
        console.log(dim(`[sync] import u${userId} falló: ${(e as Error)?.message ?? e}`));
      } finally {
        importing.delete(userId);
      }
    })();
  };

  // Levanta el runtime de cada usuario activo que todavía no tenga uno (HOT-ADD): así los que se
  // registran/vinculan por la web entran SIN reiniciar, y les importa su histórico.
  const syncUsers = async (): Promise<void> => {
    let added = 0;
    for (const user of registry.listUsers({ status: "active" })) {
      const userId = String(user.id);
      if (!runtimes.has(userId)) {
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
        added++;
        console.log(dim(`[sync] hot-add u${userId}`));
      }
      maybeImport(userId); // reintenta hasta que haya histórico para importar
    }
    if (added) pool.reconcile();
  };

  await syncUsers();
  const authed = [...runtimes.values()].filter((r) => r.authenticated).length;
  console.log(`✅ ${runtimes.size} usuario(s) · ${authed} pareado(s) · pool cap=${POOL_SIZE} (webhook loopback listo)`);
  pool.reconcile();

  // Sync periódico: hot-add de usuarios nuevos (registrados por la web) sin reiniciar.
  const syncTimer = setInterval(() => void syncUsers(), 30_000);
  syncTimer.unref();
  // Reconcile periódico: llena huecos de follows. No evicta.
  const reconcileTimer = setInterval(() => pool.reconcile(), 60_000);
  reconcileTimer.unref();

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(reconcileTimer);
    clearInterval(syncTimer);
    console.log(`\n${dim("cerrando…")}`);
    centralBot?.close();
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
