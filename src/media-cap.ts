// Cap de media por usuario: acota el tamaño de su carpeta de media (data/users/<id>/wacli/media)
// borrando los archivos MÁS VIEJOS (por mtime) hasta bajar del cap. Solo se van los blobs — los
// mensajes quedan en la DB; media.ts ya maneja el archivo faltante (existsSync → null), así que
// STT/retrieval lo saltan sin romperse. Sin esto, 500 usuarios × media ilimitada = 1 TB+ (ver
// <doc interno> §Escalado / §Retención).
//
// Poda con "low-water mark" (default 90% del cap) para no podar en cada pasada rozando el borde.
// No toca `local_path` en wacli.db (fuente de terceros); el existsSync de media.ts es la red.

import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

export interface PruneResult {
  beforeBytes: number;
  afterBytes: number;
  deleted: number;
}

/** Poda `dir` a ≤ `lowWaterBytes` si supera `capBytes`, borrando lo más viejo primero. */
export function pruneMediaDir(
  dir: string,
  capBytes: number,
  lowWaterBytes: number = Math.floor(capBytes * 0.9),
): PruneResult {
  if (capBytes <= 0 || !existsSync(dir)) return { beforeBytes: 0, afterBytes: 0, deleted: 0 };

  const files: Array<{ path: string; size: number; mtimeMs: number }> = [];
  let total = 0;
  for (const ent of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!ent.isFile()) continue;
    // Node ≥20.12 expone parentPath; fallback a path para versiones previas.
    const parent = (ent as { parentPath?: string; path?: string }).parentPath ?? (ent as { path?: string }).path ?? dir;
    const p = join(parent, ent.name);
    try {
      const st = statSync(p);
      files.push({ path: p, size: st.size, mtimeMs: st.mtimeMs });
      total += st.size;
    } catch {
      /* archivo desapareció entre readdir y stat → ignorar */
    }
  }

  const beforeBytes = total;
  if (total <= capBytes) return { beforeBytes, afterBytes: total, deleted: 0 };

  files.sort((a, b) => a.mtimeMs - b.mtimeMs); // más viejo primero
  let deleted = 0;
  for (const f of files) {
    if (total <= lowWaterBytes) break;
    try {
      rmSync(f.path, { force: true });
      total -= f.size;
      deleted++;
    } catch {
      /* no se pudo borrar → seguir */
    }
  }
  return { beforeBytes, afterBytes: total, deleted };
}
