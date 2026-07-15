// El "cerebro" de Memu, ahora como AGENTE (antes era single-shot). Por cada mensaje de la persona
// en el self-chat corre un loop: gemma ve las herramientas (tools.ts), decide cuáles llamar,
// nosotros las ejecutamos y le devolvemos el resultado, y así encadena pasos hasta responder.
// Además arrastra memoria conversacional (session.ts) y memoria del usuario (hechos en el store).

import { type ChatMessage, complete } from "./llm.ts";
import { chatNames } from "./retrieval.ts";
import { loadSession, maybeCompact, saveTurn } from "./session.ts";
import type { MemuStore, TaskSuggestion } from "./store.ts";
import { runTool, TOOLS } from "./tools.ts";

export { chatNames };

const MAX_STEPS = 6; // tope de rondas de tool-calling por mensaje
const MAX_OUTPUT = 900; // tokens de salida por respuesta (reservados del budget)

// Budget de contexto: garantizamos que lo que mandamos entra en la ventana del modelo. La
// compactación acota por turnos; esto acota por TOKENS (lo que de verdad importa), atajando el
// caso que los turnos no ven: resultados de tools que se acumulan dentro del loop.
const CONTEXT_TOKENS = Number(process.env.LLM_CONTEXT_TOKENS) || 131072; // gemma4-31b: 128k
const SAFETY_MARGIN = 4096; // colchón para el ruido de la estimación chars/4
const TOKEN_BUDGET = CONTEXT_TOKENS - MAX_OUTPUT - SAFETY_MARGIN;
const TOOL_CAP_CHARS = 8000; // ~2k tokens: tope por resultado de tool cuando hay que recortar

// Estimación barata de tokens (sin tokenizer): ~4 chars/token. Sobreestimamos un poco a propósito.
const estTokens = (s?: string | null): number => Math.ceil((s?.length ?? 0) / 4);
function msgTokens(m: ChatMessage): number {
  let t = 4 + estTokens(m.content);
  if (m.tool_calls) for (const tc of m.tool_calls) t += 4 + estTokens(tc.function.name) + estTokens(tc.function.arguments);
  if (m.name) t += estTokens(m.name);
  return t;
}
const totalTokens = (ms: ChatMessage[]): number => ms.reduce((s, m) => s + msgTokens(m), 0);

// Devuelve una vista de `messages` que entra en el budget. Estrategia, en orden: (1) recorta los
// resultados de tools grandes (in-place: quedan recortados para las rondas siguientes también);
// (2) dropea historial plano viejo, preservando SIEMPRE el system y el último turno de la persona.
// Los turnos dropeados no se pierden: siguen en la tabla `conversation` (y ya en el `summary`).
function fitToBudget(messages: ChatMessage[]): ChatMessage[] {
  if (totalTokens(messages) > TOKEN_BUDGET) {
    for (const m of messages) {
      if (m.role === "tool" && m.content && m.content.length > TOOL_CAP_CHARS) {
        m.content = `${m.content.slice(0, TOOL_CAP_CHARS)}\n…(recortado por límite de contexto)`;
      }
    }
  }
  const out = messages.slice();
  let dropped = 0;
  while (totalTokens(out) > TOKEN_BUDGET) {
    const lastUser = out.reduce((acc, m, i) => (m.role === "user" && !m.tool_calls ? i : acc), -1);
    const idx = out.findIndex(
      (m, i) => i !== 0 && i !== lastUser && (m.role === "user" || m.role === "assistant") && !m.tool_calls,
    );
    if (idx === -1) break; // no queda nada seguro para dropear → se manda y, si no entra, cae al fallback
    out.splice(idx, 1);
    dropped++;
  }
  if (dropped) console.error(`[budget] dropeé ${dropped} turnos viejos para entrar en contexto`);
  return out;
}

