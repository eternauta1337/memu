// Alta de un usuario nuevo (onboarding manual, Fase 0/1). Lo registra en el registro central y
// parea su WhatsApp por pairing-code (`wacli auth --phone`), creando su store en
// data/users/<id>/wacli. Tras parear, entra al pool en el próximo `pnpm ingest`.
//
//   pnpm add-user --phone +59899XXXXXXX
//
// El signup web + Stripe (self-service) queda para Fase 3; esto es el onboarding operativo.

import "./env.ts";
import { spawn } from "node:child_process";
import { normalizePhone } from "./phone.ts";
import { getRegistry } from "./registry.ts";
import { wacliStoreDir } from "./users.ts";

const phoneIdx = process.argv.indexOf("--phone");
const phone = phoneIdx >= 0 ? process.argv[phoneIdx + 1] : undefined;
if (!phone) {
  console.error("Uso: pnpm add-user --phone +59899XXXXXXX");
  process.exit(1);
}
const normalized = normalizePhone(phone); // E.164 canónico sin '+' (clave de dedup en el registro)
if (!normalized) {
  console.error(`Número inválido: ${phone}. Poné el código de país (ej. +59899…).`);
  process.exit(1);
}

const reg = getRegistry();
const existing = reg.getUserByPhone(normalized);
if (existing) {
  console.error(`Ya existe el usuario ${existing.id} con phone ${normalized} (status ${existing.status}).`);
  process.exit(1);
}

const user = reg.addUser(normalized);
const store = wacliStoreDir(String(user.id));
console.log(`Usuario ${user.id} creado (phone ${normalized}). Pareando WhatsApp por código…`);
console.log("Ingresá el código en WhatsApp → Dispositivos vinculados → Vincular con número.\n");

const bin = process.env.WACLI_BIN ?? "wacli";
const child = spawn(bin, ["auth", "--store", store, "--download-media", "--phone", `+${normalized}`], {
  stdio: "inherit",
  env: process.env,
});
child.on("error", (err) => {
  console.error(`No pude correr ${bin}: ${err.message}`);
  reg.setStatus(user.id, "disabled");
  process.exit(1);
});
child.on("exit", (code) => {
  if (code === 0) {
    console.log(`\n✅ Usuario ${user.id} pareado. Reiniciá \`pnpm ingest\` para que entre al pool.`);
    process.exit(0);
  }
  // Pairing falló → dejamos el usuario 'disabled' (no lo levanta el ingest) para no ensuciar el pool.
  reg.setStatus(user.id, "disabled");
  console.error(`\nPairing falló (code ${code}). Usuario ${user.id} quedó 'disabled'. Reintentá o borralo.`);
  process.exit(code ?? 1);
});
