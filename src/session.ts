// Memoria conversacional del self-chat + compactación. Memo mantiene UNA sesión (single-tenant
// por ahora): el diálogo con la persona. Los turnos se persisten en `conversation`; cuando crecen,
// los más viejos se resumen en un `summary` y se avanza un `cutoff`, así el prompt no explota.

import { chat, type ChatMessage } from "./llm.ts";
import type { MemoStore, Turn } from "./store.ts";

const SUMMARY_KEY = "summary";
const CUTOFF_KEY = "cutoff";

const KEEP = 12; // turnos recientes que quedan verbatim
const MAX = 28; // a partir de acá, compactamos los más viejos

export interface SessionCtx {
  summary: string; // resumen de lo hablado antes (o "")
  history: ChatMessage[]; // turnos recientes como mensajes user/assistant
}

/** Carga el estado de sesión: resumen + turnos recientes (posteriores al cutoff). */
export function loadSession(store: MemoStore): SessionCtx {
  const summary = store.getState(SUMMARY_KEY) ?? "";
  const cutoff = Number(store.getState(CUTOFF_KEY) ?? 0);
  const history: ChatMessage[] = store.turnsAfter(cutoff).map((t: Turn) => ({
    role: t.role,
    content: t.content,
  }));
  return { summary, history };
}

/** Persiste un turno del diálogo. */
export function saveTurn(store: MemoStore, role: "user" | "assistant", content: string): void {
  if (content.trim()) store.appendTurn(role, content);
}

function renderTurns(turns: Turn[]): string {
  return turns.map((t) => `${t.role === "user" ? "Persona" : "Memo"}: ${t.content}`).join("\n");
}

/** Si el diálogo creció, resume los turnos más viejos en el summary y avanza el cutoff. */
export async function maybeCompact(store: MemoStore): Promise<void> {
  const cutoff = Number(store.getState(CUTOFF_KEY) ?? 0);
  const turns = store.turnsAfter(cutoff);
  if (turns.length <= MAX) return;

  const toSummarize = turns.slice(0, turns.length - KEEP);
  if (toSummarize.length === 0) return;
  const prev = store.getState(SUMMARY_KEY) ?? "";

  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "Resumís una conversación entre una persona y su asistente de WhatsApp (Memo). Integrá el resumen previo con los nuevos turnos en un único resumen breve, en español rioplatense, que preserve lo importante: pedidos abiertos, preferencias, hilos en curso y datos que la persona dio. No inventes.",
    },
    {
      role: "user",
      content: `Resumen previo:\n${prev || "(vacío)"}\n\nNuevos turnos:\n${renderTurns(toSummarize)}\n\n---\nDevolvé el resumen actualizado.`,
    },
  ];
  try {
    const summary = (await chat(messages, { maxTokens: 500, temperature: 0.2 })).trim();
    if (summary) {
      store.setState(SUMMARY_KEY, summary);
      store.setState(CUTOFF_KEY, String(toSummarize[toSummarize.length - 1].id));
    }
  } catch (e) {
    console.error(`[session] compactación falló: ${(e as Error).message}`);
  }
}
