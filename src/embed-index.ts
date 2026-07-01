// Índice full de embeddings: indexa todo lo pendiente (histórico). Idempotente — se puede
// re-correr para ponerse al día.
//
//   pnpm embed            # indexa todo lo pendiente
//   pnpm embed 2000       # indexa hasta 2000 (para probar rápido)

import "./env.ts";
import { embedMissing } from "./indexer.ts";
import { openStore } from "./store.ts";

const DB = process.env.MEMO_DB ?? "./data/memo.db";

async function main(): Promise<void> {
  const limit = Number(process.argv[2]) || 0;
  const store = openStore(DB);
  if (!store.vecEnabled) {
    console.error("sqlite-vec no está disponible; no puedo indexar embeddings.");
    process.exit(1);
  }

  const t0 = Date.now();
  let total = 0;
  const n = await embedMissing(store, {
    limit,
    order: "asc",
    log: (done, tot) => {
      total = tot;
      if (done % (64 * 8) === 0 || done === tot) {
        const rate = done / ((Date.now() - t0) / 1000);
        console.log(`  ${done}/${tot} (${rate.toFixed(0)} msg/s)`);
      }
    },
  });
  if (total === 0) console.log("nada pendiente por indexar.");
  console.log(`✅ indexados ${n} en ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

void main();
