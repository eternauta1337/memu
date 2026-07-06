// Recuperación de contexto del WhatsApp de la persona. Antes vivía en agent.ts; lo separo para
// que lo usen las herramientas del agente (tools.ts) y el digest sin ciclos de import.
//
//   - chatNames(): jid → nombre legible (desde wacli.db; el webhook no trae nombre de chat).
//   - searchMessages(): híbrido — semántico (embeddings + sqlite-vec) + keyword (LIKE) + chats
//     cuyo NOMBRE matchea. Devuelve fragmentos formateados con nombre de chat.
//   - recentChats() / readChat() / pendingChats(): vistas puntuales para las tools.

import Database from "better-sqlite3";
import { join } from "node:path";
import { embed, toVecBlob } from "./embeddings.ts";
import type { MemuStore } from "./store.ts";
import { wacliStoreDir } from "./users.ts";
import { stripDeviceSuffix } from "./wacli/wacli-webhook-types.ts";

const PER_CHAT = 14; // mensajes por chat al leer un chat puntual
const TEXT_HITS = 40; // tope de mensajes por keyword

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

export const norm = (s: string): string =>
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

// Map chat_jid (stripped) → nombre legible, desde wacli.db. Combina dos fuentes: la tabla
// `contacts` (nombre de agenda, base) y `messages.chat_name` (título que ve el usuario, incluye
// grupos) que pisa a la anterior. Los JIDs están en formato teléfono, que es a lo que
// canonicalizamos en la ingesta (ver lidmap.ts).
export function chatNames(userId: string): Map<string, string> {
  const map = new Map<string, string>();
  try {
    const src = new Database(join(wacliStoreDir(userId), "wacli.db"), { readonly: true });
    // 1) nombres de contacto (agenda): mejor nombre disponible por JID.
    const contacts = src
      .prepare(
        `SELECT jid, COALESCE(NULLIF(full_name,''), NULLIF(push_name,''), NULLIF(business_name,''),
                NULLIF(first_name,'')) AS name
         FROM contacts WHERE COALESCE(full_name, push_name, business_name, first_name, '') != ''`,
      )
      .all() as Array<{ jid: string; name: string }>;
    for (const r of contacts) map.set(stripDeviceSuffix(r.jid), r.name);
    // 2) título del chat desde messages.chat_name (lo que el usuario ve) → pisa al de agenda.
    //    OJO: wacli guarda el JID como fallback en chat_name cuando no tiene el título, y hay
    //    valores basura (ej. un nombre de sender que se coló). Por eso: (a) descartamos filas
    //    donde chat_name == chat_jid, y (b) elegimos el título MÁS FRECUENTE por chat (no uno
    //    arbitrario del GROUP BY), que es el título real y estable.
    const chats = src
      .prepare(
        `SELECT chat_jid, chat_name FROM messages
         WHERE chat_name IS NOT NULL AND chat_name != '' AND chat_name != chat_jid
         GROUP BY chat_jid, chat_name
         ORDER BY count(*) ASC`,
      )
      .all() as Array<{ chat_jid: string; chat_name: string }>;
    // ORDER BY count ASC + set() secuencial ⇒ el más frecuente (último) queda en el mapa.
    for (const r of chats) map.set(stripDeviceSuffix(r.chat_jid), r.chat_name);
    // 3) título autoritativo de GRUPOS desde la tabla `groups` de wacli → pisa a todo lo anterior.
    //    Es la fuente correcta y con cobertura casi total; sin esto ~88% de los grupos activos
    //    resolvían a su propio JID (no se encontraban por nombre).
    const groups = src
      .prepare("SELECT jid, name FROM groups WHERE name IS NOT NULL AND name != '' AND name != jid")
      .all() as Array<{ jid: string; name: string }>;
    for (const r of groups) map.set(stripDeviceSuffix(r.jid), r.name);
    src.close();
  } catch {
    /* sin nombres → usamos el jid */
  }
  return map;
}

function fmtMsg(m: MsgRow, names: Map<string, string>, withChat: boolean): string {
  const who = m.from_me ? "vos" : m.push_name || m.sender_jid;
  const when = m.ts ? m.ts.slice(0, 16).replace("T", " ") : "";
  const body = (m.text || (m.media_type ? `[${m.media_type}]` : "")).replace(/\s+/g, " ").trim();
  const chat = withChat ? `[${names.get(stripDeviceSuffix(m.chat_jid)) ?? m.chat_jid}] ` : "";
  return `  ${chat}[${when}] ${who}: ${body}`;
}

const SELECT_MSG =
  "SELECT chat_jid, chat_kind, sender_jid, push_name, from_me, ts, text, media_type FROM messages";

/** Búsqueda semántica: embebe la query, trae los mensajes más parecidos por sqlite-vec. */
async function semanticHits(store: MemuStore, query: string, k: number): Promise<MsgRow[]> {
  if (!store.vecEnabled) return [];
  try {
    const [qv] = await embed([query], "query");
    if (!qv) return [];
    return store.db
      .prepare(`
        SELECT m.chat_jid, m.chat_kind, m.sender_jid, m.push_name, m.from_me, m.ts, m.text, m.media_type
        FROM vec_messages v JOIN messages m ON m.rowid = v.rowid
        WHERE v.embedding MATCH ? AND k = ? ORDER BY v.distance
      `)
      .all(toVecBlob(qv), k) as MsgRow[];
  } catch (e) {
    console.error(`[semantic] ${(e as Error).message}`);
    return [];
  }
}

