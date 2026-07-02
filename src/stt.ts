// Speech-to-text local (Whisper vía Transformers.js / ONNX, CPU) — mismo stack que embeddings,
// sin servicio aparte ni GPU. ffmpeg decodifica el audio (opus/.oga u otro) a PCM float32 mono
// 16kHz, que es lo que Whisper espera. $0.

import { env, pipeline } from "@huggingface/transformers";
import { execFile } from "node:child_process";

const STT_MODEL = process.env.STT_MODEL ?? "Xenova/whisper-small";
env.cacheDir = process.env.EMBED_CACHE ?? "./data/models";

type Asr = (
  audio: Float32Array,
  opts: Record<string, unknown>,
) => Promise<{ text?: string }>;

let asrPromise: Promise<Asr> | null = null;
function getAsr(): Promise<Asr> {
  if (!asrPromise) asrPromise = pipeline("automatic-speech-recognition", STT_MODEL) as unknown as Promise<Asr>;
  return asrPromise;
}

/** Decodifica un archivo de audio a PCM float32 mono 16kHz usando ffmpeg. */
function decodePcm(file: string): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    execFile(
      "ffmpeg",
      ["-hide_banner", "-loglevel", "error", "-i", file, "-ar", "16000", "-ac", "1", "-f", "f32le", "-"],
      { encoding: "buffer", maxBuffer: 1 << 28 },
      (err, stdout) => {
        if (err) return reject(err);
        const buf = stdout as unknown as Buffer;
        const n = Math.floor(buf.length / 4);
        // Copiamos a un ArrayBuffer alineado (el Buffer de stdout puede no estar 4-aligned).
        const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + n * 4);
        resolve(new Float32Array(ab));
      },
    );
  });
}

/** Transcribe un archivo de audio a texto (español). "" si no hay nada. */
export async function transcribe(file: string): Promise<string> {
  const audio = await decodePcm(file);
  if (audio.length === 0) return "";
  const asr = await getAsr();
  const out = await asr(audio, {
    language: "spanish",
    task: "transcribe",
    chunk_length_s: 30, // parte audios largos
    stride_length_s: 5,
  });
  return (out.text ?? "").replace(/\s+/g, " ").trim();
}
