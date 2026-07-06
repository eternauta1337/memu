// Store SQLite central de Memu (patrón tomado de @proyecto-interno/store: better-sqlite3, WAL, SQL a
// mano, sin ORM). Fase 0: solo la tabla `messages` (ingesta cruda). Multi-tenant vendrá con
// una columna `user_id` cuando lleguemos a la Fase 3.

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import * as sqliteVec from "sqlite-vec";
import type { MemuMessage } from "./ingest.ts";
import { memuDbPath } from "./users.ts";

const VEC_DIM = 768; // gte-multilingual-base (ver embeddings.ts EMBED_DIM). Mantener en sync.

/** Recurrencia de un reminder: null = una sola vez. "daily", "weekdays" (lun-vie), o
 *  "weekly:N" con N = día de la semana 0..6 (0 = domingo). */
export type Recurrence = string | null;

export interface Reminder {
  id: number;
  text: string;
  action: "message" | "digest";
  fireAt: number; // epoch ms de la próxima ejecución
  recurrence: Recurrence;
  status: "pending" | "done" | "cancelled";
  createdAt: string;
  lastFiredAt: string | null;
}

export interface NewReminder {
  text: string;
  action: "message" | "digest";
  fireAt: number;
  recurrence?: Recurrence;
}

export interface MemuStore {
  db: Database.Database;
  /** userId dueño de este store (para resolver rutas per-usuario, ej. el wacli store). */
  userId: string;
  /** true si sqlite-vec cargó y la tabla `vec_messages` existe (búsqueda semántica disponible). */
  vecEnabled: boolean;
  /** Inserta un mensaje. Devuelve true si era nuevo (false si ya estaba: dedup por id). */
  save(m: MemuMessage): boolean;
  /** Total de mensajes guardados. */
  count(): number;
  /** Crea un reminder. Devuelve el id asignado. */
  addReminder(r: NewReminder): number;
  /** Reminders pendientes ya vencidos (fireAt <= nowMs), del más viejo al más nuevo. */
  dueReminders(nowMs: number): Reminder[];
  /** Reminders pendientes (para listar/cancelar), del más próximo al más lejano. */
  pendingReminders(): Reminder[];
  /** Marca un reminder como disparado: lo re-agenda a nextFireMs, o lo cierra si es null. */
  markFired(id: number, nextFireMs: number | null): void;
  /** Cancela un reminder pendiente. Devuelve true si había uno pendiente con ese id. */
  cancelReminder(id: number): boolean;

  /** Agrega un turno al diálogo del self-chat. Devuelve el id del turno. */
  appendTurn(role: "user" | "assistant", content: string): number;
  /** Turnos con id > afterId, en orden cronológico. */
  turnsAfter(afterId: number): Turn[];

  /** Agrega un hecho a la memoria del usuario. Devuelve su id. */
  addFact(text: string): number;
  /** Todos los hechos que la persona le enseñó a Memu, del más viejo al más nuevo. */
  listFacts(): Fact[];
  /** Borra un hecho. Devuelve true si existía. */
  deleteFact(id: number): boolean;

  /** Lee un valor del estado de sesión (o null). */
  getState(key: string): string | null;
  /** Guarda un valor en el estado de sesión (upsert). */
  setState(key: string, value: string): void;
}

export interface Turn {
  id: number;
  role: "user" | "assistant";
  content: string;
  ts: string;
}

export interface Fact {
  id: number;
  text: string;
  createdAt: string;
}

