// Embeddings vía TEI (text-embeddings-inference, GPU) — endpoint nativo `/embed`
// (NO es OpenAI-compat). Modelo: `Alibaba-NLP/gte-multilingual-base` (768-dim, normalizado,
// contexto 8192, SIN prefijos query/passage — gte no los usa). Antes: model server del stack
// docker de Onyx (mismo modelo, endpoint `/encoder/bi-encoder-embed`); cuando ese stack se
// bajó quedó el contenedor standalone `memu-embed` publicado en 127.0.0.1:9000. Los vectores
// ya indexados siguen válidos: es el mismo modelo.

const EMBED_URL = process.env.EMBED_URL ?? "http://127.0.0.1:9000/embed";
const EMBED_TIMEOUT_MS = Number(process.env.EMBED_TIMEOUT_MS ?? 60_000);

export const EMBED_DIM = 768; // dimensión de gte-multilingual-base (mantener en sync con store.ts VEC_DIM)

/** Embebe textos vía TEI. `kind` se conserva en la firma por compatibilidad con los call
 *  sites, pero no se manda: gte no usa prefijos query/passage. `truncate: true` recorta a las
 *  8192 tokens de contexto (sin eso TEI rechaza inputs largos). Vectores normalizados
 *  (norma 1) → coseno = dot. */
export async function embed(texts: string[], kind: "query" | "passage"): Promise<number[][]> {
  void kind;
  if (texts.length === 0) return [];
  const cleaned = texts.map((t) => t.replace(/\s+/g, " ").trim());
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), EMBED_TIMEOUT_MS);
  try {
    const res = await fetch(EMBED_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ inputs: cleaned, normalize: true, truncate: true }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      throw new Error(`embeddings HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
    }
    const json = (await res.json()) as number[][];
    if (!Array.isArray(json) || !Array.isArray(json[0])) throw new Error("embeddings: respuesta no es number[][]");
    return json;
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
