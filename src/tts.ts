// Text-to-speech local (MMS-TTS / VITS vía Transformers.js, CPU) — mismo stack, sin servicio ni
// GPU. Genera el waveform y lo encodea a OGG/Opus con ffmpeg (formato que wacli manda como nota
// de voz). $0. Calidad "correcta" (algo robótica); se puede subir a Piper más adelante.

import { env, pipeline } from "@huggingface/transformers";
import { spawn } from "node:child_process";

const TTS_MODEL = process.env.TTS_MODEL ?? "Xenova/mms-tts-spa";
env.cacheDir = process.env.EMBED_CACHE ?? "./data/models";

type Synth = (text: string) => Promise<{ audio: Float32Array; sampling_rate: number }>;

let synthPromise: Promise<Synth> | null = null;
function getSynth(): Promise<Synth> {
  if (!synthPromise) synthPromise = pipeline("text-to-speech", TTS_MODEL) as unknown as Promise<Synth>;
  return synthPromise;
}

/** Encodea PCM float32 mono a OGG/Opus con ffmpeg (leyendo de stdin). */
function encodeOpus(pcm: Buffer, sampleRate: number, outPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "f32le", "-ar", String(sampleRate), "-ac", "1", "-i", "-",
      "-c:a", "libopus", "-b:a", "32k", outPath,
    ]);
    let err = "";
    ff.stderr.on("data", (d) => (err += d));
    ff.on("error", reject);
    ff.on("close", (code) => (code === 0 ? resolve(outPath) : reject(new Error(`ffmpeg opus falló: ${err}`))));
    ff.stdin.write(pcm);
    ff.stdin.end();
  });
}

/** Sintetiza `text` a una nota de voz OGG/Opus en `outPath`. Devuelve outPath. */
export async function synthesize(text: string, outPath: string): Promise<string> {
  const synth = await getSynth();
  const out = await synth(text.replace(/\s+/g, " ").trim());
  const f32 = out.audio;
  const pcm = Buffer.from(f32.buffer, f32.byteOffset, f32.length * 4);
  return encodeOpus(pcm, out.sampling_rate, outPath);
}