const DAYS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
function nowLabel(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())} (${DAYS[d.getDay()]})`;
}

const VOICE_NOTE = `\n\nIMPORTANTE: la persona te va a ESCUCHAR (respondés por nota de voz). Sé breve
y natural, como hablando: 2-4 frases, sin markdown, sin listas ni viñetas, sin emojis, sin URLs.
Si hay mucho para decir, resumí lo más importante y ofrecé el detalle por texto.`;

function buildSystem(facts: string[], summary: string, voice = false, suggestions: TaskSuggestion[] = []): string {
  const base = `Sos Memu, un asistente que vive dentro del WhatsApp de la persona (en su chat "Mensajes
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
- Si te pide anotar algo para hacer ("anotame comprar X", "tengo que llamar a Y"), usá crear_tarea.
  La lista se ve con listar_tareas y se cierra con completar_tarea (la hizo) o descartar_tarea (ya
  no aplica). Cada tarea tiene prioridad (baja/media/alta) y estado (pendiente/activa/en progreso):
  se cambian con actualizar_tarea (ej. "estoy con X" → en progreso; "X es urgente" → alta).
  Mencioná siempre el #id de cada tarea.
- Puede haber sugerencias de tareas del REM (el repaso nocturno de sus chats) esperando su sí/no
  (si hay, las ves más abajo). Si las acepta usá aceptar_sugerencia con el id de la sugerencia; si
  las rechaza, rechazar_sugerencia. NO uses crear_tarea para algo que viene de una sugerencia.
- Si quiere gestionar su suscripción (cambiar la tarjeta, ver facturas, cancelar o darse de baja),
  usá gestionar_suscripcion y pasale el link TAL CUAL te lo devuelve (no lo acortes ni lo edites).
- Citá los chats por su nombre. Sé breve.

AHORA (hora local): ${nowLabel()}`;
  // Cap defensivo: el system no se puede dropear en el budget, así que acotamos los hechos.
  const shown = facts.slice(-200);
  const mem = shown.length ? `\n\nLo que sabés de la persona:\n${shown.map((f) => `- ${f}`).join("\n")}` : "";
  const sum = summary ? `\n\nResumen de lo que venían hablando:\n${summary}` : "";
  const sug = suggestions.length
    ? `\n\nSugerencias de tareas del REM esperando el sí/no de la persona (aceptar_sugerencia / rechazar_sugerencia, por id):\n${suggestions
        .map((s) => `- #${s.id}: ${s.text}${s.reason ? ` (dijo: "${s.reason}")` : ""}`)
        .join("\n")}`
    : "";
  return base + mem + sum + sug + (voice ? VOICE_NOTE : "");
}

/** Responde un mensaje de la persona corriendo el loop de agente sobre su WhatsApp.
 *  `opts.voice` = la respuesta se va a escuchar (nota de voz) → pedimos algo breve y hablado. */
export async function askMemu(store: MemuStore, question: string, opts?: { voice?: boolean }): Promise<string> {
  const names = chatNames(store.userId);
  saveTurn(store, "user", question);
  const { summary, history } = loadSession(store);
  const facts = store.listFacts().map((f) => f.text);
  const suggestions = store.proposedTaskSuggestions();

  const messages: ChatMessage[] = [
    { role: "system", content: buildSystem(facts, summary, opts?.voice, suggestions) },
    ...history,
  ];

  let answer = "";
  for (let step = 0; step < MAX_STEPS; step++) {
    const { content, toolCalls } = await complete(fitToBudget(messages), { tools: TOOLS, maxTokens: MAX_OUTPUT });
    if (toolCalls.length === 0) {
      answer = content.trim();
      break;
    }
    // El assistant pidió herramientas: registramos su turno y ejecutamos cada una.
    messages.push({ role: "assistant", content: content || "", tool_calls: toolCalls });
    for (const tc of toolCalls) {
      const result = await runTool(store, names, tc.function.name, tc.function.arguments);
      if (process.env.MEMU_DEBUG) {
        console.error(`[tool] ${tc.function.name}(${tc.function.arguments}) → ${result.length}c\n${result.slice(0, 300)}\n`);
      }
      messages.push({ role: "tool", tool_call_id: tc.id, name: tc.function.name, content: result });
    }
  }

  if (!answer) answer = "Uf, me enrosqué buscando eso. ¿Lo reformulás?";
  saveTurn(store, "assistant", answer);
  await maybeCompact(store);
  return answer;
}
