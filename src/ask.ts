// "Preguntale a Memo": recupera contexto reciente de la DB + coincidencias por palabra clave
// y le pide a gemma local una respuesta. Primer corte del cerebro (RAG-lite, sin embeddings
// todavía). Testeable sin WhatsApp:
//
//   pnpm ask "¿qué tengo pendiente de responder?"
//   pnpm ask "¿de qué se habló en los grupos esta semana?"

import "./env.ts";
import Database from "better-sqlite3";
import { join } from "node:path";
import { chat, type ChatMessage } from "./llm.ts";
import { openStore } from "./store.ts";
import { stripDeviceSuffix } from "./wacli/wacli-webhook-types.ts";

const STORE = process.env.WACLI_STORE ?? "./data/wacli";
const DB = process.env.MEMO_DB ?? "./data/memo.db";

const MAX_CHATS = 16; // chats activos recientes a incluir
const PER_CHAT = 12; // últimos N mensajes por chat
const CONTEXT_CHAR_CAP = 14000; // tope de caracteres del contexto

interface MsgRow {
  chat_jid: string;
  chat_kind: string;
  sender_jid: string;
  push_name: string | null;
  from_me: number;
  ts: string;
  text: string | null;
  media_type: string | null;
}

// Map chat_jid (stripped) → nombre legible, desde wacli.db (el webhook no trae nombre de chat).
function chatNames(): Map<string, string> {
  const map = new Map<string, string>();
  try {
    const src = new Database(join(STORE, "wacli.db"), { readonly: true });
    const rows = src
      .prepare("SELECT chat_jid, chat_name FROM messages WHERE chat_name IS NOT NULL AND chat_name != '' GROUP BY chat_jid")
      .all() as Array<{ chat_jid: string; chat_name: string }>;
    for (const r of rows) map.set(stripDeviceSuffix(r.chat_jid), r.chat_name);
    src.close();
  } catch {
    /* sin nombres → usamos el jid */
  }
  return map;
}

function fmtMsg(m: MsgRow): string {
  const who = m.from_me ? "vos" : m.push_name || m.sender_jid;
  const when = m.ts ? m.ts.slice(0, 16).replace("T", " ") : "";
  const body = (m.text || (m.media_type ? `[${m.media_type}]` : "")).replace(/\s+/g, " ").trim();
  return `  [${when}] ${who}: ${body}`;
}

function buildContext(db: Database.Database, names: Map<string, string>): string {
  // Chats más recientemente activos.
  const chats = db
    .prepare("SELECT chat_jid, chat_kind, max(ts) AS last FROM messages GROUP BY chat_jid ORDER BY last DESC LIMIT ?")
    .all(MAX_CHATS) as Array<{ chat_jid: string; chat_kind: string; last: string }>;

  const lastN = db.prepare(
    "SELECT chat_jid, chat_kind, sender_jid, push_name, from_me, ts, text, media_type FROM messages WHERE chat_jid = ? ORDER BY ts DESC LIMIT ?",
  );

  const blocks: string[] = [];
  for (const c of chats) {
    const rows = (lastN.all(c.chat_jid, PER_CHAT) as MsgRow[]).reverse(); // cronológico
    if (rows.length === 0) continue;
    const label = names.get(c.chat_jid) ?? c.chat_jid;
    const kind = c.chat_kind === "group" ? "grupo" : c.chat_kind === "self" ? "self" : "dm";
    blocks.push(`### ${label} [${kind}]\n${rows.map(fmtMsg).join("\n")}`);
  }
  let ctx = blocks.join("\n\n");
  if (ctx.length > CONTEXT_CHAR_CAP) ctx = `${ctx.slice(0, CONTEXT_CHAR_CAP)}\n…(recortado)`;
  return ctx;
}

const SYSTEM = `Sos Memo, un asistente que vive dentro del WhatsApp de la persona. Te paso un
extracto de sus conversaciones recientes (por chat, en orden cronológico; "vos" = mensajes
que mandó la persona). Respondé su pregunta en español rioplatense, concreto y accionable.
Si pregunta qué tiene pendiente o a quién responder, buscá conversaciones donde alguien le
escribió a la persona y parece esperar respuesta (el último mensaje no es "vos"). Citá el chat
por su nombre. Basate SOLO en el contexto; si algo no está, decilo en vez de inventar.`;

async function main(): Promise<void> {
  const question = process.argv.slice(2).join(" ").trim() || "Hacé un resumen de lo que está pasando y qué tengo pendiente de responder.";
  const store = openStore(DB);
  const names = chatNames();
  const context = buildContext(store.db, names);

  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM },
    { role: "user", content: `Conversaciones recientes:\n\n${context}\n\n---\nPregunta: ${question}` },
  ];

  console.error(`\x1b[2m(contexto: ${context.length} chars · consultando gemma…)\x1b[0m`);
  const answer = await chat(messages, { maxTokens: 900 });
  console.log(`\n${answer}\n`);
}

void main();
