// Resolución de rutas por-usuario. Cada usuario tiene su directorio `data/users/<userId>/`
// con TODO lo suyo — `memu.db` (datos de Memu) y `wacli/` (store wacli: auth + fuente + media).
// Aislación FÍSICA: imposible filtrar datos entre usuarios por un query mal escrito. El userId
// es el id (int) del registro central (registry.ts), como string para usarlo de componente de ruta.
//
// En el orquestador el userId sale del ruteo de ingesta (`/wacli/<userId>`); las CLIs
// mono-usuario (pair, ask, digest) usan `MEMU_USER_ID`.

import { join } from "node:path";

const USERS_DIR = process.env.MEMU_USERS_DIR ?? "./data/users";

/** userId del dueño en Fase 0 (mono-usuario) = user 1 del registro. */
export const DEFAULT_USER_ID = process.env.MEMU_USER_ID ?? "1";

// Guard anti path-traversal: el userId se usa como componente de ruta, así que un valor
// malicioso ("../otro", "/etc") podría cruzar a los datos de otro usuario. Exigimos un id
// simple. Es una barrera de seguridad central a la promesa de aislación, no cosmética.
function assertSafeUserId(userId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(userId) || userId.includes("..")) {
    throw new Error(`userId inválido (riesgo de path traversal): ${JSON.stringify(userId)}`);
  }
}

/** Directorio home de un usuario: `data/users/<userId>/`. */
export function userDir(userId: string): string {
  assertSafeUserId(userId);
  return join(USERS_DIR, userId);
}

/** Ruta del `memu.db` de un usuario. */
export function memuDbPath(userId: string): string {
  return join(userDir(userId), "memu.db");
}

/** Directorio del store wacli de un usuario: `data/users/<userId>/wacli/` (auth + fuente + media). */
export function wacliStoreDir(userId: string): string {
  return join(userDir(userId), "wacli");
}
