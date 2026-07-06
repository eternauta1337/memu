// Reminders: la única pieza de scheduling de Memu, siempre disparada por la persona (nunca
// automática). El agente (tool crear_recordatorio) interpreta el pedido en lenguaje natural y llama
// a `reminderFromFields`; un loop en el ingest (index.ts) dispara los vencidos al self-chat y
// `nextFire` re-agenda los recurrentes. Acá viven los helpers de fecha/recurrencia y formato.

import type { NewReminder, Recurrence } from "./store.ts";

const DAYS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];

// Parsea "YYYY-MM-DDTHH:MM" como hora LOCAL (no UTC). Devuelve epoch ms, o null si no parsea.
function localToMs(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(s.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi] = m.map(Number);
  const t = new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
  return Number.isFinite(t) ? t : null;
}

function normalizeRecurrence(r: string | null | undefined): Recurrence {
  if (!r) return null;
  const v = r.trim().toLowerCase();
  if (v === "daily" || v === "weekdays") return v;
  const w = /^weekly:([0-6])$/.exec(v);
  if (w) return `weekly:${w[1]}`;
  return null;
}

/** Crea un NewReminder desde campos estructurados (los que arma la tool `crear_recordatorio`).
 *  Devuelve null si la fecha no parsea. */
export function reminderFromFields(f: {
  text: string;
  action?: string;
  fire_at: string;
  recurrence?: string | null;
}): NewReminder | null {
  const fireAt = localToMs(f.fire_at);
  if (fireAt == null) return null;
  const action = f.action === "digest" ? "digest" : "message";
  const text = (f.text || "").trim() || (action === "digest" ? "Resumen del día" : "Recordatorio");
  return { text, action, fireAt, recurrence: normalizeRecurrence(f.recurrence) };
}

// ¿El día `d` (getDay 0..6) matchea la recurrencia?
function dayMatches(dow: number, rec: Recurrence): boolean {
  if (rec === "daily") return true;
  if (rec === "weekdays") return dow >= 1 && dow <= 5;
  const w = rec && /^weekly:([0-6])$/.exec(rec);
  if (w) return dow === Number(w[1]);
  return false;
}

/** Próxima ejecución de un reminder recurrente después de dispararse, o null si es de una sola vez.
 *  Avanza día por día desde fireAt manteniendo la hora, hasta caer en un día válido y futuro. */
export function nextFire(fireAtMs: number, recurrence: Recurrence, nowMs: number): number | null {
  if (!recurrence) return null;
  const d = new Date(fireAtMs);
  for (let i = 0; i < 400; i++) {
    d.setDate(d.getDate() + 1);
    if (dayMatches(d.getDay(), recurrence) && d.getTime() > nowMs) return d.getTime();
  }
  return null;
}

const RECUR_LABEL: Record<string, string> = { daily: "todos los días", weekdays: "de lunes a viernes" };

/** Texto humano de cuándo dispara un reminder, para confirmar en el self-chat. */
export function fmtWhen(fireAtMs: number, recurrence: Recurrence): string {
  const d = new Date(fireAtMs);
  const p = (n: number) => String(n).padStart(2, "0");
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  if (recurrence) {
    const w = /^weekly:([0-6])$/.exec(recurrence);
    const label = w ? `cada ${DAYS[Number(w[1])]}` : (RECUR_LABEL[recurrence] ?? "cada tanto");
    return `${label} a las ${hm}`;
  }
  return `el ${p(d.getDate())}/${p(d.getMonth() + 1)} a las ${hm}`;
}
