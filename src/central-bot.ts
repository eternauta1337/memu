// Bot central de Memo: la conexión ÚNICA (número dedicado, ex-Proyecto-interno) por donde la gente conversa
// con Memo — reemplaza el self-chat. Recibe DMs, identifica al usuario por su TELÉFONO (remitente),
// corre su agente sobre SU memoria (su memo.db, alimentado por su companion link), y responde
// desde el número central. Los runtimes por-usuario siguen LEYENDO los chats de cada uno (el
// segundo cerebro); acá vive solo la CHARLA + los reminders/digests salientes.

import { type ChildProcess, spawn } from "node:child_process";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { askMemo } from "./agent.ts";
import { generateDigest } from "./digest.ts";
import { type MemoMessage, normalizeForMemo } from "./ingest.ts";
import { openLidMap } from "./lidmap.ts";
import { openMediaIndex } from "./media.ts";
import { getRegistry } from "./registry.ts";
import { nextFire } from "./reminders.ts";
import { getStore } from "./store.ts";
import { transcribe } from "./stt.ts";
import { synthesize } from "./tts.ts";
import { WacliClient } from "./wacli/wacli-client.ts";
import { isBroadcastJid, stripDeviceSuffix, type WacliWebhookMessage } from "./wacli/wacli-webhook-types.ts";

const CENTRAL_STORE = process.env.CENTRAL_WACLI_STORE ?? "./data/central/wacli";
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const isAudioType = (t?: string): boolean => t === "audio" || t === "ptt";
const phoneOf = (jid: string): string => stripDeviceSuffix(jid).split("@")[0]!.replace(/\D/g, "");

// Modalidad-espejo (igual que antes): audio→audio, texto→texto, salvo pedido explícito.
const WANT_TEXT = /\b(en|por)\s+(texto|escrito)\b|escrib(i|í|ime|irme|ir)|nada de audio|no.*(audio|voz)/i;
const WANT_AUDIO = /\b(en|por|con)\s+(audio|voz)\b|nota de voz|mand[aá](me)?\s+(un\s+)?audio|habl[aá]me|contest[aá](me)?\s+(hablando|con audio)/i;
function detectReplyMode(text: string, inputAudio: boolean): "audio" | "text" {
  if (WANT_TEXT.test(text)) return "text";
  if (WANT_AUDIO.test(text)) return "audio";
  return inputAudio ? "audio" : "text";
}

export interface CentralBot {
  handleWebhook(raw: WacliWebhookMessage): void;
  startFollow(): void;
  stopFollow(): void;
  close(): void;
}

export interface CentralBotOptions {
  webhookUrl: string; // …/wacli/central
  webhookSecret: string;
  wacliBin: string;
}

