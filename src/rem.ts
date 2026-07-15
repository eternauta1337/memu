// REM: la fase de "sueño" de Memu. Una vez por día (de madrugada, ver central-bot.ts) repasa lo
// NUEVO de los chats de la persona desde la corrida anterior buscando compromisos que ella asumió
// ("dale, te transfiero", "mañana te lo paso") y se los propone como tareas. Nunca crea tareas
// solo: siempre pregunta (task_suggestions → sí/no vía aceptar_sugerencia/rechazar_sugerencia).
//
// El pipeline por corrida: cursor (rowid) → solo DMs nuevos → descarte barato (chats donde la
// persona no escribió no pueden tener compromisos suyos) → juez LLM por chat con contexto →
// sugerencias nuevas (dedup por fingerprint, para siempre). Silencioso si no encuentra nada.
//
// Forzar una corrida a mano ("siesta"): pnpm rem [--send]

import "./env.ts";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { chat, type ChatMessage } from "./llm.ts";
import { getStore, type MemuStore, type TaskSuggestion } from "./store.ts";
import { fmtDue, normalizeDue } from "./tasks.ts";

const MAX_CHATS = Number(process.env.MEMU_REM_MAX_CHATS) || 15; // tope de jueces (LLM) por corrida
const CTX_MSGS = 50; // últimos N mensajes del chat como contexto del juez
const CTX_CHAR_CAP = 6000;
const EXPIRE_HOURS = 48; // una sugerencia sin respuesta expira sola (ignorarla es un "no" suave)

export interface RemResult {
  /** Las sugerencias NUEVAS de esta corrida (las ya propuestas/rechazadas no reaparecen). */
  suggestions: TaskSuggestion[];
  scanned: number; // mensajes nuevos mirados
  judged: number; // chats que pasaron por el juez
  baseline: boolean; // primera corrida: solo fija la línea de base, no analiza
  expired: number;
}

interface FreshRow {
  rowid: number;
  chat_jid: string;
  from_me: number;
  text: string | null;
}

interface CtxRow {
  from_me: number;
  push_name: string | null;
  ts: string | null;
  text: string | null;
}

interface Candidate {
  tarea: string;
  fecha_limite?: string | null;
  cita?: string | null;
  confianza?: string;
}

const JUDGE_SYSTEM = `Sos el módulo REM de Memu: de madrugada repasás los chats de la persona buscando
COMPROMISOS que ella asumió y que le convendría tener anotados como tareas.

Te paso la conversación reciente de UN chat de WhatsApp ("vos" = la persona; el otro es su contacto).

Un compromiso cuenta SOLO si se cumplen TODAS estas condiciones:
1. La persona ("vos") lo asumió EXPLÍCITAMENTE en el chat: dijo que va a hacer algo ("dale, te
   transfiero", "mañana te lo mando") o confirmó un pedido que le hicieron.
2. Es concreto y accionable (pagar, mandar, llamar, llevar, averiguar…).
3. Sigue pendiente al final de la conversación (si ya dijo que lo hizo, no va).

NO cuenta: pedidos que la persona no confirmó, planes vagos ("algún día", "vemos"), cosas que va a
hacer el OTRO, cortesías ("hablamos", "nos vemos").

Ante la duda, NO lo incluyas: un falso positivo molesta más que un compromiso que falta.

Respondé SOLO este JSON, sin nada más:
{"compromisos": [{"tarea": "qué tiene que hacer, breve y accionable", "fecha_limite": "YYYY-MM-DD o null si no se dijo", "cita": "frase textual de la persona que muestra el compromiso", "confianza": "alta|media|baja"}]}

Si no hay compromisos: {"compromisos": []}`;

function parseJudge(out: string): Candidate[] {
  const m = /\{[\s\S]*\}/.exec(out);
  if (!m) return [];
  try {
    const j = JSON.parse(m[0]) as { compromisos?: unknown };
    return Array.isArray(j.compromisos) ? (j.compromisos as Candidate[]) : [];
  } catch {
    return [];
  }
}

/** Juez de UN chat: devuelve solo los compromisos de confianza alta. `already` = lo que la
 *  persona ya tiene cubierto y el juez no debe repetir, ni reformulado: sugerencias anteriores de
 *  este chat (el fingerprint solo ataja la MISMA redacción) + tareas ya anotadas (vivas o cerradas
 *  hace poco — cubre el cruce con crear_tarea y con cosas ya hechas). Exportado para testear. */
