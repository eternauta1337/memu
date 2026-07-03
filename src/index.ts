// Runner de la Fase 0: valida que la ingesta del WhatsApp propio funciona de punta a punta.
//
//   1. Verifica el pairing (`wacli auth status`).
//   2. Levanta el webhook loopback.
//   3. Spawnea `wacli sync --follow --webhook` (respawn con backoff).
//   4. Por cada mensaje: normaliza (conservando grupos + self), guarda en SQLite y loguea
//      una línea. Objetivo: VER en vivo DMs, grupos y el self-chat cayendo a la DB.
//
// Correr: `pnpm ingest` (tras `pnpm pair`). Ctrl-C para cortar.

import "./env.ts";
import { type ChildProcess, spawn } from "node:child_process";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { askMemo } from "./agent.ts";
import { generateDigest } from "./digest.ts";
import { type MemoMessage, normalizeForMemo } from "./ingest.ts";
import { embedMissing } from "./indexer.ts";
import { openLidMap } from "./lidmap.ts";
import { openMediaIndex } from "./media.ts";
import { nextFire } from "./reminders.ts";
import { closeAllStores, getStore } from "./store.ts";
import { transcribe } from "./stt.ts";
import { synthesize } from "./tts.ts";
import { DEFAULT_USER_ID, memoDbPath } from "./users.ts";
import { WacliClient } from "./wacli/wacli-client.ts";
import { WacliWebhookServer } from "./wacli/wacli-webhook-server.ts";
import { isBroadcastJid, stripDeviceSuffix } from "./wacli/wacli-webhook-types.ts";

const WACLI_BIN = process.env.WACLI_BIN ?? "wacli";
const STORE = process.env.WACLI_STORE ?? "./data/wacli";
const MEMO_PREFIX = "🤖 "; // marca los mensajes de Memo en el self-chat (todos van a la derecha)
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const isAudioType = (t?: string): boolean => t === "audio" || t === "ptt";

// Modalidad de la respuesta: por default ESPEJA la entrada (audio→audio, texto→texto), salvo que
// la persona pida explícitamente lo contrario en el mensaje.
const WANT_TEXT = /\b(en|por)\s+(texto|escrito)\b|escrib(i|í|ime|irme|ir)|nada de audio|no.*(audio|voz)/i;
const WANT_AUDIO = /\b(en|por|con)\s+(audio|voz)\b|nota de voz|mand[aá](me)?\s+(un\s+)?audio|habl[aá]me|contest[aá](me)?\s+(hablando|con audio)/i;
function detectReplyMode(text: string, inputAudio: boolean): "audio" | "text" {
  if (WANT_TEXT.test(text)) return "text";
  if (WANT_AUDIO.test(text)) return "audio";
  return inputAudio ? "audio" : "text";
}

