// Orquestador multi-tenant. Levanta el webhook (ruteo `/wacli/<userId>`), crea un runtime por
// cada usuario activo del registro (registry.ts), y un pool controla qué usuarios tienen follow
// activo (cap + escalonado + prioridad por actividad, ver follow-pool.ts). Cada runtime maneja
// su store aislado, su answer loop y sus sweeps (ver user-runtime.ts).
//
// Correr: `pnpm ingest` (tras `pnpm add-user` / `pnpm pair`). Ctrl-C para cortar.

import "./env.ts";
import { statSync } from "node:fs";
import { createAlerter } from "./alerts.ts";
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

  // --- Alertas al admin (deslink/ban): central → DM al admin; fallback: companion del admin →
  // su self-chat (cubre justo la caída del central). Ver alerts.ts.
  const adminPhone = process.env.MEMU_ADMIN_PHONE || registry.getUser(1)?.phone || null;
  if (!adminPhone) console.warn("⚠️ sin MEMU_ADMIN_PHONE ni teléfono del user 1 — las alertas quedan solo en el journal");
  const adminRuntime = (): UserRuntime | null => {
    const u = adminPhone ? registry.getUserByPhone(adminPhone) : null;
    return u ? (runtimes.get(String(u.id)) ?? null) : null;
  };
  const alerter = createAlerter({
    channels: [
      async (text) => (adminPhone && centralBot ? centralBot.sendToPhone(adminPhone, `🚨 ${text}`) : false),
      async (text) => (await adminRuntime()?.sendSelf(`🚨 ${text}`)) ?? false,
    ],
  });

  // Bot central: la conexión ÚNICA (número dedicado) por donde la gente conversa con Memu —
  // recibe DMs, identifica al usuario por su teléfono y corre su agente (ver central-bot.ts).
  centralBot = await createCentralBot({
    webhookUrl: webhook.urlFor("central"),
    webhookSecret: webhook.webhookSecret,
    wacliBin: WACLI_BIN,
    onDeslink: () =>
      void alerter.alert(
        "deslink-central",
        "Memu: el NÚMERO CENTRAL quedó desvinculado/baneado — nadie puede chatear con el bot. " +
          "Recuperación: re-parear el central y reiniciar memu-ingest.",
      ),
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

  // Deslink del companion de un usuario: WhatsApp lo desvinculó (o lo desvinculó él). Su ingesta
  // murió → (1) alertar al admin, (2) bajarlo a 'pending' para que vuelva al embudo de pairing
  // (su próximo mensaje al central dispara onboard() → código nuevo), (3) tirar el runtime muerto
  // (cuando el control-plane lo re-parea y lo pone 'active', el hot-add lo recrea con auth fresco),
  // y (4) avisarle proactivamente con un código fresco (notifyRelink).
  const handleUserDeslink = (id: number): void => {
    const u = registry.getUser(id);
    const who = `u${id}${u?.phone ? ` (+${u.phone})` : ""}`;
    void alerter.alert(
      `deslink-u${id}`,
      `Memu: se desvinculó el companion de ${who} — su ingesta está parada. Le mandé instrucciones + código de re-pairing.`,
    );
    registry.setStatus(id, "pending");
    const rt = runtimes.get(String(id));
    if (rt) {
      rt.close();
      runtimes.delete(String(id));
      pool.reconcile();
    }
    if (u?.phone) void centralBot?.notifyRelink(u.phone);
  };

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
  // registran/vinculan por la web entran SIN reiniciar, y les importa su histórico. También RETIRA
  // los runtimes de usuarios que dejaron de estar en servicio (baja/borrado/pausa) sin reiniciar.
  const syncUsers = async (): Promise<void> => {
    let added = 0;
    for (const [id, rt] of [...runtimes]) {
      const u = registry.getUser(Number(id));
      if (!u || u.status === "disabled" || u.status === "paused") {
        rt.close();
        runtimes.delete(id);
        pool.reconcile();
        console.log(dim(`[sync] hot-remove u${id} (${u?.status ?? "borrado"})`));
      }
    }
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
          onDeslink: () => handleUserDeslink(user.id),
        });
        runtimes.set(userId, rt);
        added++;
        console.log(dim(`[sync] hot-add u${userId}`));
        // Usuario 'active' (o sea: ya pareado alguna vez) cuyo store apareció DESLINKEADO al
        // arrancar → deslink que pasó con el proceso caído. Mismo flujo de recuperación.
        // `authKnown` evita el falso positivo de "no pude consultar" (ej. wacli roto).
        if (rt.authKnown && !rt.authenticated && user.status === "active") {
          handleUserDeslink(user.id);
          continue;
        }
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

  // Borrado de datos (privacy policy §6): avisar al admin los pedidos nuevos (los registra la tool
  // solicitar_borrado_datos del agente) y auto-registrar el de las suscripciones CANCELADAS que
  // todavía tienen datos en disco. El wipe real es manual: `pnpm delete-user` (ver delete-user.ts).
  const deletionSweep = (): void => {
    for (const req of registry.unnotifiedDeletionRequests()) {
      void alerter.alert(
        `del-req-${req.id}`,
        `Memu: pedido de BORRADO de datos de +${req.phone} (origen: ${req.source}). Hay 48h de plazo — correr: pnpm delete-user --phone ${req.phone}.`,
      );
      registry.markDeletionNotified(req.id);
    }
    for (const u of registry.listUsers()) {
      if (u.subscriptionStatus === "canceled" && u.status === "active" && u.phone && !registry.hasOpenDeletionRequest(u.phone)) {
        registry.recordDeletionRequest(u.phone, u.id, "cancelacion");
        console.log(dim(`[deletion] u${u.id} canceló la suscripción → pedido de borrado auto-registrado`));
      }
    }
  };
  deletionSweep();
  const deletionTimer = setInterval(deletionSweep, 60_000);
  deletionTimer.unref();

  // Health-check del LLM: si gemma/vLLM se cae, el bot solo diría "uf, algo falló" sin que nadie
  // se entere (pasó en la práctica: el engine puede morir y tardar ~3 min en volver por systemd).
  // Completion real de 1 token (un GET /models no prueba el upstream: LiteLLM contesta igual con
  // vLLM muerto). 2 fallos seguidos → alerta; re-alerta solo si vuelve a caer tras recuperarse.
  const LLM_BASE = process.env.LLM_BASE_URL ?? "http://127.0.0.1:4000/v1";
  let llmFails = 0;
  let llmDown = false;
  const llmCheck = async (): Promise<void> => {
    try {
      const res = await fetch(`${LLM_BASE}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${process.env.LLM_API_KEY ?? ""}` },
        body: JSON.stringify({
          model: process.env.LLM_MODEL ?? "gemma4-31b",
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
        }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      llmFails = 0;
      if (llmDown) {
        llmDown = false;
        console.log("[llm] ✅ el LLM volvió a responder");
      }
    } catch (e) {
      llmFails++;
      console.error(`[llm] health-check falló (${llmFails} seguido/s): ${(e as Error)?.message ?? e}`);
      if (llmFails >= 2 && !llmDown) {
        llmDown = true;
        void alerter.alert(
          "llm-down",
          "Memu: el LLM (gemma/vLLM) NO responde — el bot está contestando 'algo falló'. systemd suele revivirlo solo en ~3 min; si persiste: systemctl status vllm litellm.",
        );
      }
    }
  };
  const llmTimer = setInterval(() => void llmCheck(), 300_000);
  llmTimer.unref();

  // Staleness de backups: scripts/backup-memu.sh escribe un stamp al terminar OK — el local
  // (memu-backup.timer, diario 03:30) y el offsite al host-offsite (timer horario oportunista: el host-offsite es
  // laptop y puede no estar). Local >26 h = el backup está roto. Offsite >4 días = el host-offsite no
  // aparece en el tailnet. El throttle del alerter (6 h) evita spam.
  // MEMU_BACKUP_ALERTS=0 apaga el watchdog entero (para instalaciones sin backups configurados:
  // sin stamp, la staleness es infinita y esto alertaría cada 6 h para siempre).
  const BACKUP_ALERTS = process.env.MEMU_BACKUP_ALERTS !== "0";
  const BACKUP_STAMP = process.env.MEMU_BACKUP_STAMP ?? "./data/backup-stamp";
  const stampAgeMs = (path: string): number => {
    try {
      return Date.now() - statSync(path).mtimeMs;
    } catch {
      return Number.POSITIVE_INFINITY; // sin stamp = nunca corrió
    }
  };
  const backupCheck = (): void => {
    if (stampAgeMs(BACKUP_STAMP) > 26 * 3600_000) {
      void alerter.alert(
        "backup-stale",
        "Memu: el backup diario (local) NO corrió OK en las últimas 26 h. Revisar: journalctl -u memu-backup y systemctl list-timers memu-backup.timer.",
      );
    }
    if (stampAgeMs(`${BACKUP_STAMP}-offsite`) > 4 * 24 * 3600_000) {
      void alerter.alert(
        "backup-offsite-stale",
        "Memu: hace más de 4 días que el backup offsite no llega al host-offsite — prendelo un rato en el tailnet (o revisá journalctl -u memu-backup-offsite).",
      );
    }
  };
  if (BACKUP_ALERTS) {
    const backupTimer = setInterval(backupCheck, 3600_000);
    backupTimer.unref();
  } else {
    console.log(dim("[backup] watchdog apagado (MEMU_BACKUP_ALERTS=0)"));
  }
  // Reconcile periódico: llena huecos de follows. No evicta.
  const reconcileTimer = setInterval(() => pool.reconcile(), 60_000);
  reconcileTimer.unref();

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(reconcileTimer);
    clearInterval(syncTimer);
    clearInterval(deletionTimer);
    clearInterval(llmTimer);
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