export async function judgeChat(transcript: string, already: string[] = []): Promise<Candidate[]> {
  // Ancla temporal: sin esto el modelo no sabe a qué año/día resolver un "mañana te transfiero".
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const today = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  const dejaVu = already.length
    ? `La persona YA tiene estas tareas anotadas (o ya se las sugerimos antes). NO las incluyas de nuevo, ni reformuladas, aunque aparezcan en la conversación:\n${already.map((t) => `- ${t}`).join("\n")}\n\n`
    : "";
  const messages: ChatMessage[] = [
    { role: "system", content: JUDGE_SYSTEM },
    { role: "user", content: `HOY es ${today}.\n\n${dejaVu}Conversación:\n\n${transcript}\n\n---\nJSON:` },
  ];
  const out = await chat(messages, { maxTokens: 500, temperature: 0 });
  return parseJudge(out).filter(
    (c) => typeof c.tarea === "string" && c.tarea.trim() && c.confianza === "alta",
  );
}

/** Huella estable del compromiso: chat + tarea normalizada (minúsculas, sin tildes ni signos). */
export function suggestionFingerprint(chatJid: string, tarea: string): string {
  const norm = tarea
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return createHash("sha1").update(`${chatJid}|${norm}`).digest("hex");
}

function fmtMsg(m: CtxRow): string {
  const when = m.ts ? `${m.ts.slice(8, 10)}/${m.ts.slice(5, 7)} ${m.ts.slice(11, 16)}` : "";
  const who = m.from_me ? "vos" : m.push_name || "contacto";
  return `[${when}] ${who}: ${(m.text ?? "").replace(/\s+/g, " ").trim()}`;
}

/** Una corrida REM sobre el store de un usuario. El cursor avanza solo si la corrida terminó
 *  (si el LLM está caído no se pierde nada: se reintenta con la misma ventana). */
export async function runRem(
  store: MemuStore,
  names: Map<string, string>,
  opts?: { excludeJids?: Set<string> },
): Promise<RemResult> {
  const db = store.db;
  const expired = store.expireTaskSuggestions(EXPIRE_HOURS);

  const maxRow = (db.prepare("SELECT COALESCE(MAX(rowid), 0) AS m FROM messages").get() as { m: number }).m;
  const cursorRaw = store.getState("rem_cursor");
  if (cursorRaw == null) {
    // Primera corrida: solo fija la línea de base. Analizar TODO el histórico sería carísimo y
    // sugeriría compromisos viejísimos; se empieza a mirar de acá en adelante.
    store.setState("rem_cursor", String(maxRow));
    return { suggestions: [], scanned: 0, judged: 0, baseline: true, expired };
  }
  const cursor = Number(cursorRaw);

  const fresh = db
    .prepare(
      "SELECT rowid, chat_jid, from_me, text FROM messages WHERE rowid > ? AND rowid <= ? AND chat_kind = 'dm' AND revoked = 0",
    )
    .all(cursor, maxRow) as FreshRow[];

  // Descarte barato: solo chats donde la persona escribió algo nuevo — sin mensaje suyo no puede
  // haber compromiso suyo (checks 1 y 2). Esto filtra casi todo sin tocar el LLM.
  const byChat = new Map<string, { total: number; mine: number }>();
  for (const r of fresh) {
    if (opts?.excludeJids?.has(r.chat_jid)) continue;
    const c = byChat.get(r.chat_jid) ?? { total: 0, mine: 0 };
    c.total++;
    if (r.from_me && r.text?.trim()) c.mine++;
    byChat.set(r.chat_jid, c);
  }
  const candidates = [...byChat.entries()]
    .filter(([, c]) => c.mine > 0)
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, MAX_CHATS)
    .map(([jid]) => jid);

  // Contexto del juez: los últimos mensajes del chat INCLUYENDO previos al cursor — un compromiso
  // puede cruzar el corte (el CBU llegó antes de la corrida anterior, el "dale" después).
  const selCtx = db.prepare(
    "SELECT from_me, push_name, ts, text FROM messages WHERE chat_jid = ? AND revoked = 0 AND text IS NOT NULL AND trim(text) != '' ORDER BY rowid DESC LIMIT ?",
  );
  // Lo ya sugerido de este chat (cualquier status): el juez no lo debe repetir.
  const selPrior = db.prepare(
    "SELECT text FROM task_suggestions WHERE chat_jid = ? ORDER BY id DESC LIMIT 20",
  );
  // Tareas que la persona ya tiene anotadas (vivas, o cerradas en la última semana): tampoco se
  // re-sugieren — cubre el cruce con las tareas explícitas y con compromisos ya cumplidos.
  const knownTasks = (
    db
      .prepare(
        "SELECT text FROM tasks WHERE status IN ('pending', 'active', 'in_progress') OR closed_at >= datetime('now', '-7 days') ORDER BY id DESC LIMIT 100",
      )
      .all() as Array<{ text: string }>
  ).map((r) => r.text);

  const suggestions: TaskSuggestion[] = [];
  let judged = 0;
  let failed = 0;
  for (const jid of candidates) {
    const rows = (selCtx.all(jid, CTX_MSGS) as CtxRow[]).reverse();
    let transcript = rows.map(fmtMsg).join("\n");
    if (transcript.length > CTX_CHAR_CAP) transcript = `…\n${transcript.slice(-CTX_CHAR_CAP)}`;
    const already = [...knownTasks, ...(selPrior.all(jid) as Array<{ text: string }>).map((r) => r.text)];
    try {
      for (const c of await judgeChat(transcript, already)) {
        const id = store.addTaskSuggestion({
          text: c.tarea.trim(),
          reason: (c.cita ?? "").trim() || null,
          chatJid: jid,
          dueAt: normalizeDue(c.fecha_limite ?? null),
          fingerprint: suggestionFingerprint(jid, c.tarea),
        });
        if (id != null) {
          const s = store.getTaskSuggestion(id);
          if (s) suggestions.push(s);
        }
      }
      judged++;
    } catch (e) {
      failed++;
      console.error(`[rem] juez falló en ${names.get(jid) ?? jid}: ${(e as Error).message}`);
    }
  }

  // Si TODOS los jueces fallaron (¿LLM caído?), no avanzamos el cursor: la ventana se reintenta.
  if (candidates.length > 0 && judged === 0) {
    throw new Error(`fallaron los ${failed} chats candidatos (¿LLM caído?)`);
  }
  store.setState("rem_cursor", String(maxRow));
  return { suggestions, scanned: fresh.length, judged, baseline: false, expired };
}