export async function createCentralBot(opts: CentralBotOptions): Promise<CentralBot> {
  const { webhookUrl, webhookSecret, wacliBin } = opts;
  const registry = getRegistry();
  const client = new WacliClient({ bin: wacliBin, store: CENTRAL_STORE });

  const status = await client.authStatus().catch((e: Error) => {
    console.error(`[bot] no pude consultar auth status: ${e.message}`);
    return null;
  });
  const botJid = status?.linked_jid ?? status?.jid ?? null;
  if (!status?.authenticated || !botJid) {
    console.error("[bot] número central NO pareado — corré el pairing del bot central.");
  } else {
    console.log(`[bot] central pareado como ${botJid}${status.phone ? ` (+${status.phone})` : ""}`);
  }

  const lidmap = openLidMap(CENTRAL_STORE);
  const resolve = lidmap.resolve;
  const media = openMediaIndex(CENTRAL_STORE);
  const botIds = new Set<string>();
  if (botJid) botIds.add(resolve(stripDeviceSuffix(botJid)));
  if (status?.phone) botIds.add(`${status.phone}@s.whatsapp.net`);

  const sentByMemo = new Set<string>();
  const unknownGreeted = new Set<string>(); // para no spamear al remitente no habilitado
  const queue: Array<{ userId: string; chatJid: string; m: MemoMessage }> = [];
  let working = false;
  let closing = false;

  const waitForMedia = async (id: string): Promise<string | null> => {
    for (let i = 0; i < 6; i++) {
      const p = media.pathFor(id);
      if (p) return p;
      await sleep(1000);
    }
    return null;
  };

  const setMsgTextFor = (userId: string, text: string, id: string): void => {
    // Guarda la transcripción en el memo.db del usuario (queda buscable).
    try {
      getStore(userId).db.prepare("UPDATE messages SET text = ? WHERE id = ?").run(text, id);
    } catch {
      /* si el mensaje no está en su store aún, no pasa nada */
    }
  };

  const drain = async (): Promise<void> => {
    if (working) return;
    working = true;
    try {
      while (queue.length) {
        const { userId, chatJid, m } = queue.shift()!;
        let thinking = true;
        const pulse = () => client.presence(chatJid, "typing").catch(() => {});
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
              if (question) setMsgTextFor(userId, question, m.id);
            }
          }
          if (!question) {
            await client.sendText(chatJid, "No pude entender el audio 🫤").catch(() => {});
            continue;
          }
          const mode = detectReplyMode(question, inputAudio);
          const ans = (await askMemo(getStore(userId), question, { voice: mode === "audio" })).trim();
          if (!ans) continue;

          if (mode === "audio") {
            const out = join(CENTRAL_STORE, `../tts-${Date.now()}.ogg`);
            try {
              await synthesize(ans, out);
              const r = await client.sendVoice(chatJid, out);
              if (r.id) sentByMemo.add(r.id);
            } catch {
              const r = await client.sendText(chatJid, ans);
              if (r.id) sentByMemo.add(r.id);
            } finally {
              await unlink(out).catch(() => {});
            }
          } else {
            const r = await client.sendText(chatJid, ans);
            if (r.id) sentByMemo.add(r.id);
          }
          console.log(dim(`[bot] u${userId} ← "${question.slice(0, 40)}" → "${ans.slice(0, 40)}"`));
        } catch (e) {
          console.log(dim(`[bot] error respondiendo a u${userId}: ${(e as Error)?.message ?? e}`));
          await client.sendText(chatJid, "Uf, algo falló procesando eso 🫤").catch(() => {});
        } finally {
          thinking = false;
          clearInterval(typingTimer);
          void client.presence(chatJid, "paused").catch(() => {});
        }
      }
    } finally {
      working = false;
    }
  };

  const handleWebhook = (raw: WacliWebhookMessage): void => {
    if (raw.FromMe && raw.SenderJID) botIds.add(resolve(stripDeviceSuffix(raw.SenderJID)));
    const m = normalizeForMemo(raw, botIds, resolve);
    // Solo DMs entrantes de personas: nada de grupos, difusiones, self, propios, reacciones, borrados.
    if (isBroadcastJid(m.chatJid) || m.chatKind !== "dm" || m.fromMe || m.revoked || m.reactionEmoji) return;
    if (sentByMemo.has(m.id)) return;
    const hasContent = Boolean(m.text.trim()) || isAudioType(m.mediaType);
    if (!hasContent) return;

    const phone = phoneOf(m.chatJid);
    const user = registry.getUserByPhone(phone);
    if (!user || user.status !== "active") {
      // Remitente no habilitado → saludo único, sin spamear.
      if (!unknownGreeted.has(phone)) {
        unknownGreeted.add(phone);
        void client
          .sendText(m.chatJid, "¡Hola! 👋 Todavía no estás habilitado en Memo. Registrate en https://host-web.ejemplo.com y activá tu WhatsApp.")
          .catch(() => {});
      }
      return;
    }
    registry.touchActive(user.id);
    queue.push({ userId: String(user.id), chatJid: m.chatJid, m });
    void drain();
  };

  // --- Reminders / digests salientes: por cada usuario activo, disparar los vencidos al central ---
  let firing = false;
  const fireDueReminders = async (): Promise<void> => {
    if (firing || closing) return;
    firing = true;
    try {
      for (const user of registry.listUsers({ status: "active" })) {
        if (!user.phone) continue;
        const store = getStore(String(user.id));
        const due = store.dueReminders(Date.now());
        if (!due.length) continue;
        const to = `${user.phone}@s.whatsapp.net`;
        for (const r of due) {
          const body = r.action === "digest" ? await generateDigest(store) : `⏰ ${r.text}`;
          try {
            const sent = await client.sendText(to, body);
            if (sent.id) sentByMemo.add(sent.id);
            store.markFired(r.id, nextFire(r.fireAt, r.recurrence, Date.now()));
            console.log(dim(`[bot] reminder #${r.id} → u${user.id} (${r.action})`));
          } catch (e) {
            console.log(dim(`[bot] reminder #${r.id} u${user.id} falló: ${(e as Error)?.message ?? e}`));
          }
        }
      }
    } finally {
      firing = false;
    }
  };
  const reminderTimer = setInterval(() => void fireDueReminders(), 30_000);
  reminderTimer.unref();

  // --- Follow del store central (con backoff, igual que los per-user) ---
  let proc: ChildProcess | null = null;
  let followWanted = false;
  const MIN_BACKOFF = 2000;
  const MAX_BACKOFF = 60_000;
  let backoff = MIN_BACKOFF;
  const startFollow = (): void => {
    if (closing || proc || !status?.authenticated) return;
    followWanted = true;
    const args = [
      "sync", "--follow", "--download-media",
      "--store", CENTRAL_STORE,
      "--webhook", webhookUrl,
      "--webhook-secret", webhookSecret,
      "--webhook-allow-private",
    ];
    console.log(dim("[bot] wacli sync --follow (central) → webhook"));
    const startedAt = Date.now();
    proc = spawn(wacliBin, args, { stdio: ["ignore", "inherit", "inherit"], env: process.env });
    proc.once("exit", (code, signal) => {
      proc = null;
      if (closing || !followWanted) return;
      backoff = Date.now() - startedAt > 60_000 ? MIN_BACKOFF : Math.min(backoff * 2, MAX_BACKOFF);
      console.log(dim(`[bot] follow central salió (code=${code} signal=${signal}) — respawn en ${backoff / 1000}s`));
      setTimeout(() => startFollow(), backoff).unref();
    });
    proc.once("error", (err) => console.error(`[bot] follow spawn error: ${String(err)}`));
  };
  const stopFollow = (): void => {
    followWanted = false;
    if (proc && !proc.killed) proc.kill("SIGTERM");
    proc = null;
  };

  const close = (): void => {
    if (closing) return;
    closing = true;
    clearInterval(reminderTimer);
    stopFollow();
    lidmap.close();
    media.close();
  };

  return { handleWebhook, startFollow, stopFollow, close };
}
