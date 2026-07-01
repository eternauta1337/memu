// Store SQLite central de Memo (patrón tomado de @proyecto-interno/store: better-sqlite3, WAL, SQL a
// mano, sin ORM). Fase 0: solo la tabla `messages` (ingesta cruda). Multi-tenant vendrá con
// una columna `user_id` cuando lleguemos a la Fase 3.

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { MemoMessage } from "./ingest.ts";

export interface MemoStore {
  db: Database.Database;
  /** Inserta un mensaje. Devuelve true si era nuevo (false si ya estaba: dedup por id). */
  save(m: MemoMessage): boolean;
  /** Total de mensajes guardados. */
  count(): number;
}

export function openStore(dbPath: string): MemoStore {
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
  `);

  const insert = db.prepare(`
    INSERT OR IGNORE INTO messages
      (id, chat_jid, chat_kind, sender_jid, push_name, from_me, ts, text,
       media_type, media_mime, media_name, reaction_emoji, reply_to_id, revoked)
    VALUES
      (@id, @chatJid, @chatKind, @senderJid, @pushName, @fromMe, @ts, @text,
       @mediaType, @mediaMime, @mediaName, @reactionEmoji, @replyToId, @revoked)
  `);

  return {
    db,
    save(m: MemoMessage): boolean {
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