/** El mensaje con la tanda de sugerencias, listo para mandarle a la persona. */
export function remMessage(sugs: TaskSuggestion[], names: Map<string, string>): string {
  const lines = sugs.map((s) => {
    const who = (s.chatJid && names.get(s.chatJid)) || "";
    const due = s.dueAt ? ` — ${fmtDue(s.dueAt)}` : "";
    const cite = s.reason
      ? `\n   ↳ ${who ? `a ${who} ` : ""}le dijiste: "${s.reason}"`
      : who
        ? `\n   ↳ del chat con ${who}`
        : "";
    return `• #${s.id}: ${s.text}${due}${cite}`;
  });
  const n = sugs.length;
  return `🌙 *REM* — anoche repasé tus chats y encontré ${n === 1 ? "una posible tarea" : `${n} posibles tareas`}:\n\n${lines.join("\n")}\n\n¿Las anoto? Decime cuáles sí y cuáles no.`;
}

// CLI: fuerza una corrida ("siesta") para el usuario default y muestra qué encontró.
// `--send` NO existe acá a propósito: el envío es del bot central; esto es para inspeccionar.
async function main(): Promise<void> {
  const { DEFAULT_USER_ID } = await import("./users.ts");
  const { chatNames } = await import("./retrieval.ts");
  const store = getStore(DEFAULT_USER_ID);
  const names = chatNames(DEFAULT_USER_ID);

  // Igual que en producción (central-bot): el chat de la persona CON Memu no se analiza — lo que
  // le pide a Memu lo maneja el agente en el momento; re-sugerirlo sería ruido.
  const excludeJids = new Set<string>();
  try {
    const { WacliClient } = await import("./wacli/wacli-client.ts");
    const st = await new WacliClient({
      bin: process.env.WACLI_BIN ?? "wacli",
      store: process.env.CENTRAL_WACLI_STORE ?? "./data/central/wacli",
    }).authStatus();
    for (const j of [st.linked_jid, st.jid]) {
      if (j) excludeJids.add(`${j.split(":")[0]!.split("@")[0]!}@s.whatsapp.net`);
    }
    if (st.phone) excludeJids.add(`${st.phone}@s.whatsapp.net`);
  } catch {
    /* sin bot central pareado (dev) no hay nada que excluir */
  }

  const res = await runRem(store, names, { excludeJids });
  if (res.baseline) {
    console.log("Primera corrida: línea de base fijada (la próxima analiza lo nuevo desde ahora).");
    return;
  }
  console.log(`${res.scanned} mensajes nuevos · ${res.judged} chats analizados · ${res.expired} sugerencias expiradas`);
  if (res.suggestions.length === 0) {
    console.log("Sin compromisos nuevos — silencio. 🌙");
    return;
  }
  console.log(`\n${remMessage(res.suggestions, names)}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) void main();
