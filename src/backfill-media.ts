// Backfill throttleado de media histórica (audios): baja los archivos que el follow no trajo
// (`--download-media` solo cubre lo reciente). Una vez bajados, el ingest los transcribe (STT
// sweep) e indexa (embed sweep).
//
// IMPORTANTE: `wacli media download` necesita el lock EXCLUSIVO del store → NO corre junto al
// ingest. Pará el ingest antes (Ctrl-C), corré esto, y al terminar reiniciá el ingest.
//
// Throttleado a propósito (mitigación de ban: bajar cientos de medios de golpe es señal anómala).
//
//   pnpm backfill-media                 # baja todos los audios faltantes, ~20s entre c/u
//   pnpm backfill-media 100             # tope de 100 este run
//   MEDIA_BACKFILL_DELAY_MS=30000 pnpm backfill-media   # más lento

import "./env.ts";
import Database from "better-sqlite3";
import { join } from "node:path";
import { WacliClient } from "./wacli/wacli-client.ts";

const WACLI_BIN = process.env.WACLI_BIN ?? "wacli";
const STORE = process.env.WACLI_STORE ?? "./data/wacli";
const DELAY_MS = Number(process.env.MEDIA_BACKFILL_DELAY_MS) || 20_000; // entre descargas
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Cand {
  chat_jid: string;
  msg_id: string;
}

async function main(): Promise<void> {
  const limit = Number(process.argv[2]) || 0;
  const src = new Database(join(STORE, "wacli.db"), { readonly: true });
  const cands = src
    .prepare(
      `SELECT chat_jid, msg_id FROM messages
       WHERE media_type IN ('audio','ptt') AND local_path IS NULL AND chat_jid NOT LIKE '%@broadcast'
       ORDER BY ts DESC ${limit ? `LIMIT ${Math.floor(limit)}` : ""}`,
    )
    .all() as Cand[];
  src.close();

  if (cands.length === 0) {
    console.log("No hay audios pendientes de descarga. ✅");
    return;
  }
  const eta = Math.round((cands.length * DELAY_MS) / 60_000);
  console.log(`${cands.length} audios a bajar · ~${DELAY_MS / 1000}s c/u · ETA ~${eta} min`);
  console.log(dim("Ctrl-C para cortar (es idempotente: reanuda donde quedó).\n"));

  const client = new WacliClient({ bin: WACLI_BIN, store: STORE });

  let stopping = false;
  process.on("SIGINT", () => {
    console.log("\ncortando…");
    stopping = true;
  });

  let ok = 0;
  let fail = 0;
  for (let i = 0; i < cands.length && !stopping; i++) {
    const c = cands[i];
    try {
      await client.downloadMedia(c.chat_jid, c.msg_id, { lockWaitMs: 30_000 });
      ok++;
      if (ok % 10 === 0 || i === cands.length - 1) {
        console.log(dim(`  ${i + 1}/${cands.length} (ok=${ok} fail=${fail})`));
      }
    } catch (e) {
      fail++;
      const msg = (e as Error).message;
      // Media vieja puede ya no estar en los servers de WhatsApp → error esperado, seguimos.
      if (/store lock/i.test(msg)) {
        console.error("\n⛔ El store está lockeado — ¿el ingest sigue corriendo? Pará el ingest y reintentá.");
        break;
      }
      console.log(dim(`  ✗ ${c.msg_id.slice(0, 12)}: ${msg.slice(0, 80)}`));
    }
    if (!stopping && i < cands.length - 1) {
      // jitter ±30% para no parecer un bot regular.
      await sleep(DELAY_MS * (0.7 + 0.6 * ((i * 2654435761) % 1000) / 1000));
    }
  }
  console.log(`\n✅ listo: ${ok} bajados, ${fail} fallidos. Reiniciá el ingest para transcribir+indexar.`);
}

void main();
