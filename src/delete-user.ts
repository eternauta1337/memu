// Borrado TOTAL de los datos de un usuario — la implementación de la promesa de la privacy
// policy §6 ("podés borrar tus datos cuando quieras" / baja al cancelar). Los pedidos los
// registra la tool `solicitar_borrado_datos` del agente o el sweep de cancelaciones (index.ts);
// el admin los ejecuta con esto.
//
//   pnpm delete-user --phone 598…     (o --id N)   → dry-run: muestra qué se borraría
//   pnpm delete-user --phone 598… --yes            → borra en serio
//
// Qué hace: (1) baja al usuario en el registro (status 'disabled' + phone NULL — el orquestador
// retira su runtime solo, sin reiniciar), (2) desloguea el companion device de su WhatsApp
// (wacli auth logout), (3) borra data/users/<id>/ ENTERO (memu.db: mensajes/índice/facts/tareas +
// wacli/: fuente/media/credenciales), y (4) cierra los pedidos de borrado del teléfono.
//
// Qué QUEDA (retención legal/contable, dicho en la policy): los ids de Stripe en la fila del
// registro (la facturación vive en Stripe) y los eventos de consentimiento (terms_events).
// Flags: --no-wait (no esperar al orquestador; usar solo con memu-ingest parado),
//        --force-admin (permite borrar al user 1, el dueño).

import "./env.ts";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { promisify } from "node:util";
import { normalizePhone } from "./phone.ts";
import { getRegistry } from "./registry.ts";
import { userDir, wacliStoreDir } from "./users.ts";

const execFileAsync = promisify(execFile);
const WACLI_BIN = process.env.WACLI_BIN ?? "wacli";
const ORCHESTRATOR_WAIT_MS = 45_000; // el hot-remove de index.ts corre cada 30s

const args = process.argv.slice(2);
const flag = (name: string): boolean => args.includes(`--${name}`);
const opt = (name: string): string | null => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1]!.startsWith("--") ? args[i + 1]! : null;
};

async function main(): Promise<void> {
  const registry = getRegistry();

  const idArg = opt("id");
  const phoneArg = opt("phone");
  const user = idArg
    ? registry.getUser(Number(idArg))
    : phoneArg
      ? registry.getUserByPhone(normalizePhone(phoneArg) ?? phoneArg.replace(/\D/g, ""))
      : null;
  if (!user) {
    console.error("Uso: pnpm delete-user --phone 598… (o --id N) [--yes] [--no-wait] [--force-admin]");
    if (idArg || phoneArg) console.error("No encontré ese usuario en el registro.");
    process.exit(1);
  }
  if (user.id === 1 && !flag("force-admin")) {
    console.error("⚠️ user 1 es el DUEÑO (canal de alertas). Si es en serio: --force-admin.");
    process.exit(1);
  }

  const uid = String(user.id);
  const dir = userDir(uid);
  const phone = user.phone; // capturar ANTES de anonimizar
  let du = "?";
  try {
    ({ stdout: du } = await execFileAsync("du", ["-sh", dir]));
    du = du.split("\t")[0] ?? "?";
  } catch {
    /* sin dir → nada que medir */
  }

  console.log(`Usuario u${user.id} · +${phone ?? "?"} · status=${user.status} · sub=${user.subscriptionStatus ?? "-"}`);
  console.log(`Datos: ${dir} (${du.trim()})${existsSync(dir) ? "" : " — NO EXISTE"}`);
  console.log("Queda (retención contable/legal): ids de Stripe en el registro + consentimiento (terms_events).");

  if (!flag("yes")) {
    console.log("\nDRY-RUN: no borré nada. Para ejecutar en serio, repetí con --yes.");
    return;
  }

  // 1) Baja en el registro: el orquestador (si corre) retira su runtime en el próximo sync (≤30s)
  // y suelta el follow. phone NULL = fuera del ruteo del bot central y anonimizado.
  registry.setStatus(user.id, "disabled");
  registry.clearPhone(user.id);
  console.log("✔ registro: status=disabled, phone=NULL");

  if (!flag("no-wait")) {
    console.log(`… espero ${ORCHESTRATOR_WAIT_MS / 1000}s a que el orquestador suelte el runtime/follow`);
    await new Promise((r) => setTimeout(r, ORCHESTRATOR_WAIT_MS));
  }

  // 2) Deslinkear el companion device del WhatsApp del usuario (best-effort: si ya estaba
  // deslinkeado o el store no existe, seguimos igual).
  try {
    await execFileAsync(WACLI_BIN, ["--json", "--store", wacliStoreDir(uid), "auth", "logout"], { timeout: 30_000 });
    console.log("✔ wacli auth logout (companion desvinculado de su WhatsApp)");
  } catch (e) {
    console.warn(`⚠ wacli logout falló (sigo igual): ${(e as Error)?.message ?? e}`);
  }

  // 3) El wipe: TODO el directorio del usuario (aislación física → un solo rm).
  await rm(dir, { recursive: true, force: true });
  console.log(`✔ borrado ${dir}`);

  // 4) Cerrar los pedidos de borrado del teléfono.
  if (phone) registry.resolveDeletionRequests(phone);
  console.log(`✅ u${user.id} borrado. Nota: el journal del sistema puede retener logs con snippets hasta rotar (journalctl --vacuum-time=30d si urge).`);
}

void main();
