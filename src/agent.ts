// El "cerebro" de Memo: dada una pregunta, recupera contexto de la DB y le pide a gemma local
// una respuesta. RAG-lite (chats recientes + coincidencias; sin embeddings todavía). Reusado
// por el CLI (`ask.ts`) y por el loop del self-chat (`index.ts`).

import Database from "better-sqlite3";
import { join } from "node:path";
import { chat, type ChatMessage } from "./llm.ts";
import type { MemoStore } from "./store.ts";
import { stripDeviceSuffix } from "./wacli/wacli-webhook-types.ts";

const STORE = process.env.WACLI_STORE ?? "./data/wacli";

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
export function chatNames(): Map<string, string> {
  const map = new Map<string, string>();
  try {
    const src = new Database(join(STORE, "wacli.db"), { readonly: true });
    const rows = src
      .prepare(
        "SELECT chat_jid, chat_name FROM messages WHERE chat_name IS NOT NULL AND chat_name != '' GROUP BY chat_jid",
      )
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

export function buildContext(db: Database.Database, names: Map<string, string>): string {
  const chats = db
    .prepare(
      "SELECT chat_jid, chat_kind, max(ts) AS last FROM messages GROUP BY chat_jid ORDER BY last DESC LIMIT ?",
    )
    .all(MAX_CHATS) as Array<{ chat_jid: string; chat_kind: string; last: string }>;

  const lastN = db.prepare(
    "SELECT chat_jid, chat_kind, sender_jid, push_name, from_me, ts, text, media_type FROM messages WHERE chat_jid = ? ORDER BY ts DESC LIMIT ?",
  );

  const blocks: string[] = [];
  for (const c of chats) {
    // El self-chat es la conversación con Memo: no es "contexto", se excluye.
    if (c.chat_kind === "self") continue;
    const rows = (lastN.all(c.chat_jid, PER_CHAT) as MsgRow[]).reverse(); // cronológico
    if (rows.length === 0) continue;
    const label = names.get(c.chat_jid) ?? c.chat_jid;
    const kind = c.chat_kind === "group" ? "grupo" : "dm";
    blocks.push(`### ${label} [${kind}]\n${rows.map(fmtMsg).join("\n")}`);
  }
  let ctx = blocks.join("\n\n");
  if (ctx.length > CONTEXT_CHAR_CAP) ctx = `${ctx.slice(0, CONTEXT_CHAR_CAP)}\n…(recortado)`;
  return ctx;
}

const SYSTEM = `Sos Memo, un asistente que vive dentro del WhatsApp de la persona. Te paso un
extracto de sus conversaciones recientes (por chat, en orden cronológico; "vos" = mensajes
que mandó la persona). Respondé en español rioplatense, concreto y accionable, sin vueltas.
Si pregunta qué tiene pendiente o a quién responder, buscá conversaciones donde alguien le
escribió a la persona y parece esperar respuesta (el último mensaje no es "vos"). Citá el chat
por su nombre. Basate SOLO en el contexto; si algo no está, decilo en vez de inventar.`;

/** Responde una pregunta de la persona usando el contexto reciente de su WhatsApp. */
export async function askMemo(store: MemoStore, question: string): Promise<string> {
  const context = buildContext(store.db, chatNames());
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM },
    {
      role: "user",
      content: `Conversaciones recientes:\n\n${context}\n\n---\nMensaje de la persona: ${question}`,
    },
  ];
  return chat(messages, { maxTokens: 900 });
}
