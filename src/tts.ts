// Text-to-speech vía Inworld (API HTTP síncrona, base64 in/out). POST /tts/v1/voice con
// `Authorization: Basic <INWORLD_API_KEY>` (la runtime key ya viene base64, va tal cual).
// Devuelve OGG/Opus 48kHz, que es justo la nota de voz de wacli, así que no hace falta
// transcodear un solo chunk. Cuesta plata (INWORLD_API_KEY).
//
// La voz (INWORLD_VOICE_DEFAULT) es un id del workspace al que pertenece la key: si se rota la
// key a otro workspace, hay que actualizarla. No hay default posible — depende de la cuenta.
//
// El caller (index.ts) cae a texto si synthesize() tira, así que un fallo de red/API o una
// config incompleta no dejan al usuario sin respuesta.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE_URL = process.env.INWORLD_BASE_URL ?? "https://api.inworld.ai";
const API_KEY = process.env.INWORLD_API_KEY ?? "";
const TTS_MODEL = process.env.INWORLD_TTS_MODEL ?? "inworld-tts-1.5-max";
const VOICE = process.env.INWORLD_VOICE_DEFAULT ?? "";
// Ritmo: Inworld acepta speakingRate 0.5–1.5 (1.0 = normal). Default 0.9 = un toque pausado,
// honrando el preset "calmado" que el usuario venía usando con Piper. Env-configurable.
const SPEAKING_RATE = clampRate(Number(process.env.INWORLD_SPEAKING_RATE ?? "0.9"));
const TIMEOUT_MS = Number(process.env.TTS_TIMEOUT_MS ?? 60_000);
const MAX_CHARS = 2_000; // límite por request de Inworld

function clampRate(r: number): number {
  if (!Number.isFinite(r)) return 1.0;
  return Math.min(1.5, Math.max(0.5, r));
}

/** Parte el texto en chunks ≤ MAX_CHARS, cortando en límites de oración/línea cuando se puede. */
function chunkText(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let cur = "";
  for (const piece of text.split(/(?<=[.!?…\n])\s+/)) {
    if (piece.length > max) {
      if (cur) {
        chunks.push(cur);
        cur = "";
      }
      for (let i = 0; i < piece.length; i += max) chunks.push(piece.slice(i, i + max));
      continue;
    }
    if (cur.length + piece.length + 1 > max) {
      chunks.push(cur);
      cur = piece;
    } else {
      cur = cur ? `${cur} ${piece}` : piece;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

/** UN request a /tts/v1/voice; devuelve el OGG/Opus (base64-decodeado). */
async function inworldTts(text: string): Promise<Buffer> {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}/tts/v1/voice`, {
      method: "POST",
      headers: { Authorization: `Basic ${API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        voiceId: VOICE,
        modelId: TTS_MODEL,
        audioConfig: { audioEncoding: "OGG_OPUS", sampleRateHertz: 48_000, speakingRate: SPEAKING_RATE },
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 400);
      throw new Error(`inworld /tts/v1/voice → HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
    }
    const json = (await res.json()) as { audioContent?: string };
    if (!json.audioContent) throw new Error("inworld /tts/v1/voice: respuesta sin audioContent");
    return Buffer.from(json.audioContent, "base64");
  } catch (e) {
    if ((e as Error)?.name === "AbortError") throw new Error(`inworld TTS: timeout (${TIMEOUT_MS}ms)`);
    throw e;
  } finally {
    clearTimeout(to);
  }
}

/** Concatena varios OGG/Opus con el demuxer concat de ffmpeg (re-multiplexa sin recodificar;
 *  pegar bytes de Ogg no es confiable por los serials de stream distintos). */
function concatOgg(parts: Buffer[], outPath: string): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "memu-tts-"));
  const listPath = join(dir, "list.txt");
  const lines = parts.map((p, i) => {
    const pp = join(dir, `part-${i}.ogg`);
    writeFileSync(pp, p);
    return `file '${pp}'`;
  });
  writeFileSync(listPath, lines.join("\n"), "utf8");
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", outPath,
    ]);
    let err = "";
    ff.stderr.on("data", (d) => (err += d));
    ff.on("error", reject);
    ff.on("close", (code) => {
      rmSync(dir, { recursive: true, force: true });
      code === 0 ? resolve() : reject(new Error(`ffmpeg concat falló: ${err.slice(-300)}`));
    });
  });
}

/** Sintetiza `text` a una nota de voz OGG/Opus en `outPath` vía Inworld. Un solo chunk se
 *  escribe directo; multi-chunk se concatena con ffmpeg. */
export async function synthesize(text: string, outPath: string): Promise<string> {
  if (!API_KEY) throw new Error("TTS no configurado: falta INWORLD_API_KEY");
  if (!VOICE) throw new Error("TTS no configurado: falta INWORLD_VOICE_DEFAULT (id de voz del workspace)");
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) throw new Error("nada que sintetizar (texto vacío)");

  const chunks = chunkText(clean, MAX_CHARS);
  const parts: Buffer[] = [];
  for (const chunk of chunks) parts.push(await inworldTts(chunk));

  if (parts.length === 1) {
    writeFileSync(outPath, parts[0]!);
  } else {
    await concatOgg(parts, outPath);
  }
  return outPath;
}
