// Chats archivados: los que el usuario archivó en WhatsApp. Por pedido, NO se ingieren ni indexan
// — el usuario los archivó justamente para sacarlos de su vista, así que los dejamos afuera del
// segundo cerebro. Leemos el flag `archived` de la tabla `chats` de wacli.db (read-only). Se
// refresca cada tanto porque el usuario puede archivar/desarchivar en vivo. Para incluirlos igual,
// MEMO_INGEST_ARCHIVED=1.

import Database from "better-sqlite3";
import { join } from "node:path";
import { stripDeviceSuffix } from "./wacli/wacli-webhook-types.ts";

/** true si se pidió NO filtrar archivados (ingerir todo). */
export const ingestArchived = process.env.MEMO_INGEST_ARCHIVED === "1";

/** Set de JIDs (stripped) de los chats archivados en el store wacli dado. Vacío si no filtramos. */
export function readArchivedJids(storeDir: string): Set<string> {
  const set = new Set<string>();
  if (ingestArchived) return set;
  try {
    const db = new Database(join(storeDir, "wacli.db"), { readonly: true, fileMustExist: true });
    db.pragma("busy_timeout = 3000");
    for (const r of db.prepare("SELECT jid FROM chats WHERE archived = 1").all() as Array<{ jid: string }>) {
      set.add(stripDeviceSuffix(r.jid));
    }
    db.close();
  } catch {
    /* sin wacli.db / sin columna → set vacío (no filtra) */
  }
  return set;
}
