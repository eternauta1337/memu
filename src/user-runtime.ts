// Runtime de UN usuario: toda la maquinaria per-tenant que antes vivía suelta en index.ts.
// Encapsula el store, el cliente wacli, el follow (con backoff), el loop de respuesta del
// self-chat, y los sweeps de embed/STT/reminders — todo scopeado a `userId` y a su store
// aislado (data/users/<id>/, ver users.ts). index.ts pasa a ser un orquestador que crea un
// runtime por usuario del registro y rutea los mensajes del webhook al que corresponde.
//
// `startFollow`/`stopFollow` son la interfaz que el pool de follows (paso 4c) va a manejar;
// en 4b el orquestador simplemente prende el follow de cada usuario activo.

import { type ChildProcess, spawn } from "node:child_process";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { askMemu } from "./agent.ts";
import { readArchivedJids } from "./archived.ts";
import { generateDigest } from "./digest.ts";
import { type MemuMessage, normalizeForMemu } from "./ingest.ts";
import { embedMissing } from "./indexer.ts";
import { openLidMap } from "./lidmap.ts";
import { openMediaIndex } from "./media.ts";
import { pruneMediaDir } from "./media-cap.ts";
import { nextFire } from "./reminders.ts";
import { getStore, type MemuStore } from "./store.ts";
import { transcribe } from "./stt.ts";
import { synthesize } from "./tts.ts";
import { wacliStoreDir } from "./users.ts";
import { WacliClient } from "./wacli/wacli-client.ts";
import { isBroadcastJid, stripDeviceSuffix, type WacliWebhookMessage } from "./wacli/wacli-webhook-types.ts";

const MEMU_PREFIX = "🤖 "; // marca los mensajes de Memu en el self-chat (todos van a la derecha)
const MEDIA_CAP_BYTES = Number(process.env.MEMU_MEDIA_CAP_MB ?? 500) * 1024 * 1024; // 0 = sin cap
const MEDIA_CAP_SWEEP_MS = Number(process.env.MEMU_MEDIA_CAP_SWEEP_MS) || 900_000; // 15 min
const mb = (b: number): number => Math.round(b / 1024 / 1024);
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

export interface UserRuntime {
  userId: string;
  /** JID linkeado (null si no está pareado → no responde ni sigue). */
  ownJid: string | null;
  /** true si el store wacli está autenticado. */
  authenticated: boolean;
  /** Procesa un mensaje vivo del webhook (normaliza → guarda → responde si es self-chat). */
  handleWebhook(raw: WacliWebhookMessage): void;
  /** Prende el `wacli sync --follow` del usuario (respawn con backoff). Lo maneja el pool en 4c. */
  startFollow(): void;
  /** Apaga el follow del usuario. */
  stopFollow(): void;
  /** Cierra timers, follow y recursos read-only. */
  close(): void;
}

export interface UserRuntimeOptions {
  userId: string;
  /** URL del webhook para este usuario (`…/wacli/<userId>`). */
  webhookUrl: string;
  webhookSecret: string;
  wacliBin: string;
  /** Se llama cuando el usuario está activo en su self-chat (para repriorizar el pool). */
  onActivity?: () => void;
}

/** Crea el runtime de un usuario: abre su store, consulta auth, y arma el loop de respuesta y los
 *  sweeps. NO prende el follow (lo hace el caller vía startFollow). */
