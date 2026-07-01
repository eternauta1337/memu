// Indexa embeddings de los mensajes que todavía no tienen vector. Reusado por el CLI
// (`embed-index.ts`, índice full) y por el sweep incremental del ingest (`index.ts`).
//
// Los inserts son tolerantes al duplicado (vec0 NO respeta INSERT OR IGNORE → tira UNIQUE):
// saltamos por-fila, así el índice full (oldest→newest) y el sweep (newest→oldest) conviven.

import { embed, toVecBlob } from "./embeddings.ts";
import type { MemoStore } from "./store.ts";

const BATCH = 64;

export interface EmbedOpts {
  /** Tope de mensajes a procesar (0 = todos los pendientes). */
  limit?: number;
  /** Orden por rowid: "asc" (histórico) o "desc" (lo más nuevo primero, para el sweep). */
  order?: "asc" | "desc";
  /** Progreso: (procesados, total). */
  log?: (done: number, total: number) => void;
}

export async function embedMissing(store: MemoStore, opts?: EmbedOpts): Promise<number> {
  if (!store.vecEnabled) return 0;
  const order = opts?.order === "desc" ? "DESC" : "ASC";
  const limit = opts?.limit ? `LIMIT ${Math.floor(opts.limit)}` : "";
  const pending = store.db
    .prepare(
      `SELECT m.rowid AS rowid, m.text AS text
       FROM messages m LEFT JOIN vec_messages v ON v.rowid = m.rowid
       WHERE v.rowid IS NULL AND m.text IS NOT NULL AND length(trim(m.text)) >= 2
       ORDER BY m.rowid ${order} ${limit}`,
    )
    .all() as Array<{ rowid: number; text: string }>;
  if (pending.length === 0) return 0;

  const insert = store.db.prepare("INSERT INTO vec_messages(rowid, embedding) VALUES (?, ?)");
  const insertBatch = store.db.transaction((rows: Array<{ rowid: number }>, vecs: number[][]) => {
    rows.forEach((r, i) => {
      try {
        insert.run(BigInt(r.rowid), toVecBlob(vecs[i]));
      } catch (e) {
        // Otro proceso ya lo embebió (índice full en paralelo) → saltar.
        if (!/UNIQUE/i.test((e as Error).message)) throw e;
      }
    });
  });

  let done = 0;
  for (let i = 0; i < pending.length; i += BATCH) {
    const batch = pending.slice(i, i + BATCH);
    const vecs = await embed(
      batch.map((b) => b.text),
      "passage",
    );
    insertBatch(batch, vecs);
    done += batch.length;
    opts?.log?.(done, pending.length);
  }
  return done;
}
