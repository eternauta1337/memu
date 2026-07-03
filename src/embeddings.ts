// Embeddings vía el model server de Onyx (GPU) — endpoint propio `/encoder/bi-encoder-embed`
// (NO es OpenAI-compat). Modelo: `Alibaba-NLP/gte-multilingual-base` (768-dim, normalizado,
// contexto 8192, SIN prefijos query/passage — gte no los usa). Antes: `multilingual-e5-small`
// local en CPU (Transformers.js, 384-dim); se movió a la GPU para sacar ~4 GB de RAM del
// proceso node y poder escalar a multi-usuario (ver <doc interno> §Escalado).
//
// OJO ACOPLE: el default apunta a la IP interna del docker network de Onyx (172.18.0.2). Si
// Onyx recrea el stack esa IP puede cambiar → override con EMBED_URL en `.env`. Lo correcto a
// futuro es mapear el puerto del model server a host y apuntar ahí.

const EMBED_URL = process.env.EMBED_URL ?? "http://172.18.0.2:9000/encoder/bi-encoder-embed";
const EMBED_MODEL = process.env.EMBED_MODEL ?? "Alibaba-NLP/gte-multilingual-base";
const EMBED_MAX_CTX = Number(process.env.EMBED_MAX_CONTEXT ?? 8192);
const EMBED_TIMEOUT_MS = Number(process.env.EMBED_TIMEOUT_MS ?? 60_000);

export const EMBED_DIM = 768; // dimensión de gte-multilingual-base (mantener en sync con store.ts VEC_DIM)

interface EmbedResponse {
  embeddings?: number[][];
}

/** Embebe textos vía el model server de Onyx. `kind` se pasa como `text_type` ("query" para
 *  consultas, "passage" para lo indexado); gte no aplica prefijo, pero lo mandamos igual por
 *  fidelidad con el contrato del endpoint. Vectores normalizados (norma 1) → coseno = dot. */
export async function embed(texts: string[], kind: "query" | "passage"): Promise<number[][]> {
  if (texts.length === 0) return [];
  const cleaned = texts.map((t) => t.replace(/\s+/g, " ").trim());
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), EMBED_TIMEOUT_MS);
  try {
    const res = await fetch(EMBED_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        texts: cleaned,
        model_name: EMBED_MODEL,
        max_context_length: EMBED_MAX_CTX,
        normalize_embeddings: true,
        text_type: kind,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      throw new Error(`embeddings HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
    }
    const json = (await res.json()) as EmbedResponse;
    if (!Array.isArray(json.embeddings)) throw new Error("embeddings: respuesta sin campo 'embeddings'");
    return json.embeddings;
  } catch (e) {
    if ((e as Error)?.name === "AbortError") throw new Error(`embeddings: timeout (${EMBED_TIMEOUT_MS}ms)`);
    throw e;
  } finally {
    clearTimeout(to);
  }
}

/** Serializa un vector a BLOB float32 para sqlite-vec. */
export function toVecBlob(vec: number[]): Buffer {
  return Buffer.from(new Float32Array(vec).buffer);
}
