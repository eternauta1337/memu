// Cliente mínimo del LLM local (gemma4-31b vía LiteLLM, endpoint OpenAI-compatible en host-backend).
// Usamos fetch directo: es una sola llamada `chat/completions`, no hace falta el SDK de OpenAI.
// NB: esto NO es Anthropic — es el modelo local; por eso el shape OpenAI y no el SDK de Claude.

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

const BASE = process.env.LLM_BASE_URL ?? "http://127.0.0.1:4000/v1";
const KEY = process.env.LLM_API_KEY ?? "";
const MODEL = process.env.LLM_MODEL ?? "gemma4-31b";

export async function chat(
  messages: ChatMessage[],
  opts?: { maxTokens?: number; temperature?: number; model?: string },
): Promise<string> {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${KEY}`,
    },
    body: JSON.stringify({
      model: opts?.model ?? MODEL,
      messages,
      max_tokens: opts?.maxTokens ?? 1024,
      temperature: opts?.temperature ?? 0.3,
    }),
  });
  if (!res.ok) {
    throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return data.choices?.[0]?.message?.content ?? "";
}