export function openStore(dbPath: string, userId = ""): MemuStore {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000"); // el ingest y el importador pueden escribir a la vez
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id             TEXT PRIMARY KEY,
      chat_jid       TEXT NOT NULL,
      chat_kind      TEXT NOT NULL,
      sender_jid     TEXT NOT NULL,
      push_name      TEXT,
      from_me        INTEGER NOT NULL,
      ts             TEXT,
      text           TEXT,
      media_type     TEXT,
      media_mime     TEXT,
      media_name     TEXT,
      reaction_emoji TEXT,
      reply_to_id    TEXT,
      revoked        INTEGER NOT NULL,
      ingested_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_jid, ts);

    CREATE TABLE IF NOT EXISTS reminders (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      text          TEXT NOT NULL,
      action        TEXT NOT NULL DEFAULT 'message',  -- 'message' | 'digest'
      fire_at       INTEGER NOT NULL,                 -- epoch ms de la próxima ejecución
      recurrence    TEXT,                             -- null | 'daily' | 'weekdays' | 'weekly:N'
      status        TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'done' | 'cancelled'
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      last_fired_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(status, fire_at);

    -- Diálogo del self-chat con Memu (persistimos ambos lados: los envíos de Memu NO vuelven
    -- por el webhook, así que hay que guardarlos acá para tener memoria conversacional).
    CREATE TABLE IF NOT EXISTS conversation (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      role    TEXT NOT NULL,   -- 'user' | 'assistant'
      content TEXT NOT NULL,
      ts      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Hechos que la persona le enseña a Memu ("mi mamá es Marta", "el grupo X es mi familia").
    CREATE TABLE IF NOT EXISTS user_memory (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      text       TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Estado de la sesión (resumen compactado, cutoff de turnos, etc.) como key/value.
    CREATE TABLE IF NOT EXISTS session_state (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // sqlite-vec: tabla virtual de vectores, linkeada a messages por rowid. Best-effort: si la
  // extensión no carga, el resto del store sigue funcionando (retrieval cae a keyword).
  let vecEnabled = false;
  try {
    sqliteVec.load(db);
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_messages USING vec0(embedding float[${VEC_DIM}])`);
    vecEnabled = true;
  } catch (e) {
    console.error(`sqlite-vec no disponible (búsqueda semántica off): ${(e as Error).message}`);
  }

  const insert = db.prepare(`
    INSERT OR IGNORE INTO messages
      (id, chat_jid, chat_kind, sender_jid, push_name, from_me, ts, text,
       media_type, media_mime, media_name, reaction_emoji, reply_to_id, revoked)
    VALUES
      (@id, @chatJid, @chatKind, @senderJid, @pushName, @fromMe, @ts, @text,
       @mediaType, @mediaMime, @mediaName, @reactionEmoji, @replyToId, @revoked)
  `);

  const insertReminder = db.prepare(
    "INSERT INTO reminders (text, action, fire_at, recurrence) VALUES (@text, @action, @fireAt, @recurrence)",
  );
  const selDue = db.prepare(
    "SELECT * FROM reminders WHERE status = 'pending' AND fire_at <= ? ORDER BY fire_at ASC",
  );
  const selPending = db.prepare("SELECT * FROM reminders WHERE status = 'pending' ORDER BY fire_at ASC");
  const updFired = db.prepare(
    "UPDATE reminders SET fire_at = @fireAt, status = @status, last_fired_at = datetime('now') WHERE id = @id",
  );
  const updCancel = db.prepare("UPDATE reminders SET status = 'cancelled' WHERE id = ? AND status = 'pending'");

  const insTurn = db.prepare("INSERT INTO conversation (role, content) VALUES (?, ?)");
  const selTurns = db.prepare("SELECT id, role, content, ts FROM conversation WHERE id > ? ORDER BY id ASC");
  const insFact = db.prepare("INSERT INTO user_memory (text) VALUES (?)");
  const selFacts = db.prepare("SELECT id, text, created_at FROM user_memory ORDER BY id ASC");
  const delFact = db.prepare("DELETE FROM user_memory WHERE id = ?");
  const getSt = db.prepare("SELECT value FROM session_state WHERE key = ?");
  const setSt = db.prepare(
    "INSERT INTO session_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );

  const rowToReminder = (r: Record<string, unknown>): Reminder => ({
    id: r.id as number,
    text: r.text as string,
    action: r.action as "message" | "digest",
    fireAt: r.fire_at as number,
    recurrence: (r.recurrence as string | null) ?? null,
    status: r.status as "pending" | "done" | "cancelled",
    createdAt: r.created_at as string,
    lastFiredAt: (r.last_fired_at as string | null) ?? null,
  });

  return {
    db,
    userId,
    vecEnabled,
    addReminder(r: NewReminder): number {
      const res = insertReminder.run({
        text: r.text,
        action: r.action,
        fireAt: Math.floor(r.fireAt),
        recurrence: r.recurrence ?? null,
      });
      return Number(res.lastInsertRowid);
    },
    dueReminders(nowMs: number): Reminder[] {
      return (selDue.all(Math.floor(nowMs)) as Array<Record<string, unknown>>).map(rowToReminder);
    },
    pendingReminders(): Reminder[] {
      return (selPending.all() as Array<Record<string, unknown>>).map(rowToReminder);
    },
    markFired(id: number, nextFireMs: number | null): void {
      updFired.run({
        id,
        fireAt: nextFireMs != null ? Math.floor(nextFireMs) : 0,
        status: nextFireMs != null ? "pending" : "done",
      });
    },
    cancelReminder(id: number): boolean {
      return updCancel.run(id).changes > 0;
    },
    appendTurn(role: "user" | "assistant", content: string): number {
      return Number(insTurn.run(role, content).lastInsertRowid);
    },
    turnsAfter(afterId: number): Turn[] {
      return selTurns.all(afterId) as Turn[];
    },
    addFact(text: string): number {
      return Number(insFact.run(text).lastInsertRowid);
    },
    listFacts(): Fact[] {
      return (selFacts.all() as Array<{ id: number; text: string; created_at: string }>).map((r) => ({
        id: r.id,
        text: r.text,
        createdAt: r.created_at,
      }));
    },
    deleteFact(id: number): boolean {
      return delFact.run(id).changes > 0;
    },
    getState(key: string): string | null {
      const r = getSt.get(key) as { value: string } | undefined;
      return r?.value ?? null;
    },
    setState(key: string, value: string): void {
      setSt.run(key, value);
    },
    save(m: MemuMessage): boolean {
      // better-sqlite3 no acepta undefined/boolean como binding → null / 0|1.
      const r = insert.run({
        id: m.id,
        chatJid: m.chatJid,
        chatKind: m.chatKind,
        senderJid: m.senderJid,
        pushName: m.pushName || null,
        fromMe: m.fromMe ? 1 : 0,
        ts: m.ts || null,
        text: m.text || null,
        mediaType: m.mediaType ?? null,
        mediaMime: m.mediaMime ?? null,
        mediaName: m.mediaName ?? null,
        reactionEmoji: m.reactionEmoji ?? null,
        replyToId: m.replyToId ?? null,
        revoked: m.revoked ? 1 : 0,
      });
      return r.changes > 0;
    },
    count(): number {
      return (db.prepare("SELECT count(*) AS n FROM messages").get() as { n: number }).n;
    },
  };
}

// Registro de stores abiertos, uno por usuario. `getStore` abre el memu.db del usuario la
// primera vez y lo cachea (una conexión por usuario, reusada entre mensajes). Es el punto de
// entrada multi-tenant: cada usuario ve SOLO su DB (aislación física, ver users.ts).
const stores = new Map<string, MemuStore>();

/** Store del usuario `userId`, abriéndolo (y cacheándolo) la primera vez. */
export function getStore(userId: string): MemuStore {
  let s = stores.get(userId);
  if (!s) {
    s = openStore(memuDbPath(userId), userId);
    stores.set(userId, s);
  }
  return s;
}

/** Cierra todos los stores abiertos (para el shutdown). */
export function closeAllStores(): void {
  for (const [id, s] of stores) {
    try {
      s.db.close();
    } catch {
      /* ya cerrado */
    }
    stores.delete(id);
  }
}
