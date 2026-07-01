// CLI "preguntale a Memo": corre el cerebro (agent.ts) desde la terminal. Testeable sin WhatsApp.
//
//   pnpm ask "¿qué tengo pendiente de responder?"
//   pnpm ask "¿de qué se habló en los grupos esta semana?"

import "./env.ts";
import { askMemo } from "./agent.ts";
import { openStore } from "./store.ts";

const DB = process.env.MEMO_DB ?? "./data/memo.db";

async function main(): Promise<void> {
  const question =
    process.argv.slice(2).join(" ").trim() ||
    "Hacé un resumen de lo que está pasando y qué tengo pendiente de responder.";
  const store = openStore(DB);
  console.error("\x1b[2m(consultando gemma…)\x1b[0m");
  const answer = await askMemo(store, question);
  console.log(`\n${answer}\n`);
}

void main();
