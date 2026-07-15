// Tareas: la lista de pendientes explícitos de la persona ("anotame comprar X"). A diferencia
// de los reminders (tiempo → mensaje), una tarea es ESTADO: queda viva (pendiente → activa →
// en progreso) hasta que la persona la completa o la descarta. La fecha límite es metadata pura
// (ordena la lista, nunca dispara nada). Acá viven los helpers de fecha, estado/prioridad y
// formato; el CRUD está en store.ts y las tools en tools.ts.

import type { Task, TaskPriority } from "./store.ts";

/** Días viva a partir de los cuales el digest pregunta si la tarea sigue viva. */
export const STALE_DAYS = 10;

/** Estado "vivo" tal como lo nombra la persona (lo que aceptan las tools) → interno. */
const STATUS_ES: Record<string, "pending" | "active" | "in_progress"> = {
  pendiente: "pending",
  pending: "pending",
  activa: "active",
  active: "active",
  "en progreso": "in_progress",
  en_progreso: "in_progress",
  in_progress: "in_progress",
};

const PRIORITY_ES: Record<string, TaskPriority> = {
  baja: "low",
  low: "low",
  media: "medium",
  medium: "medium",
  alta: "high",
  high: "high",
};

export const STATUS_LABEL: Record<Task["status"], string> = {
  pending: "pendiente",
  active: "activa",
  in_progress: "en progreso",
  done: "hecha",
  dropped: "descartada",
};

export const PRIORITY_LABEL: Record<TaskPriority, string> = { low: "baja", medium: "media", high: "alta" };

/** Marcador visual de prioridad en la lista (media no marca: es el default). */
const PRIORITY_MARK: Record<TaskPriority, string> = { high: "🔺 ", medium: "", low: "🔻 " };

/** Normaliza un estado vivo dicho por la persona/el modelo ("en progreso", "activa"). "hecha"
 *  NO está acá a propósito: completar es closeTask, no un update. Devuelve null si no matchea. */
export function normalizeStatus(s: string | null | undefined): "pending" | "active" | "in_progress" | null {
  if (!s) return null;
  return STATUS_ES[s.trim().toLowerCase()] ?? null;
}

/** Normaliza una prioridad ("baja"/"media"/"alta"). Devuelve null si no matchea. */
export function normalizePriority(s: string | null | undefined): TaskPriority | null {
  if (!s) return null;
  return PRIORITY_ES[s.trim().toLowerCase()] ?? null;
}

/** Valida una fecha límite "YYYY-MM-DD" (acepta y trunca si viene con hora). Devuelve la fecha
 *  normalizada, o null si no parsea o no es una fecha real del calendario. */
export function normalizeDue(s: string | null | undefined): string | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s.trim());
  if (!m) return null;
  const [, y, mo, d] = m.map(Number);
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return m[0];
}

/** Texto humano de la fecha límite ("vence el 15/07", o "vencía el 15/07 ⚠️" si ya pasó). */
export function fmtDue(dueAt: string, now = new Date()): string {
  const [y, mo, d] = dueAt.split("-").map(Number);
  const due = new Date(y, mo - 1, d);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const p = (n: number) => String(n).padStart(2, "0");
  const label = `${p(d)}/${p(mo)}`;
  return due < today ? `vencía el ${label} ⚠️` : `vence el ${label}`;
}

/** Una línea de tarea para el self-chat. SIEMPRE con #id: es lo que desambigua "listo la 2"
 *  (¿la segunda de la lista o el id 2?) cuando la persona la quiere cerrar. */
export function fmtTask(t: Task): string {
  return `#${t.id}: ${PRIORITY_MARK[t.priority]}${t.text}${t.dueAt ? ` — ${fmtDue(t.dueAt)}` : ""}`;
}

/** Días (enteros) que lleva viva una tarea. `createdAt` viene de datetime('now') → UTC. */
export function taskAgeDays(t: Task, nowMs = Date.now()): number {
  const created = Date.parse(`${t.createdAt.replace(" ", "T")}Z`);
  if (!Number.isFinite(created)) return 0;
  return Math.max(0, Math.floor((nowMs - created) / 86_400_000));
}

/** La lista completa agrupada por estado (en progreso → activas → pendientes), respetando el
 *  orden que ya trae openTasks(). Con `stale`, señala las que llevan demasiado vivas para que
 *  la lista no degenere en un cementerio. */
export function fmtTaskList(tasks: Task[], opts?: { stale?: boolean; nowMs?: number }): string {
  const GROUPS: Array<{ status: Task["status"]; label: string }> = [
    { status: "in_progress", label: "En progreso" },
    { status: "active", label: "Activas" },
    { status: "pending", label: "Pendientes" },
  ];
  const sections: string[] = [];
  for (const g of GROUPS) {
    const rows = tasks.filter((t) => t.status === g.status);
    if (rows.length === 0) continue;
    const lines = rows.map((t) => {
      const age = taskAgeDays(t, opts?.nowMs ?? Date.now());
      const flag = opts?.stale && age >= STALE_DAYS ? ` (viva hace ${age} días — ¿sigue en pie?)` : "";
      return `• ${fmtTask(t)}${flag}`;
    });
    sections.push(`${g.label}:\n${lines.join("\n")}`);
  }
  return sections.join("\n");
}