/** Búsqueda híbrida sobre todo el WhatsApp: semántica + keyword + nombre de chat. Devuelve
 *  fragmentos formateados (con nombre de chat), listos para meter en el contexto del LLM. */
export async function searchMessages(store: MemuStore, query: string, names: Map<string, string>): Promise<string> {
  const seen = new Set<string>();
  const out: MsgRow[] = [];
  const push = (r: MsgRow) => {
    if (r.chat_kind === "self" || !(r.text ?? "").trim()) return;
    const key = `${r.chat_jid}|${r.ts}|${r.sender_jid}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(r);
  };

  for (const r of await semanticHits(store, query, 24)) push(r);

  const kws = keywords(query);
  if (kws.length) {
    const like = store.db.prepare(
      `${SELECT_MSG} WHERE text LIKE ? AND chat_kind != 'self' ORDER BY ts DESC LIMIT ?`,
    );
    for (const k of kws) for (const r of like.all(`%${k}%`, TEXT_HITS) as MsgRow[]) push(r);

    // Chats cuyo NOMBRE matchea (ej: "familia", "laburo") → traigo sus últimos mensajes.
    const lastN = store.db.prepare(`${SELECT_MSG} WHERE chat_jid = ? ORDER BY ts DESC LIMIT ?`);
    for (const [jid, name] of names) {
      if (kws.some((k) => norm(name).includes(k))) {
        for (const r of lastN.all(jid, PER_CHAT) as MsgRow[]) push(r);
      }
    }
  }

  if (out.length === 0) return "No encontré mensajes relacionados.";
  out.sort((a, b) => (a.ts < b.ts ? -1 : 1)); // cronológico
  // Nos quedamos con los MÁS RECIENTES (slice(-N)), no los más viejos: si hay muchos matches,
  // lo de hoy no debe quedar afuera. (Bug previo: slice(0,N) descartaba lo nuevo.)
  return out
    .slice(-60)
    .map((m) => fmtMsg(m, names, true))
    .join("\n");
}

/** Chats con actividad reciente (para "¿qué está pasando?"). */
export function recentChats(store: MemuStore, names: Map<string, string>, limit: number): string {
  const rows = store.db
    .prepare(
      "SELECT chat_jid, chat_kind, max(ts) AS last, count(*) AS n FROM messages WHERE chat_kind != 'self' GROUP BY chat_jid ORDER BY last DESC LIMIT ?",
    )
    .all(limit) as Array<{ chat_jid: string; chat_kind: string; last: string; n: number }>;
  if (rows.length === 0) return "No hay chats registrados.";
  return rows
    .map((r) => {
      const label = names.get(stripDeviceSuffix(r.chat_jid)) ?? r.chat_jid;
      const kind = r.chat_kind === "group" ? "grupo" : "dm";
      return `- ${label} [${kind}] — último: ${r.last?.slice(0, 16).replace("T", " ")}`;
    })
    .join("\n");
}

/** Últimos mensajes de un chat cuyo nombre matchea `name` (fuzzy). */
export function readChat(store: MemuStore, names: Map<string, string>, name: string, limit: number): string {
  const target = norm(name);
  let jid: string | null = null;
  for (const [j, n] of names) {
    if (norm(n).includes(target) || target.includes(norm(n))) {
      jid = j;
      break;
    }
  }
  if (!jid) return `No encontré ningún chat que se llame "${name}".`;
  const rows = (
    store.db.prepare(`${SELECT_MSG} WHERE chat_jid = ? ORDER BY ts DESC LIMIT ?`).all(jid, limit) as MsgRow[]
  ).reverse();
  const label = names.get(jid) ?? jid;
  if (rows.length === 0) return `No hay mensajes en "${label}".`;
  return `### ${label}\n${rows.map((m) => fmtMsg(m, names, false)).join("\n")}`;
}

/** Chats donde el último mensaje NO es tuyo (parece esperar respuesta). */
export function pendingChats(store: MemuStore, names: Map<string, string>, limit: number): string {
  const rows = store.db
    .prepare(
      `SELECT chat_jid, chat_kind, sender_jid, push_name, from_me, ts, text, media_type FROM messages
       WHERE chat_kind != 'self' AND id IN (
         SELECT id FROM messages m2 WHERE m2.chat_jid = messages.chat_jid ORDER BY ts DESC LIMIT 1
       )`,
    )
    .all() as MsgRow[];
  const waiting = rows
    .filter((r) => !r.from_me && (r.text ?? "").trim())
    .sort((a, b) => (a.ts > b.ts ? -1 : 1))
    .slice(0, limit);
  if (waiting.length === 0) return "No hay chats esperando respuesta.";
  return waiting.map((m) => fmtMsg(m, names, true)).join("\n");
}
