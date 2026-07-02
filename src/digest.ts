// Digest de fin de día: resume lo que pasó hoy en el WhatsApp de la persona + sus pendientes,
// y (con --send) lo postea en el self-chat. Pensado para correr por cron/systemd-timer a la
// noche, pero también sirve on-demand.
//
//   pnpm digest            # genera e imprime (testeable sin WhatsApp)
//   pnpm digest --send     # además lo postea en tu self-chat

import "./env.ts";
import { chatNames } from "./agent.ts";
import { chat, type ChatMessage } from "./llm.ts";
import { type MemoStore, openStore } from "./store.ts";
import { WacliClient } from "./wacli/wacli-client.ts";

const STORE = process.env.WACLI_STORE ?? "./data/wacli";
const DB = process.env.MEMO_DB ?? "./data/memo.db";
const WACLI_BIN = process.env.WACLI_BIN ?? "wacli";

const SCAN = 800; // últimos N mensajes a mirar para armar el día
const CONTEXT_CHAR_CAP = 16000;

interface Row {
  chat_jid: string;
  chat_kind: string;
  sender_jid: string;
  push_name: string | null;
  from_me: number;
  ts: string;
  text: string | null;
  media_type: string | null;
}

/** Inicio del día local (medianoche) en ms. */
function startOfToday(): number {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function fmt(m: Row): string {
  const who = m.from_me ? "vos" : m.push_name || m.sender_jid;
  const when = m.ts ? m.ts.slice(11, 16) : ""; // HH:MM
  const body = (m.text || (m.media_type ? `[${m.media_type}]` : "")).replace(/\s+/g, " ").trim();
  return `  [${when}] ${who}: ${body}`;
}

function buildTodayContext(db: import("better-sqlite3").Database, names: Map<string, string>): { ctx: string; n: number } {
  const since = startOfToday();
  const recent = db
    .prepare(
      "SELECT chat_jid, chat_kind, sender_jid, push_name, from_me, ts, text, media_type FROM messages WHERE chat_kind != 'self' ORDER BY ts DESC LIMIT ?",
    )
    .all(SCAN) as Row[];
  const today = recent.filter((r) => {
    const t = Date.parse(r.ts);
    return Number.isFinite(t) && t >= since;
  });

  // Agrupar por chat, cronológico.
  const byChat = new Map<string, Row[]>();
  for (const r of today) {
    const arr = byChat.get(r.chat_jid) ?? [];
    arr.push(r);
    byChat.set(r.chat_jid, arr);
  }
  const blocks: string[] = [];
  for (const [jid, rows] of byChat) {
    rows.reverse();
    const label = names.get(jid) ?? jid;
    const kind = rows[0].chat_kind === "group" ? "grupo" : "dm";
    blocks.push(`### ${label} [${kind}]\n${rows.map(fmt).join("\n")}`);
  }
  let ctx = blocks.join("\n\n");
  if (ctx.length > CONTEXT_CHAR_CAP) ctx = `${ctx.slice(0, CONTEXT_CHAR_CAP)}\n…(recortado)`;
  return { ctx, n: today.length };
}

const SYSTEM = `Sos Memo, el asistente de WhatsApp de la persona. Te paso los mensajes de HOY de
sus chats ("vos" = lo que mandó la persona). Escribí un resumen breve del día en español
rioplatense, para leer de un vistazo:
- 2 a 5 bullets con lo importante que pasó (por tema/chat, citando el chat por nombre).
- Al final, una sección "*Pendientes*" con lo que le escribieron y parece esperar respuesta
  (el último mensaje de ese chat no es "vos"). Si no hay, decí "Nada urgente".
Sé conciso y concreto. No inventes: si algo no está en los mensajes, no lo pongas.`;

async function generateBody(store: MemoStore): Promise<string> {
  const { ctx, n } = buildTodayContext(store.db, chatNames());
  if (n === 0) return "Hoy estuvo tranquilo — no registré mensajes nuevos en tus chats.";
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM },
    { role: "user", content: `Mensajes de hoy:\n\n${ctx}\n\n---\nEscribí el resumen del día.` },
  ];
  return (await chat(messages, { maxTokens: 900 })).trim();
}

/** Digest completo, ya formateado y listo para postear en el self-chat. Reusado por el
 *  scheduler de reminders (`action='digest'`). */
export async function generateDigest(store: MemoStore): Promise<string> {
  return `🤖 📋 *Resumen del día*\n\n${await generateBody(store)}`;
}

async function main(): Promise<void> {
  const send = process.argv.includes("--send");
  const store = openStore(DB);
  const out = await generateDigest(store);

  if (!send) {
    console.log(`\n${out}\n`);
    return;
  }
  const client = new WacliClient({ bin: WACLI_BIN, store: STORE });
  const status = await client.authStatus();
  const own = status.linked_jid ?? status.jid;
  if (!own) {
    console.error("No hay JID linkeado. ¿Pareaste? (pnpm pair)");
    process.exit(1);
  }
  const r = await client.sendText(own, out);
  console.log(`Digest enviado al self-chat (${own}): id=${r.id ?? "?"}`);
}

void main();
