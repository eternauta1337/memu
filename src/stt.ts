// Speech-to-text vía el server Speaches (faster-whisper large-v3-turbo) en GPU. Endpoint
// OpenAI-compat POST /v1/audio/transcriptions (multipart). Antes: whisper-small in-process
// (Transformers.js/ONNX, CPU); se movió a la GPU para sacar RAM del proceso node y escalar a
// multi-usuario (ver <doc interno> §Escalado).
//
// Speaches decodifica el audio solo (opus/oga/m4a/…), así que mandamos el archivo tal cual —
// no hace falta pre-decodificar a PCM con ffmpeg como antes.
//
// Wiring DIRECTO (no vía LiteLLM) por consistencia con embeddings y para no tocar el gateway
// compartido de gemma. STT_URL lo hace configurable si algún día se frontea con LiteLLM.

import { readFile } from "node:fs/promises";
import { basename } from "node:path";

const STT_URL = process.env.STT_URL ?? "http://127.0.0.1:5001/v1/audio/transcriptions";
const STT_MODEL = process.env.STT_MODEL ?? "deepdml/faster-whisper-large-v3-turbo-ct2";
const STT_LANG = process.env.STT_LANG ?? "es";
const STT_TIMEOUT_MS = Number(process.env.STT_TIMEOUT_MS ?? 120_000);

/** Transcribe un archivo de audio a texto (español). "" si no hay nada reconocible. */
export async function transcribe(file: string): Promise<string> {
  const buf = await readFile(file);
  if (buf.length === 0) return "";
  const form = new FormData();
  form.append("file", new Blob([buf]), basename(file));
  form.append("model", STT_MODEL);
  form.append("language", STT_LANG);

  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), STT_TIMEOUT_MS);
  try {
    const res = await fetch(STT_URL, { method: "POST", body: form, signal: ctrl.signal });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      throw new Error(`STT HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
    }
    const json = (await res.json()) as { text?: string };
    return (json.text ?? "").replace(/\s+/g, " ").trim();
  } catch (e) {
    if ((e as Error)?.name === "AbortError") throw new Error(`STT: timeout (${STT_TIMEOUT_MS}ms)`);
    throw e;
  } finally {
    clearTimeout(to);
  }
}
