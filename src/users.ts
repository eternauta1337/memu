// Resolución de rutas por-usuario. Cada usuario tiene su directorio `data/users/<userId>/`
// con su propio `memo.db` — aislación FÍSICA de datos (ver <doc interno>
// §Escalado): imposible filtrar datos entre usuarios por un query mal escrito.
//
// Fase 0 = un solo dueño → `MEMO_USER_ID` (default "self"). Multi-tenant (paso 4): el userId
// vendrá del ruteo de ingesta. El store `wacli/` sigue global por ahora; se vuelve per-usuario
// en el paso 4 (pool de ingest).

import { join } from "node:path";

const USERS_DIR = process.env.MEMO_USERS_DIR ?? "./data/users";

/** userId del dueño en Fase 0 (mono-usuario). */
export const DEFAULT_USER_ID = process.env.MEMO_USER_ID ?? "self";

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

/** Ruta del `memo.db` de un usuario. */
export function memoDbPath(userId: string): string {
  return join(userDir(userId), "memo.db");
}
