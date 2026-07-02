// Text-to-speech local con Piper (rhasspy/piper): TTS neural VITS, CPU, rápido y con voz
// natural en español rioplatense (es_AR-daniela). Binario + voz viven en ./data/piper (gitignored,
// bajados aparte). Piper emite PCM crudo y ffmpeg lo encodea a OGG/Opus (nota de voz de wacli). $0.
//
// Antes usábamos mms-tts (Transformers.js) pero sonaba robótico. Piper es el upgrade de calidad.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const PIPER_BIN = process.env.PIPER_BIN ?? "./data/piper/piper/piper";
const PIPER_VOICE = process.env.PIPER_VOICE ?? "./data/piper/es_AR-daniela-high.onnx";
const PIPER_DIR = dirname(PIPER_BIN); // libs (LD_LIBRARY_PATH) y espeak-ng-data viven acá

// Parámetros de voz (elegidos por el usuario: pausada, lenta, calmada). Configurables por env.
const LENGTH_SCALE = process.env.PIPER_LENGTH_SCALE ?? "1.40"; // ritmo (>1 = más lento)
const NOISE_SCALE = process.env.PIPER_NOISE_SCALE ?? "0.55"; // timbre estable
const NOISE_W = process.env.PIPER_NOISE_W ?? "0.60"; // cadencia pareja
const SENTENCE_SILENCE = process.env.PIPER_SENTENCE_SILENCE ?? "0.70"; // pausa entre frases (s)

// Sample rate de la voz (del .onnx.json de Piper). Default 22050 (voces "high").
function voiceSampleRate(): number {
  try {
    const cfg = JSON.parse(readFileSync(`${PIPER_VOICE}.json`, "utf8")) as { audio?: { sample_rate?: number } };
    return cfg.audio?.sample_rate ?? 22050;
  } catch {
    return 22050;
  }
}
const SAMPLE_RATE = voiceSampleRate();

/** Sintetiza `text` a una nota de voz OGG/Opus en `outPath` (Piper → PCM → ffmpeg → opus). */
export function synthesize(text: string, outPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (e: Error) => {
      if (!settled) {
        settled = true;
        reject(e);
      }
    };

    const piper = spawn(
      PIPER_BIN,
      [
        "--model", PIPER_VOICE,
        "--espeak_data", join(PIPER_DIR, "espeak-ng-data"),
        "--length_scale", LENGTH_SCALE,
        "--noise_scale", NOISE_SCALE,
        "--noise_w", NOISE_W,
        "--sentence_silence", SENTENCE_SILENCE,
        "--output-raw",
      ],
      { env: { ...process.env, LD_LIBRARY_PATH: `${PIPER_DIR}:${process.env.LD_LIBRARY_PATH ?? ""}` } },
    );
    const ff = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "s16le", "-ar", String(SAMPLE_RATE), "-ac", "1", "-i", "-",
      "-c:a", "libopus", "-b:a", "32k", outPath,
    ]);

    let err = "";
    ff.stderr.on("data", (d) => (err += d));
    piper.stderr.on("data", (d) => (err += d)); // piper loguea info acá; solo importa si falla

    piper.on("error", fail);
    ff.on("error", fail);
    piper.stdout.pipe(ff.stdin);
    piper.on("close", (code) => {
      if (code !== 0) fail(new Error(`piper salió ${code}: ${err.slice(-300)}`));
    });
    ff.on("close", (code) => {
      if (code === 0) {
        if (!settled) {
          settled = true;
          resolve(outPath);
        }
      } else {
        fail(new Error(`ffmpeg opus falló: ${err.slice(-300)}`));
      }
    });

    piper.stdin.write(text.replace(/\s+/g, " ").trim());
    piper.stdin.end();
  });
}
