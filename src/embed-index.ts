// Indexa embeddings de los mensajes que todavía no tienen vector (en batches, CPU). Idempotente:
// procesa solo lo que falta, así se puede re-correr para ponerse al día.
//
//   pnpm embed            # indexa todo lo pendiente
//   pnpm embed 2000       # indexa hasta 2000 (para probar rápido)

import "./env.ts";
import { embed, toVecBlob } from "./embeddings.ts";
import { openStore } from "./store.ts";

const DB = process.env.MEMO_DB ?? "./data/memo.db";
const BATCH = 64;

interface Pending {
  rowid: number;
  text: string;
}

async function main(): Promise<void> {
  const limit = Number(process.argv[2]) || 0;
  const store = openStore(DB);
  if (!store.vecEnabled) {
    console.error("sqlite-vec no está disponible; no puedo indexar embeddings.");
    process.exit(1);
  }

  const pending = store.db
    .prepare(`
      SELECT m.rowid AS rowid, m.text AS text
      FROM messages m
      LEFT JOIN vec_messages v ON v.rowid = m.rowid
      WHERE v.rowid IS NULL AND m.text IS NOT NULL AND length(trim(m.text)) >= 2
      ORDER BY m.rowid
      ${limit ? "LIMIT " + limit : ""}
    `)
    .all() as Pending[];

  console.log(`${pending.length} mensajes por indexar (batch ${BATCH})`);
  if (pending.length === 0) return;

  // sqlite-vec exige que el rowid (primary key) se bindee como INTEGER estricto → BigInt.
  const insert = store.db.prepare("INSERT INTO vec_messages(rowid, embedding) VALUES (?, ?)");
  const insertBatch = store.db.transaction((rows: Pending[], vecs: number[][]) => {
    rows.forEach((r, i) => insert.run(BigInt(r.rowid), toVecBlob(vecs[i])));
  });

  let done = 0;
  const t0 = Date.now();
  for (let i = 0; i < pending.length; i += BATCH) {
    const batch = pending.slice(i, i + BATCH);
    const vecs = await embed(batch.map((b) => b.text), "passage");
    insertBatch(batch, vecs);
    done += batch.length;
    if (done % (BATCH * 8) === 0 || done === pending.length) {
      const rate = done / ((Date.now() - t0) / 1000);
      console.log(`  ${done}/${pending.length} (${rate.toFixed(0)} msg/s)`);
    }
  }
  console.log(`✅ indexados ${done} en ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

void main();
