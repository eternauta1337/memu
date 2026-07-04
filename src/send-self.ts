// Smoke test del egress al self-chat ("Mensajes contigo mismo"): postea un texto a tu
// propio número. Valida que Memo puede escribir en el chat donde va a vivir.
//
//   pnpm send-self                 # mensaje default
//   pnpm send-self hola desde memo # mensaje custom

import "./env.ts";
import { DEFAULT_USER_ID, wacliStoreDir } from "./users.ts";
import { WacliClient } from "./wacli/wacli-client.ts";

const client = new WacliClient({
  bin: process.env.WACLI_BIN ?? "wacli",
  store: wacliStoreDir(DEFAULT_USER_ID),
});

const msg = process.argv.slice(2).join(" ") || "🧠 Hola, soy Memo. Prueba de self-chat.";

const status = await client.authStatus();
const own = status.linked_jid ?? status.jid;
if (!own) {
  console.error("No hay JID linkeado. ¿Pareaste? Corré `pnpm pair`.");
  process.exit(1);
}

const r = await client.sendText(own, msg);
console.log(`Enviado al self-chat (${own}): id=${r.id ?? "?"}`);
