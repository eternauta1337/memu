// Acceso a los archivos de media que wacli descarga (`--download-media`). Los bytes viven en
// disco (`<store>/media/…`) y la ruta está en `wacli.db.messages.local_path`. Memu no guarda la
// ruta en su propia DB (solo el tipo/mime), así que la resolvemos acá por id de mensaje.
// Read-only: convive con el `sync --follow`.

import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface MediaIndex {
  /** Ruta local del archivo de un mensaje (si se descargó y existe en disco), o null. */
  pathFor(msgId: string): string | null;
  close(): void;
}

export function openMediaIndex(storeDir: string): MediaIndex {
  let db: Database.Database | null = null;
  let stmt: Database.Statement | null = null;
  try {
    db = new Database(join(storeDir, "wacli.db"), { readonly: true, fileMustExist: true });
    db.pragma("busy_timeout = 3000");
    stmt = db.prepare("SELECT local_path FROM messages WHERE msg_id = ? AND local_path IS NOT NULL LIMIT 1");
  } catch {
    /* sin wacli.db → sin media */
  }
  return {
    pathFor(msgId: string): string | null {
      if (!stmt) return null;
      try {
        const row = stmt.get(msgId) as { local_path: string } | undefined;
        const p = row?.local_path;
        return p && existsSync(p) ? p : null;
      } catch {
        return null;
      }
    },
    close() {
      db?.close();
    },
  };
}
