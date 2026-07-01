// El "cerebro" de Memo: dada una pregunta, recupera contexto de la DB y le pide a gemma local
// una respuesta. Retrieval híbrido (sin embeddings todavía):
//   1) chats más recientes (para "¿qué está pasando?"),
//   2) chats cuyo NOMBRE matchea la pregunta (para "info de <persona/grupo>"),
//   3) mensajes cuyo TEXTO matchea palabras clave de la pregunta (para temas puntuales).
// Reusado por el CLI (`ask.ts`) y por el loop del self-chat (`index.ts`).

import Database from "better-sqlite3";
import { join } from "node:path";
import { chat, type ChatMessage } from "./llm.ts";
import type { MemoStore } from "./store.ts";
import { stripDeviceSuffix } from "./wacli/wacli-webhook-types.ts";

const STORE = process.env.WACLI_STORE ?? "./data/wacli";

const RECENT_CHATS = 10; // chats recientes por default (contexto "qué pasa")
const PER_CHAT = 12; // últimos N mensajes por chat
const MAX_CHATS = 22; // tope total de chats en el contexto
const TEXT_HITS = 60; // tope de mensajes matcheados por palabra clave
const CONTEXT_CHAR_CAP = 16000; // tope de caracteres del contexto

// Palabras muy comunes que no sirven para buscar.
const STOP = new Set(
  "que de la el los las un una y o a en con por para del al se me te lo le mi tu su es son esta este esto eso esa hay sobre como cual quien cuando donde info dame decime contame deme quiero necesito hace paso pasa pasó tengo tiene todo todos algo alguien mas más muy ya no si sí sos soy vos yo nos ver dar decir mandar mando pendiente pendientes responder respuesta chat chats grupo grupos mensaje mensajes gente"
    .split(" "),
);

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

const norm = (s: string): string =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");

function keywords(q: string): string[] {
  const seen = new Set<string>();
  for (const raw of norm(q).split(/[^a-z0-9]+/)) {
    if (raw.length >= 3 && !STOP.has(raw)) seen.add(raw);
  }
  return [...seen].slice(0, 8);
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

export function buildContext(db: Database.Database, names: Map<string, string>, question: string): string {
  const kws = keywords(question);
  const kindOf = new Map<string, string>();
  const targets: string[] = []; // orden: matches por pregunta primero, luego recientes
  const add = (jid: string, kind: string) => {
    if (kind === "self" || kindOf.has(jid)) return;
    kindOf.set(jid, kind);
    targets.push(jid);
  };

  // 2) chats cuyo NOMBRE matchea alguna palabra clave de la pregunta.
  if (kws.length) {
    for (const [jid, name] of names) {
      const n = norm(name);
      if (kws.some((k) => n.includes(k))) {
        const kind = jid.endsWith("@g.us") ? "group" : "dm";
        add(jid, kind);
      }
    }
    // 3) mensajes cuyo TEXTO matchea → sumamos sus chats.
    const like = db.prepare(
      "SELECT chat_jid, chat_kind FROM messages WHERE text LIKE ? AND chat_kind != 'self' ORDER BY ts DESC LIMIT ?",
    );
    for (const k of kws) {
      for (const r of like.all(`%${k}%`, TEXT_HITS) as Array<{ chat_jid: string; chat_kind: string }>) {
        add(r.chat_jid, r.chat_kind);
      }
    }
  }

  // 1) chats más recientes (contexto general), al final.
  const recent = db
    .prepare(
      "SELECT chat_jid, chat_kind, max(ts) AS last FROM messages WHERE chat_kind != 'self' GROUP BY chat_jid ORDER BY last DESC LIMIT ?",
    )
    .all(RECENT_CHATS) as Array<{ chat_jid: string; chat_kind: string }>;
  for (const c of recent) add(c.chat_jid, c.chat_kind);

  const lastN = db.prepare(
    "SELECT chat_jid, chat_kind, sender_jid, push_name, from_me, ts, text, media_type FROM messages WHERE chat_jid = ? ORDER BY ts DESC LIMIT ?",
  );
  const blocks: string[] = [];
  for (const jid of targets.slice(0, MAX_CHATS)) {
    const rows = (lastN.all(jid, PER_CHAT) as MsgRow[]).reverse(); // cronológico
    if (rows.length === 0) continue;
    const label = names.get(jid) ?? jid;
    const kind = kindOf.get(jid) === "group" ? "grupo" : "dm";
    blocks.push(`### ${label} [${kind}]\n${rows.map(fmtMsg).join("\n")}`);
  }
  let ctx = blocks.join("\n\n");
  if (ctx.length > CONTEXT_CHAR_CAP) ctx = `${ctx.slice(0, CONTEXT_CHAR_CAP)}\n…(recortado)`;
  return ctx;
}

const SYSTEM = `Sos Memo, un asistente que vive dentro del WhatsApp de la persona. Te paso un
extracto de sus conversaciones (por chat, en orden cronológico; "vos" = mensajes que mandó la
persona). Respondé en español rioplatense, concreto y accionable, sin vueltas. Si pregunta qué
tiene pendiente o a quién responder, buscá conversaciones donde alguien le escribió y parece
esperar respuesta (el último mensaje no es "vos"). Citá el chat por su nombre. Basate SOLO en el
contexto; si algo no aparece, decí que no lo ves en las conversaciones recientes en vez de inventar.`;

/** Responde una pregunta de la persona usando contexto recuperado de su WhatsApp. */
export async function askMemo(store: MemoStore, question: string): Promise<string> {
  const context = buildContext(store.db, chatNames(), question);
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM },
    {
      role: "user",
      content: `Conversaciones (recuperadas para tu pregunta):\n\n${context}\n\n---\nMensaje de la persona: ${question}`,
    },
  ];
  return chat(messages, { maxTokens: 900 });
}
