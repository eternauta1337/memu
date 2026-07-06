// CLI "preguntale a Memu": corre el cerebro (agent.ts) desde la terminal. Testeable sin WhatsApp.
//
//   pnpm ask "¿qué tengo pendiente de responder?"
//   pnpm ask "¿de qué se habló en los grupos esta semana?"

import "./env.ts";
import { askMemu } from "./agent.ts";
import { getStore } from "./store.ts";
import { DEFAULT_USER_ID } from "./users.ts";

async function main(): Promise<void> {
  const question =
    process.argv.slice(2).join(" ").trim() ||
    "Hacé un resumen de lo que está pasando y qué tengo pendiente de responder.";
  const store = getStore(DEFAULT_USER_ID);
  console.error("\x1b[2m(consultando gemma…)\x1b[0m");
  const answer = await askMemu(store, question);
  console.log(`\n${answer}\n`);
}

void main();
