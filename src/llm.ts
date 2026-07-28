// Cliente mínimo del LLM: cualquier endpoint OpenAI-compatible con tool calling (LLM_BASE_URL),
// sea un gateway delante de un modelo local o un proveedor hosted. Usamos fetch directo: es una
// sola llamada `chat/completions`, no hace falta el SDK de OpenAI.

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[]; // en mensajes assistant que llaman herramientas
  tool_call_id?: string; // en mensajes role:"tool" (respuesta a una tool_call)
  name?: string; // nombre de la herramienta, en mensajes role:"tool"
}

/** Spec de una herramienta en formato OpenAI (lo que gemma vía LiteLLM entiende). */
export interface ToolSpec {
  type: "function";
  function: { name: string; description: string; parameters: object };
}

const BASE = process.env.LLM_BASE_URL ?? "http://127.0.0.1:4000/v1";
const KEY = process.env.LLM_API_KEY ?? "";
const MODEL = process.env.LLM_MODEL ?? "gemma4-31b";

interface CompleteOpts {
  maxTokens?: number;
  temperature?: number;
  model?: string;
  tools?: ToolSpec[];
  toolChoice?: "auto" | "none";
}

/** Llamada cruda al chat/completions. Devuelve el mensaje del assistant completo (content +
 *  tool_calls), para poder correr el loop de agente. */
export async function complete(
  messages: ChatMessage[],
  opts?: CompleteOpts,
): Promise<{ content: string; toolCalls: ToolCall[] }> {
  const body: Record<string, unknown> = {
    model: opts?.model ?? MODEL,
    messages,
    max_tokens: opts?.maxTokens ?? 1024,
    temperature: opts?.temperature ?? 0.3,
  };
  if (opts?.tools?.length) {
    body.tools = opts.tools;
    body.tool_choice = opts.toolChoice ?? "auto";
  }
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string | null; tool_calls?: ToolCall[] } }>;
  };
  const msg = data.choices?.[0]?.message;
  return { content: msg?.content ?? "", toolCalls: msg?.tool_calls ?? [] };
}

/** Completion simple de texto (sin herramientas). Para usos one-shot: digest, parser, etc. */
export async function chat(
  messages: ChatMessage[],
  opts?: { maxTokens?: number; temperature?: number; model?: string },
): Promise<string> {
  return (await complete(messages, opts)).content;
}
