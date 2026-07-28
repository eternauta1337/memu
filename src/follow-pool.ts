// Pool de follows: acota los `wacli sync --follow` concurrentes a `cap` y ESCALONA los arranques.
// Reconectar muchos websockets de golpe es señal anómala para WhatsApp (riesgo de ban / de que
// invalide los companion devices); el escalonado evita ese thundering-herd al arrancar/reconectar.
//
// Prioridad por actividad reciente (registry.last_active): si hay más usuarios que `cap`, se
// siguen los más activos primero. Diseño CONSERVADOR: el reconcile LLENA hasta el cap pero NO
// evicta follows en caliente (evictar+reprender sería churn de reconexiones = riesgo de ban).
// Los usuarios que exceden el cap se LOGUEAN (nada de cobertura silenciosa). La eviction real
// solo ocurre en el shutdown (stopAll) o si un usuario se pausa/deshabilita.

import type { UserRuntime } from "./user-runtime.ts";

export interface FollowPoolOptions {
  /** Runtimes por userId (los crea el orquestador). */
  runtimes: Map<string, UserRuntime>;
  /** userIds candidatos ordenados por prioridad (más activo primero); se relee en cada reconcile. */
  priorityOrder: () => string[];
  /** Máximo de follows concurrentes. */
  cap: number;
  /** Delay entre arranques sucesivos de follow (anti thundering-herd). */
  staggerMs: number;
  log?: (msg: string) => void;
}

export interface FollowPool {
  /** Prende follows (escalonado) hasta `cap`, en orden de prioridad. No evicta en caliente. */
  reconcile(): void;
  /** El usuario está activo → si no tiene follow y hay lugar, reconciliar. */
  noteActivity(userId: string): void;
  /** Apaga todos los follows (shutdown). */
  stopAll(): void;
  /** userIds con follow prendido (para logs/tests). */
  followed(): string[];
}

export function createFollowPool(opts: FollowPoolOptions): FollowPool {
  const { runtimes, priorityOrder, cap, staggerMs } = opts;
  const log = opts.log ?? (() => {});
  const followed = new Set<string>();
  const startQueue: string[] = [];
  let draining = false;

  // Arranca los follows encolados de a uno, espaciados por `staggerMs` (el 1º va inmediato).
  const drainStartQueue = (): void => {
    if (draining) return;
    draining = true;
    const step = (): void => {
      const userId = startQueue.shift();
      if (userId === undefined) {
        draining = false;
        return;
      }
      const rt = runtimes.get(userId);
      if (rt?.authenticated && !followed.has(userId)) {
        rt.startFollow();
        followed.add(userId);
        log(`follow prendido u${userId} (${followed.size}/${cap})`);
      }
      if (startQueue.length) setTimeout(step, staggerMs).unref();
      else draining = false;
    };
    step();
  };

  const reconcile = (): void => {
    const order = priorityOrder().filter((id) => runtimes.get(id)?.authenticated);
    const desired = order.slice(0, cap);
    const toStart = desired.filter((id) => !followed.has(id) && !startQueue.includes(id));
    if (toStart.length) {
      startQueue.push(...toStart);
      drainStartQueue();
    }
    const uncovered = order.slice(cap).filter((id) => !followed.has(id));
    if (uncovered.length) {
      const sample = uncovered.slice(0, 5).join(",");
      log(`⚠️ ${uncovered.length} usuario(s) sin follow (cap=${cap}): ${sample}${uncovered.length > 5 ? "…" : ""}`);
    }
  };

  const noteActivity = (userId: string): void => {
    if (!followed.has(userId) && !startQueue.includes(userId)) reconcile();
  };

  const stopAll = (): void => {
    startQueue.length = 0;
    for (const id of [...followed]) {
      runtimes.get(id)?.stopFollow();
      followed.delete(id);
    }
  };

  return { reconcile, noteActivity, stopAll, followed: () => [...followed] };
}
