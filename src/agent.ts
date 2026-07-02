// El "cerebro" de Memo, ahora como AGENTE (antes era single-shot). Por cada mensaje de la persona
// en el self-chat corre un loop: gemma ve las herramientas (tools.ts), decide cuáles llamar,
// nosotros las ejecutamos y le devolvemos el resultado, y así encadena pasos hasta responder.
// Además arrastra memoria conversacional (session.ts) y memoria del usuario (hechos en el store).

import { type ChatMessage, complete } from "./llm.ts";
import { chatNames } from "./retrieval.ts";
import { loadSession, maybeCompact, saveTurn } from "./session.ts";
import type { MemoStore } from "./store.ts";
import { runTool, TOOLS } from "./tools.ts";

export { chatNames };

const MAX_STEPS = 6; // tope de rondas de tool-calling por mensaje

const DAYS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
function nowLabel(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())} (${DAYS[d.getDay()]})`;
}

function buildSystem(facts: string[], summary: string): string {
  const base = `Sos Memo, un asistente que vive dentro del WhatsApp de la persona (en su chat "Mensajes
contigo mismo"). Ayudás a manejar el quilombo de WhatsApp: qué tiene pendiente, a quién responder,
qué pasó en sus chats y grupos. Hablás español rioplatense, concreto y directo, sin vueltas.

Reglas:
- NUNCA respondés por la persona ni le escribís a terceros. Si te pide ayuda con una respuesta,
  sugerí el texto ENTRE PARÉNTESIS para que ella lo copie si quiere.
- Para saber algo de sus conversaciones, USÁ las herramientas (buscar_mensajes, leer_chat,
  listar_chats, pendientes). No inventes: si las herramientas no lo traen, decí que no lo ves.
- Si la persona te enseña un dato sobre sí misma o su gente ("mi mamá es Marta", "tal grupo es mi
  familia"), guardalo con la herramienta recordar.
- Si te pide que le recuerdes/avises algo, o un resumen a cierta hora, usá crear_recordatorio.
- Citá los chats por su nombre. Sé breve.

AHORA (hora local): ${nowLabel()}`;
  const mem = facts.length ? `\n\nLo que sabés de la persona:\n${facts.map((f) => `- ${f}`).join("\n")}` : "";
  const sum = summary ? `\n\nResumen de lo que venían hablando:\n${summary}` : "";
  return base + mem + sum;
}

/** Responde un mensaje de la persona corriendo el loop de agente sobre su WhatsApp. */
export async function askMemo(store: MemoStore, question: string): Promise<string> {
  const names = chatNames();
  saveTurn(store, "user", question);
  const { summary, history } = loadSession(store);
  const facts = store.listFacts().map((f) => f.text);

  const messages: ChatMessage[] = [{ role: "system", content: buildSystem(facts, summary) }, ...history];

  let answer = "";
  for (let step = 0; step < MAX_STEPS; step++) {
    const { content, toolCalls } = await complete(messages, { tools: TOOLS, maxTokens: 900 });
    if (toolCalls.length === 0) {
      answer = content.trim();
      break;
    }
    // El assistant pidió herramientas: registramos su turno y ejecutamos cada una.
    messages.push({ role: "assistant", content: content || "", tool_calls: toolCalls });
    for (const tc of toolCalls) {
      const result = await runTool(store, names, tc.function.name, tc.function.arguments);
      messages.push({ role: "tool", tool_call_id: tc.id, name: tc.function.name, content: result });
    }
  }

  if (!answer) answer = "Uf, me enrosqué buscando eso. ¿Lo reformulás?";
  saveTurn(store, "assistant", answer);
  await maybeCompact(store);
  return answer;
}
