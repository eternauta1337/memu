// Orquestador multi-tenant. Levanta el webhook (ruteo `/wacli/<userId>`), crea un runtime por
// cada usuario activo del registro (registry.ts) y prende su follow. Cada runtime maneja su
// store aislado, su answer loop y sus sweeps (ver user-runtime.ts). En el paso 4c un pool va a
// controlar QUÉ usuarios tienen follow activo (priorizado por actividad); por ahora, todos los
// activos tienen follow persistente.
//
// Correr: `pnpm ingest` (tras `pnpm pair` / `pnpm add-user`). Ctrl-C para cortar.

import "./env.ts";
import { getRegistry } from "./registry.ts";
import { closeAllStores } from "./store.ts";
import { createUserRuntime, type UserRuntime } from "./user-runtime.ts";
import { WacliWebhookServer } from "./wacli/wacli-webhook-server.ts";

const WACLI_BIN = process.env.WACLI_BIN ?? "wacli";
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

async function main(): Promise<void> {
  const registry = getRegistry();
  const users = registry.listUsers({ status: "active" });
  if (users.length === 0) {
    console.warn("No hay usuarios activos en el registro. Agregá uno (pnpm add-user) y reiniciá.");
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

  for (const user of users) {
    const userId = String(user.id);
    const rt = await createUserRuntime({
      userId,
      webhookUrl: webhook.urlFor(userId),
      webhookSecret: webhook.webhookSecret,
      wacliBin: WACLI_BIN,
    });
    runtimes.set(userId, rt);
    rt.startFollow();
  }
  const withFollow = [...runtimes.values()].filter((r) => r.authenticated).length;
  console.log(`✅ ${runtimes.size} usuario(s) · ${withFollow} con follow activo (webhook loopback listo)`);

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${dim("cerrando…")}`);
    for (const rt of runtimes.values()) rt.close();
    closeAllStores();
    void webhook.close();
    setTimeout(() => process.exit(0), 800).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main();