async function main(): Promise<void> {
  const client = new WacliClient({ bin: WACLI_BIN, store: STORE });

  const status = await client.authStatus().catch((e: Error) => {
    console.error(`No pude consultar wacli auth status: ${e.message}`);
    process.exit(1);
  });
  if (!status.authenticated) {
    console.error("WhatsApp no está pareado. Corré `pnpm pair` y escaneá el QR primero.");
    process.exit(1);
  }
  const ownJid = status.linked_jid ?? status.jid ?? null;
  console.log(`✅ Pareado como ${ownJid ?? "?"}${status.phone ? ` (+${status.phone})` : ""}`);

  const store = getStore(DEFAULT_USER_ID);
  console.log(dim(`store: ${memoDbPath(DEFAULT_USER_ID)} (usuario "${DEFAULT_USER_ID}", ${store.count()} mensajes)`));

  // Mapa LID↔teléfono (whatsmeow, read-only): canonicaliza los `@lid` vivos a JID de teléfono
  // para que matcheen el histórico y los nombres (ver lidmap.ts).
  const lidmap = openLidMap(STORE);
  const resolve = lidmap.resolve;

  // Índice de media (read-only sobre wacli.db) para ubicar los archivos de audio a transcribir.
  const media = openMediaIndex(STORE);
  const setMsgText = store.db.prepare("UPDATE messages SET text = ? WHERE id = ?");
  let ttsSeq = 0; // para nombres únicos de archivos TTS

  // Espera (con reintentos) a que wacli termine de descargar el audio de un mensaje.
  const waitForMedia = async (id: string): Promise<string | null> => {
    for (let i = 0; i < 6; i++) {
      const p = media.pathFor(id);
      if (p) return p;
      await sleep(1000);
    }
    return null;
  };

  // Identidades propias para detectar el self-chat, ya canonicalizadas a JID de teléfono.
  // Sembramos el linked_jid y el teléfono del auth status; además aprendemos del SenderJID de
  // los mensajes FromMe (canonicalizado) como red de seguridad.
  const ownIds = new Set<string>();
  if (ownJid) ownIds.add(resolve(stripDeviceSuffix(ownJid)));
  if (status.phone) ownIds.add(`${status.phone}@s.whatsapp.net`);

  // Loop del self-chat: cuando la persona escribe en "Mensajes contigo mismo", Memo responde
  // ahí. Los envíos de Memo (por wacli) NO vuelven por el webhook → sin feedback loop; igual
  // guardamos los ids que mandamos como cinturón de seguridad.
  const sentByMemo = new Set<string>();
  const queue: MemoMessage[] = [];
  let answering = false;
  const answerInSelfChat = async (): Promise<void> => {
    if (answering || !ownJid) return;
    answering = true;
    try {
      while (queue.length) {
        const m = queue.shift() as MemoMessage;
        // Ack "pensando…": indicador de typing nativo mientras gemma procesa (puede tardar varios
        // segundos con varias rondas de tools). WhatsApp expira el composing → lo refrescamos.
        let thinking = true;
        const pulse = () => client.presence(ownJid, "typing").catch(() => {});
        void pulse();
        const typingTimer = setInterval(() => thinking && void pulse(), 5000);
        typingTimer.unref();
        try {
          // Si la persona mandó un audio, lo transcribimos y esa es la pregunta. Guardamos la
          // transcripción en el mensaje (queda buscable como cualquier texto).
          let question = (m.text || "").trim();
          const inputAudio = isAudioType(m.mediaType);
          if (inputAudio && !question) {
            const path = await waitForMedia(m.id);
            if (path) {
              question = await transcribe(path);
              if (question) {
                setMsgText.run(question, m.id);
                console.log(dim(`[stt] self: "${question.slice(0, 60)}"`));
              }
            }
          }
          if (!question) {
            await client.sendText(ownJid, `${MEMO_PREFIX}no pude entender el audio 🫤`).catch(() => {});
            continue;
          }

          // La respuesta espeja la modalidad de entrada, salvo pedido explícito.
          const mode = detectReplyMode(question, inputAudio);
          const ans = (await askMemo(store, question, { voice: mode === "audio" })).trim();
          if (!ans) continue;

          if (mode === "audio") {
            const out = join(STORE, `../tts-${Date.now()}-${ttsSeq++}.ogg`);
            try {
              await synthesize(ans, out);
              const r = await client.sendVoice(ownJid, out);
              if (r.id) sentByMemo.add(r.id);
            } catch (e) {
              // Si el TTS falla, no te quedes sin respuesta: mando el texto.
              console.log(dim(`[tts] falló, mando texto: ${(e as Error)?.message ?? e}`));
              const r = await client.sendText(ownJid, `${MEMO_PREFIX}${ans}`);
              if (r.id) sentByMemo.add(r.id);
            } finally {
              await unlink(out).catch(() => {});
            }
          } else {
            // Prefijo 🤖 para distinguir a Memo de tus propios mensajes: en el self-chat
            // ambos aparecen a la derecha (son de tu cuenta), no hay forma de ponerlos a la izq.
            const r = await client.sendText(ownJid, `${MEMO_PREFIX}${ans}`);
            if (r.id) sentByMemo.add(r.id);
          }
        } catch (e) {
          console.log(dim(`[memo] error respondiendo: ${(e as Error)?.message ?? e}`));
          await client.sendText(ownJid, `${MEMO_PREFIX}uf, algo falló procesando eso 🫤`).catch(() => {});
        } finally {
          thinking = false;
          clearInterval(typingTimer);
          void client.presence(ownJid, "paused").catch(() => {});
        }
      }
    } finally {
      answering = false;
    }
  };

  const webhook = new WacliWebhookServer();
  webhook.onMessage((raw) => {
    if (raw.FromMe && raw.SenderJID) ownIds.add(resolve(stripDeviceSuffix(raw.SenderJID)));
    const m = normalizeForMemo(raw, ownIds, resolve);
    // Los Estados/difusiones no son conversaciones → los ignoramos (ensucian retrieval/pendientes).
    if (isBroadcastJid(m.chatJid)) return;
    const saved = store.save(m);
    const tag = m.chatKind === "self" ? "🧠SELF" : m.chatKind === "group" ? "👥GRP " : "💬DM  ";
    const dir = m.fromMe ? "→" : "←";
    const media = m.mediaType ? ` [${m.mediaType}]` : "";
    const body = (m.text || m.reactionEmoji || "").replace(/\s+/g, " ").slice(0, 80);
    console.log(`${tag} ${dir} ${m.pushName || m.senderJid}: ${body}${media}${saved ? "" : dim(" (dup)")}`);

    // Disparar respuesta solo para mensajes NUEVOS de la persona en el self-chat: texto real o
    // una nota de voz (que se transcribe en el procesador), no reacciones/borrados ni lo nuestro.
    const hasContent = Boolean(m.text.trim()) || isAudioType(m.mediaType);
    if (saved && m.chatKind === "self" && hasContent && !m.revoked && !m.reactionEmoji && !sentByMemo.has(m.id)) {
      queue.push(m);
      void answerInSelfChat();
    }
  });
  await webhook.listen();
  console.log(dim(`webhook en ${webhook.url}`));

  let shuttingDown = false;
  let proc: ChildProcess | null = null;
  // Backoff de reconexión: reconectar el websocket muchas veces seguidas es señal anómala para
  // WhatsApp (riesgo de que invalide los companion devices). Exponencial con tope, se resetea si
  // el follow corrió estable. Y si nos deslinkearon, CORTAMOS (no martillamos reconexiones).
  const MIN_BACKOFF = 2000;
  const MAX_BACKOFF = 60_000;
  let backoff = MIN_BACKOFF;
  const startSync = (): void => {
    if (shuttingDown) return;
    const args = [
      "sync",
      "--follow",
      "--download-media",
      "--store",
      STORE,
      "--webhook",
      webhook.url,
      "--webhook-secret",
      webhook.webhookSecret,
      "--webhook-allow-private",
    ];
    console.log(dim("wacli sync --follow → webhook (Ctrl-C para cortar)"));
    const startedAt = Date.now();
    proc = spawn(WACLI_BIN, args, { stdio: ["ignore", "inherit", "inherit"], env: process.env });
    proc.once("exit", (code, signal) => {
      proc = null;
      if (shuttingDown) return;
      // Si corrió estable un rato, reseteamos el backoff; si murió enseguida, lo subimos.
      const ranMs = Date.now() - startedAt;
      backoff = ranMs > 60_000 ? MIN_BACKOFF : Math.min(backoff * 2, MAX_BACKOFF);
      void (async () => {
        // ¿Nos deslinkearon? Entonces reconectar no sirve y solo hace ruido → cortar y avisar.
        const st = await client.authStatus().catch(() => null);
        if (st && !st.authenticated) {
          console.error(
            "⚠️  WhatsApp deslinkeó este dispositivo. NO reintento (evito hammerear reconexiones). Corré `pnpm pair` para reconectar.",
          );
          return;
        }
        console.log(dim(`sync salió (code=${code} signal=${signal}) — respawn en ${backoff / 1000}s`));
        setTimeout(startSync, backoff).unref();
      })();
    });
    proc.once("error", (err) => console.error(`sync spawn error: ${String(err)}`));
  };
  startSync();

  // Embed incremental: cada 60s embebe los mensajes nuevos que llegaron (más recientes primero,
  // acotado). Así lo que entra en vivo también es buscable por significado. Tolerante a correr en
  // paralelo con el índice full (`pnpm embed`). El modelo se carga lazy en el 1er sweep.
  let sweeping = false;
  const embedSweep = async (): Promise<void> => {
    if (sweeping || shuttingDown || !store.vecEnabled) return;
    sweeping = true;
    try {
      const n = await embedMissing(store, { order: "desc", limit: 256 });
      if (n) console.log(dim(`[embed] +${n} vectores`));
    } catch (e) {
      console.log(dim(`[embed] sweep error: ${(e as Error)?.message ?? e}`));
    } finally {
      sweeping = false;
    }
  };
  const embedTimer = store.vecEnabled ? setInterval(() => void embedSweep(), 60_000) : null;
  embedTimer?.unref();

  // Scheduler de reminders: cada 30s dispara los vencidos al self-chat. Los recurrentes se
  // re-agendan solos; los de una sola vez quedan 'done'. Es la única pieza de scheduling y
  // siempre nace de un pedido de la persona (nunca automático).
  let firing = false;
  const fireDueReminders = async (): Promise<void> => {
    if (firing || shuttingDown || !ownJid) return;
    firing = true;
    try {
      for (const r of store.dueReminders(Date.now())) {
        const body = r.action === "digest" ? await generateDigest(store) : `🤖 ⏰ ${r.text}`;
        try {
          const sent = await client.sendText(ownJid, body);
          if (sent.id) sentByMemo.add(sent.id);
          store.markFired(r.id, nextFire(r.fireAt, r.recurrence, Date.now()));
          console.log(dim(`[reminder] #${r.id} disparado (${r.action})`));
        } catch (e) {
          console.log(dim(`[reminder] #${r.id} falló al enviar: ${(e as Error)?.message ?? e}`));
        }
      }
    } finally {
      firing = false;
    }
  };
  const reminderTimer = setInterval(() => void fireDueReminders(), 30_000);
  reminderTimer.unref();
  void fireDueReminders(); // chequeo inicial (por si quedaron vencidos mientras estaba caído)

  // Sweep de STT: transcribe en background los audios (de cualquier chat) que todavía no tienen
  // texto, así quedan buscables y entran al digest. Acotado (CPU) y de a poco, lo más nuevo primero.
  // Una vez con texto, el embed sweep los indexa semánticamente solos.
  const selUntranscribed = store.db.prepare(
    "SELECT id FROM messages WHERE media_type IN ('audio','ptt') AND (text IS NULL OR text = '') AND revoked = 0 ORDER BY ts DESC LIMIT ?",
  );
  const sttTried = new Set<string>(); // ids ya intentados en esta corrida (sin archivo o sin habla)
  let sttSweeping = false;
  const sttSweep = async (): Promise<void> => {
    if (sttSweeping || shuttingDown) return;
    sttSweeping = true;
    try {
      const cand = (selUntranscribed.all(30) as Array<{ id: string }>)
        .filter((r) => !sttTried.has(r.id))
        .slice(0, 4);
      let done = 0;
      for (const r of cand) {
        if (shuttingDown) break;
        const path = media.pathFor(r.id);
        if (!path) {
          sttTried.add(r.id); // sin archivo descargable → no reintentar en esta corrida
          continue;
        }
        try {
          const t = await transcribe(path);
          if (t) {
            setMsgText.run(t, r.id);
            done++;
          } else {
            sttTried.add(r.id); // audio sin habla reconocible
          }
        } catch (e) {
          sttTried.add(r.id);
          console.log(dim(`[stt] error ${r.id}: ${(e as Error)?.message ?? e}`));
        }
      }
      if (done) console.log(dim(`[stt] +${done} transcripciones`));
    } finally {
      sttSweeping = false;
    }
  };
  const sttTimer = setInterval(() => void sttSweep(), 90_000);
  sttTimer.unref();

  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (embedTimer) clearInterval(embedTimer);
    clearInterval(reminderTimer);
    clearInterval(sttTimer);
    lidmap.close();
    media.close();
    console.log(`\n${dim("cerrando…")} total en DB: ${store.count()}`);
    closeAllStores();
    if (proc && !proc.killed) proc.kill("SIGTERM");
    setTimeout(() => process.exit(0), 800).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main();
