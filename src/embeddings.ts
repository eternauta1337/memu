// Embeddings locales en Node (Transformers.js / ONNX, CPU) — sin servicio aparte ni GPU
// (la GPU está ocupada por gemma). Modelo multilingüe chico, bueno para español.
//
// e5 pide prefijos: "query: " para consultas, "passage: " para los textos indexados.
// Devuelve vectores normalizados (norma 1) → similitud coseno = producto punto.

import { env, pipeline } from "@huggingface/transformers";

const MODEL = process.env.EMBED_MODEL ?? "Xenova/multilingual-e5-small";
export const EMBED_DIM = 384; // dimensión de multilingual-e5-small

// Cachear el modelo dentro de ./data (gitignored) en vez de node_modules.
env.cacheDir = process.env.EMBED_CACHE ?? "./data/models";

type Extractor = (
  texts: string[],
  opts: { pooling: "mean"; normalize: boolean },
) => Promise<{ tolist(): number[][] }>;

let extractorPromise: Promise<Extractor> | null = null;
function getExtractor(): Promise<Extractor> {
  if (!extractorPromise) {
    extractorPromise = pipeline("feature-extraction", MODEL) as unknown as Promise<Extractor>;
  }
  return extractorPromise;
}

/** Embebe textos. `kind` aplica el prefijo e5 ("query"/"passage"). Vectores normalizados. */
export async function embed(texts: string[], kind: "query" | "passage"): Promise<number[][]> {
  if (texts.length === 0) return [];
  const prefixed = texts.map((t) => `${kind}: ${t.replace(/\s+/g, " ").trim()}`);
  const extractor = await getExtractor();
  const out = await extractor(prefixed, { pooling: "mean", normalize: true });
  return out.tolist();
}

/** Serializa un vector a BLOB float32 para sqlite-vec. */
export function toVecBlob(vec: number[]): Buffer {
  return Buffer.from(new Float32Array(vec).buffer);
}
