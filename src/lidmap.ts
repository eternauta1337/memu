// Resolución de identidad LID↔teléfono. El webhook EN VIVO entrega DMs/self como `<lid>@lid`
// (el "linked ID" nuevo de WhatsApp), pero el histórico (`wacli.db`) y los nombres están en
// formato teléfono `<pn>@s.whatsapp.net`. whatsmeow mantiene el mapa oficial en
// `session.db` → tabla `whatsmeow_lid_map(lid PRIMARY KEY, pn)`.
//
// Canonicalizamos TODO a JID de teléfono en el borde de ingesta: así los mensajes vivos y el
// histórico del mismo contacto comparten `chat_jid`, y `chatNames()` (keyed por teléfono)
// resuelve el nombre solo. Lectura read-only (convive con el `sync --follow` que tiene el store).

import Database from "better-sqlite3";
import { join } from "node:path";
import { stripDeviceSuffix } from "./wacli/wacli-webhook-types.ts";

export interface LidMap {
  /** Canonicaliza un JID: `<lid>@lid` → `<pn>@s.whatsapp.net` (si hay mapeo); resto sin tocar. */
  resolve(jid: string): string;
  /** Teléfono (solo dígitos) para un número de lid, o null si no está mapeado. */
  pnForLid(lidNum: string): string | null;
  close(): void;
}

export function openLidMap(storeDir: string): LidMap {
  let db: Database.Database | null = null;
  let stmt: Database.Statement | null = null;
  try {
    db = new Database(join(storeDir, "session.db"), { readonly: true, fileMustExist: true });
    db.pragma("busy_timeout = 3000");
    stmt = db.prepare("SELECT pn FROM whatsmeow_lid_map WHERE lid = ?");
  } catch (e) {
    console.error(`lid-map no disponible (${(e as Error).message}); los DMs vivos quedarán en @lid`);
  }
  const cache = new Map<string, string>(); // lidNum → pnNum (cacheamos solo hits: un miss puede resolverse luego)

  const pnForLid = (lidNum: string): string | null => {
    const hit = cache.get(lidNum);
    if (hit) return hit;
    if (!stmt) return null;
    try {
      const row = stmt.get(lidNum) as { pn: string } | undefined;
      if (row?.pn) {
        cache.set(lidNum, row.pn);
        return row.pn;
      }
    } catch {
      /* store lockeado/transitorio → reintentamos en la próxima */
    }
    return null;
  };

  const resolve = (jid: string): string => {
    const s = stripDeviceSuffix(jid);
    if (!s.endsWith("@lid")) return s;
    const pn = pnForLid(s.slice(0, -"@lid".length));
    return pn ? `${pn}@s.whatsapp.net` : s;
  };

  return {
    resolve,
    pnForLid,
    close() {
      db?.close();
    },
  };
}
