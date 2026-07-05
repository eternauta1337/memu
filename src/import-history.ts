// Importa el histórico de WhatsApp desde el store de whatsmeow (`wacli.db`) a la DB de Memo.
//
// El backfill que baja `wacli sync` NO pasa por el webhook (solo mensajes vivos), así que el
// histórico (~años de chats) queda en `wacli.db`. Esto lo lee read-only y lo vuelca a la tabla
// `messages` de Memo, para que el cerebro arranque con contexto y no solo con lo nuevo.
//
// OJO identidad: en `wacli.db` los JIDs son de TELÉFONO (`@s.whatsapp.net`), no `@lid` como el
// webhook en vivo. El self-chat acá se detecta por el JID de teléfono propio (auth status).
// La unificación LID↔teléfono es una tarea aparte de Fase 1.
//
//   pnpm import-history

import "./env.ts";
import Database from "better-sqlite3";
import { join } from "node:path";
import { ingestArchived } from "./archived.ts";
import type { ChatKind, MemoMessage } from "./ingest.ts";
import { getStore } from "./store.ts";
import { DEFAULT_USER_ID, wacliStoreDir } from "./users.ts";
import { WacliClient } from "./wacli/wacli-client.ts";
import { isGroupJid, stripDeviceSuffix } from "./wacli/wacli-webhook-types.ts";

const WACLI_BIN = process.env.WACLI_BIN ?? "wacli";
const STORE = wacliStoreDir(DEFAULT_USER_ID);
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

// Fila cruda de la tabla `messages` de whatsmeow (solo las columnas que usamos).
interface WacliDbRow {
  msg_id: string;
  chat_jid: string;
  sender_jid: string | null;
  sender_name: string | null;
  ts: number | null;
  from_me: number;
  text: string | null;
  media_type: string | null;
  mime_type: string | null;
  filename: string | null;
  reaction_emoji: string | null;
  quoted_msg_id: string | null;
  revoked: number | null;
}

function kindFor(chatJid: string, ownPhone: string | null): ChatKind {
  if (isGroupJid(chatJid)) return "group";
  if (ownPhone && chatJid === ownPhone) return "self";
  return "dm";
}

function rowToMemo(row: WacliDbRow, ownPhone: string | null): MemoMessage {
  const chatJid = stripDeviceSuffix(row.chat_jid);
  const mediaType = row.media_type ? row.media_type.toLowerCase() : undefined;
  const isAudio = mediaType === "audio" || mediaType === "ptt";
  return {
    id: row.msg_id,
    chatJid,
    chatKind: kindFor(chatJid, ownPhone),
    senderJid: stripDeviceSuffix(row.sender_jid || row.chat_jid),
    pushName: row.sender_name ?? "",
    fromMe: Boolean(row.from_me),
    ts: row.ts ? new Date(row.ts * 1000).toISOString() : "",
    text: isAudio ? "" : row.text ?? "",
    mediaType,
    mediaMime: row.mime_type || undefined,
    mediaName: row.filename || undefined,
    reactionEmoji: row.reaction_emoji || undefined,
    replyToId: row.quoted_msg_id || undefined,
    revoked: Boolean(row.revoked),
  };
}

async function main(): Promise<void> {
  // JID de teléfono propio, para detectar el self-chat en el histórico.
  const client = new WacliClient({ bin: WACLI_BIN, store: STORE });
  const status = await client.authStatus().catch(() => null);
  const ownPhone = status ? stripDeviceSuffix(status.linked_jid ?? status.jid ?? "") || null : null;
  console.log(`self-chat = ${ownPhone ?? "(desconocido; se importa sin marcar self)"}`);

  const wacliDbPath = join(STORE, "wacli.db");
  const src = new Database(wacliDbPath, { readonly: true });
  // Chats archivados: no se importan (salvo MEMO_INGEST_ARCHIVED=1).
  const archivedFilter = ingestArchived ? "" : "AND chat_jid NOT IN (SELECT jid FROM chats WHERE archived = 1)";
  const rows = src.prepare(`
    SELECT msg_id, chat_jid, sender_jid, sender_name, ts, from_me, text,
           media_type, mime_type, filename, reaction_emoji, quoted_msg_id, revoked
    FROM messages
    WHERE chat_jid NOT LIKE '%@broadcast' ${archivedFilter}
    ORDER BY ts ASC
  `).all() as WacliDbRow[];
  console.log(`${rows.length} mensajes en wacli.db${ingestArchived ? "" : " (excluyendo archivados)"}`);

  const store = getStore(DEFAULT_USER_ID);
  const before = store.count();
  let inserted = 0;
  const importAll = store.db.transaction((batch: WacliDbRow[]) => {
    for (const row of batch) {
      if (store.save(rowToMemo(row, ownPhone))) inserted++;
    }
  });
  importAll(rows);

  console.log(`\n✅ importados ${inserted} nuevos (${rows.length - inserted} ya estaban)`);
  console.log(dim(`total en Memo: ${before} → ${store.count()}`));
  const byKind = store.db
    .prepare("SELECT chat_kind, count(*) AS n FROM messages GROUP BY chat_kind ORDER BY n DESC")
    .all() as Array<{ chat_kind: string; n: number }>;
  for (const k of byKind) console.log(dim(`  ${k.chat_kind}: ${k.n}`));
  src.close();
}

void main();