export async function createUserRuntime(opts: UserRuntimeOptions): Promise<UserRuntime> {
  const { userId, webhookUrl, webhookSecret, wacliBin, onActivity } = opts;
  const storeDir = wacliStoreDir(userId);
  const u = (s: string) => `${dim(`[u${userId}]`)} ${s}`;

  const client = new WacliClient({ bin: wacliBin, store: storeDir });
  const status = await client.authStatus().catch((e: Error) => {
    console.error(u(`no pude consultar auth status: ${e.message}`));
    return null;
  });
  const authenticated = Boolean(status?.authenticated);
  const ownJid = status?.linked_jid ?? status?.jid ?? null;
  if (!authenticated) console.warn(u("WhatsApp no pareado → sin ingesta ni respuesta (corré pnpm pair)."));

  const store = getStore(userId);
  console.log(u(`pareado como ${ownJid ?? "?"}${status?.phone ? ` (+${status.phone})` : ""} · ${store.count()} mensajes`));

  // Read-only sobre el store wacli del usuario: mapa LID↔teléfono + índice de media.
  const lidmap = openLidMap(storeDir);
  const resolve = lidmap.resolve;
  const media = openMediaIndex(storeDir);
  const setMsgText = store.db.prepare("UPDATE messages SET text = ? WHERE id = ?");
  let ttsSeq = 0;

  // Chats archivados (no se ingieren). Se refresca cada tanto (el usuario archiva/desarchiva).
  let archivedJids = readArchivedJids(storeDir);
  const archivedTimer = setInterval(() => { archivedJids = readArchivedJids(storeDir); }, 300_000);
  archivedTimer.unref();

  const waitForMedia = async (id: string): Promise<string | null> => {
    for (let i = 0; i < 6; i++) {
      const p = media.pathFor(id);
      if (p) return p;
      await sleep(1000);
    }
    return null;
  };

  // Identidades propias (para detectar el self-chat), canonicalizadas a JID de teléfono.
  const ownIds = new Set<string>();
  if (ownJid) ownIds.add(resolve(stripDeviceSuffix(ownJid)));
  if (status?.phone) ownIds.add(`${status.phone}@s.whatsapp.net`);

  // Loop del self-chat. Los envíos de Memu (por wacli) NO vuelven por el webhook → sin feedback
  // loop; igual guardamos los ids como cinturón de seguridad.
  const sentByMemu = new Set<string>();
  const queue: MemuMessage[] = [];
  let answering = false;
  let closing = false;

  const answerInSelfChat = async (): Promise<void> => {
    if (answering || !ownJid) return;
    answering = true;
    try {
      while (queue.length) {
        const m = queue.shift() as MemuMessage;
        let thinking = true;
        const pulse = () => client.presence(ownJid, "typing").catch(() => {});
        void pulse();
        const typingTimer = setInterval(() => thinking && void pulse(), 5000);
        typingTimer.unref();
        try {
          let question = (m.text || "").trim();
          const inputAudio = isAudioType(m.mediaType);
          if (inputAudio && !question) {
            const path = await waitForMedia(m.id);
            if (path) {
              question = await transcribe(path);
              if (question) {
                setMsgText.run(question, m.id);
                console.log(u(dim(`[stt] self: "${question.slice(0, 60)}"`)));
              }
            }
          }
          if (!question) {
            await client.sendText(ownJid, `${MEMU_PREFIX}no pude entender el audio 🫤`).catch(() => {});
            continue;
          }

          const mode = detectReplyMode(question, inputAudio);
          const ans = (await askMemu(store, question, { voice: mode === "audio" })).trim();
          if (!ans) continue;

          if (mode === "audio") {
            const out = join(storeDir, `../tts-${Date.now()}-${ttsSeq++}.ogg`);
            try {
              await synthesize(ans, out);
              const r = await client.sendVoice(ownJid, out);
              if (r.id) sentByMemu.add(r.id);
            } catch (e) {
              console.log(u(dim(`[tts] falló, mando texto: ${(e as Error)?.message ?? e}`)));
              const r = await client.sendText(ownJid, `${MEMU_PREFIX}${ans}`);
              if (r.id) sentByMemu.add(r.id);
            } finally {
              await unlink(out).catch(() => {});
            }
          } else {
            const r = await client.sendText(ownJid, `${MEMU_PREFIX}${ans}`);
            if (r.id) sentByMemu.add(r.id);
          }
        } catch (e) {
          console.log(u(dim(`[memu] error respondiendo: ${(e as Error)?.message ?? e}`)));
          await client.sendText(ownJid, `${MEMU_PREFIX}uf, algo falló procesando eso 🫤`).catch(() => {});
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

  const handleWebhook = (raw: WacliWebhookMessage): void => {
    if (raw.FromMe && raw.SenderJID) ownIds.add(resolve(stripDeviceSuffix(raw.SenderJID)));
    const m = normalizeForMemu(raw, ownIds, resolve);
    if (isBroadcastJid(m.chatJid)) return; // Estados/difusiones no son conversaciones
    if (archivedJids.has(stripDeviceSuffix(m.chatJid))) return; // chat archivado → no se ingiere
    const saved = store.save(m);
    const tag = m.chatKind === "self" ? "🧠SELF" : m.chatKind === "group" ? "👥GRP " : "💬DM  ";
    const dir = m.fromMe ? "→" : "←";
    const mediaTag = m.mediaType ? ` [${m.mediaType}]` : "";
    const body = (m.text || m.reactionEmoji || "").replace(/\s+/g, " ").slice(0, 80);
    console.log(u(`${tag} ${dir} ${m.pushName || m.senderJid}: ${body}${mediaTag}${saved ? "" : dim(" (dup)")}`));

    // La CHARLA se mudó al bot central (central-bot.ts): este runtime solo LEE los chats del
    // usuario para armar su segundo cerebro (ingesta + embeddings + STT). No responde acá.
  };

  // --- Follow (wacli sync --follow) con backoff de reconexión -----------------------------
  let proc: ChildProcess | null = null;
  let followWanted = false; // el pool quiere este follow prendido (distinto de `closing`)
  const MIN_BACKOFF = 2000;
  const MAX_BACKOFF = 60_000;
  let backoff = MIN_BACKOFF;

  const startFollow = (): void => {
    if (closing || proc || !authenticated) return;
    followWanted = true;
    const args = [
      "sync", "--follow", "--download-media",
      "--store", storeDir,
      "--webhook", webhookUrl,
      "--webhook-secret", webhookSecret,
      "--webhook-allow-private",
    ];
    console.log(u(dim("wacli sync --follow → webhook")));
    const startedAt = Date.now();
    proc = spawn(wacliBin, args, { stdio: ["ignore", "inherit", "inherit"], env: process.env });
    proc.once("exit", (code, signal) => {
      proc = null;
      if (closing || !followWanted) return; // apagado a propósito (pool/shutdown) → no respawnear
      const ranMs = Date.now() - startedAt;
      backoff = ranMs > 60_000 ? MIN_BACKOFF : Math.min(backoff * 2, MAX_BACKOFF);
      void (async () => {
        // ¿Nos deslinkearon? Reconectar no sirve y solo hace ruido → cortar y avisar.
        const st = await client.authStatus().catch(() => null);
        if (st && !st.authenticated) {
          console.error(u("⚠️  WhatsApp deslinkeó este dispositivo. NO reintento. Corré `pnpm pair`."));
          return;
        }
        console.log(u(dim(`sync salió (code=${code} signal=${signal}) — respawn en ${backoff / 1000}s`)));
        setTimeout(() => startFollow(), backoff).unref();
      })();
    });
    proc.once("error", (err) => console.error(u(`sync spawn error: ${String(err)}`)));
  };

  const stopFollow = (): void => {
    followWanted = false;
    if (proc && !proc.killed) proc.kill("SIGTERM");
    proc = null;
  };

  // --- Sweeps per-usuario --------------------------------------------------------------------
  let sweeping = false;
  const embedSweep = async (): Promise<void> => {
    if (sweeping || closing || !store.vecEnabled) return;
    sweeping = true;
    try {
      const n = await embedMissing(store, { order: "desc", limit: 256 });
      if (n) console.log(u(dim(`[embed] +${n} vectores`)));
    } catch (e) {
      console.log(u(dim(`[embed] sweep error: ${(e as Error)?.message ?? e}`)));
    } finally {
      sweeping = false;
    }
  };
  const embedTimer = store.vecEnabled ? setInterval(() => void embedSweep(), 60_000) : null;
  embedTimer?.unref();

  let firing = false;
  const fireDueReminders = async (): Promise<void> => {
    if (firing || closing || !ownJid) return;
    firing = true;
    try {
      for (const r of store.dueReminders(Date.now())) {
        const body = r.action === "digest" ? await generateDigest(store) : `🤖 ⏰ ${r.text}`;
        try {
          const sent = await client.sendText(ownJid, body);
          if (sent.id) sentByMemu.add(sent.id);
          store.markFired(r.id, nextFire(r.fireAt, r.recurrence, Date.now()));
          console.log(u(dim(`[reminder] #${r.id} disparado (${r.action})`)));
        } catch (e) {
          console.log(u(dim(`[reminder] #${r.id} falló al enviar: ${(e as Error)?.message ?? e}`)));
        }
      }
    } finally {
      firing = false;
    }
  };
  // Los reminders/digests ahora los dispara el bot central (central-bot.ts), que le escribe a
  // cada usuario a su número. Acá NO se agendan (si no, saldrían duplicados).

  const selUntranscribed = store.db.prepare(
    "SELECT id FROM messages WHERE media_type IN ('audio','ptt') AND (text IS NULL OR text = '') AND revoked = 0 ORDER BY ts DESC LIMIT ?",
  );
  const sttTried = new Set<string>();
  let sttSweeping = false;
  const sttSweep = async (): Promise<void> => {
    if (sttSweeping || closing) return;
    sttSweeping = true;
    try {
      const cand = (selUntranscribed.all(30) as Array<{ id: string }>)
        .filter((r) => !sttTried.has(r.id))
        .slice(0, 4);
      let done = 0;
      for (const r of cand) {
        if (closing) break;
        const path = media.pathFor(r.id);
        if (!path) {
          sttTried.add(r.id);
          continue;
        }
        try {
          const t = await transcribe(path);
          if (t) {
            setMsgText.run(t, r.id);
            done++;
          } else {
            sttTried.add(r.id);
          }
        } catch (e) {
          sttTried.add(r.id);
          console.log(u(dim(`[stt] error ${r.id}: ${(e as Error)?.message ?? e}`)));
        }
      }
      if (done) console.log(u(dim(`[stt] +${done} transcripciones`)));
    } finally {
      sttSweeping = false;
    }
  };
  const sttTimer = setInterval(() => void sttSweep(), 90_000);
  sttTimer.unref();

  // Cap de media: poda los blobs más viejos si la carpeta del usuario supera MEMU_MEDIA_CAP_MB.
  // Los mensajes quedan; solo se van los archivos (ver media-cap.ts). Corre al arrancar + c/15min.
  const mediaDir = join(storeDir, "media");
  let mediaSweeping = false;
  const mediaCapSweep = (): void => {
    if (mediaSweeping || closing || MEDIA_CAP_BYTES <= 0) return;
    mediaSweeping = true;
    try {
      const r = pruneMediaDir(mediaDir, MEDIA_CAP_BYTES);
      if (r.deleted) {
        console.log(u(dim(`[media] podé ${r.deleted} archivos: ${mb(r.beforeBytes)}→${mb(r.afterBytes)}MB (cap ${mb(MEDIA_CAP_BYTES)}MB)`)));
      }
    } catch (e) {
      console.log(u(dim(`[media] cap error: ${(e as Error)?.message ?? e}`)));
    } finally {
      mediaSweeping = false;
    }
  };
  const mediaTimer = setInterval(mediaCapSweep, MEDIA_CAP_SWEEP_MS);
  mediaTimer.unref();
  mediaCapSweep(); // enforce al arrancar

  const close = (): void => {
    if (closing) return;
    closing = true;
    if (embedTimer) clearInterval(embedTimer);
    clearInterval(sttTimer);
    clearInterval(mediaTimer);
    clearInterval(archivedTimer);
    stopFollow();
    lidmap.close();
    media.close();
  };

  return { userId, ownJid, authenticated, handleWebhook, startFollow, stopFollow, close };
}
