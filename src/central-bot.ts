// Bot central de Memu: la conexión ÚNICA (número dedicado, ex-Proyecto-interno) por donde la gente conversa
// con Memu — reemplaza el self-chat. Recibe DMs, identifica al usuario por su TELÉFONO (remitente),
// corre su agente sobre SU memoria (su memu.db, alimentado por su companion link), y responde
// desde el número central. Los runtimes por-usuario siguen LEYENDO los chats de cada uno (el
// segundo cerebro); acá vive solo la CHARLA + los reminders/digests salientes.

import { type ChildProcess, spawn } from "node:child_process";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { askMemu } from "./agent.ts";
import { cpProvision, cpStatus } from "./cp-client.ts";
import { generateDigest } from "./digest.ts";
import { type MemuMessage, normalizeForMemu } from "./ingest.ts";
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

// Gate temporal de Fase A (sin Stripe): allowlist por teléfono (dígitos, coma-separados). Vacío =
// abierto a todos. En Fase B lo reemplaza el estado de suscripción. Mismo criterio que la web.
const ALLOWLIST = (process.env.MEMU_ALLOWLIST ?? "")
  .split(",")
  .map((s) => s.replace(/\D/g, ""))
  .filter(Boolean);
const phoneAllowed = (phone: string): boolean => ALLOWLIST.length === 0 || ALLOWLIST.includes(phone);

// Onboarding in-chat. Ver <doc interno>.
const pairingMsg = (code: string): string =>
  "¡Listo el pago! 🎉 Ahora conectá tu WhatsApp:\n\n" +
  "1) Abrí WhatsApp → *Ajustes → Dispositivos vinculados*\n" +
  '2) Tocá *"Vincular un dispositivo"* → *"Vincular con número de teléfono"*\n' +
  `3) Ingresá este código: *${code}*\n\n` +
  "Cuando lo vincules, leo tu historial unos minutos y ya te respondo. 📚";

// --- Suscripción (Fase B, Stripe) ---
// El acceso lo dan los estados 'trialing' | 'active'. La allowlist queda como lista de CORTESÍA
// (bypass de pago para el dueño + testers). eligible = comp (allowlist) o suscripción vigente.
const subActive = (u: { subscriptionStatus: string | null } | null): boolean =>
  u?.subscriptionStatus === "trialing" || u?.subscriptionStatus === "active";
const isEligible = (phone: string, u: { subscriptionStatus: string | null } | null): boolean =>
  phoneAllowed(phone) || subActive(u);

const LINK_MONTHLY = process.env.STRIPE_LINK_MONTHLY ?? "";
const LINK_YEARLY = process.env.STRIPE_LINK_YEARLY ?? "";
// Payment Links de Stripe aceptan ?client_reference_id= — así el webhook sabe qué teléfono pagó.
const withRef = (link: string, phone: string): string =>
  link ? `${link}${link.includes("?") ? "&" : "?"}client_reference_id=${encodeURIComponent(phone)}` : "";
const paymentMsg = (phone: string): string => {
  const lines = [
    "¡Bienvenido/a a Memu! 🧠 Soy tu segundo cerebro adentro de WhatsApp.",
    "",
    "Para arrancar, elegí tu plan (7 días gratis — no se te cobra hasta el día 8):",
  ];
  if (LINK_MONTHLY) lines.push(`• *Mensual* (USD 9): ${withRef(LINK_MONTHLY, phone)}`);
  if (LINK_YEARLY) lines.push(`• *Anual* (USD 90, 2 meses gratis): ${withRef(LINK_YEARLY, phone)}`);
  lines.push("", "Apenas confirmes, te paso el código para vincular tu WhatsApp. 📲");
  return lines.join("\n");
};
const PAST_DUE_MSG =
  "Tu suscripción a Memu está vencida 😕 Renovala para seguir usándome y te reactivo al toque. Escribime *pagar* y te paso el link.";

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

  const sentByMemu = new Set<string>();
  const unknownGreeted = new Set<string>(); // para no spamear al remitente en lista de espera
  const provisioning = new Set<string>(); // teléfonos con un /provision en vuelo (anti-doble-pairing)

  // Envía texto desde el central marcándolo como propio (para no re-procesarlo por el follow).
  const sendBot = (jid: string, text: string): Promise<void> =>
    client
      .sendText(jid, text)
      .then((r) => { if (r.id) sentByMemu.add(r.id); })
      .catch(() => {});
  const queue: Array<{ userId: string; chatJid: string; m: MemuMessage }> = [];
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
    // Guarda la transcripción en el memu.db del usuario (queda buscable).
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
          const ans = (await askMemu(getStore(userId), question, { voice: mode === "audio" })).trim();
          if (!ans) continue;

          if (mode === "audio") {
            const out = join(CENTRAL_STORE, `../tts-${Date.now()}.ogg`);
            try {
              await synthesize(ans, out);
              const r = await client.sendVoice(chatJid, out);
              if (r.id) sentByMemu.add(r.id);
            } catch {
              const r = await client.sendText(chatJid, ans);
              if (r.id) sentByMemu.add(r.id);
            } finally {
              await unlink(out).catch(() => {});
            }
          } else {
            const r = await client.sendText(chatJid, ans);
            if (r.id) sentByMemu.add(r.id);
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

  // Onboarding in-chat (Fase B): máquina de estados derivada de (suscripción, status). El usuario NO
  // está activo+elegible todavía. Ramas: (1) sin pago ni cortesía → link de pago (o aviso de vencido);
  // (2) pago/cortesía OK pero sin vincular → dispara el pairing (idempotente) y manda el código. La
  // inferencia se habilita recién cuando el pairing conecta (status → 'active'). Ver onboarding-y-stripe.md.
  const WANT_PAY = /\b(pagar|pago|suscri\w*|plan(es)?|precio|comprar)\b/i;
  const onboard = async (phone: string, chatJid: string, text: string): Promise<void> => {
    const user = registry.getUserByPhone(phone);
    const paid = phoneAllowed(phone) || subActive(user);

    if (!paid) {
      // Suscripción vencida/cancelada → aviso de renovación (salvo que pidan el link explícito).
      const lapsed = user?.subscriptionStatus === "past_due" || user?.subscriptionStatus === "canceled";
      if (WANT_PAY.test(text)) {
        await sendBot(chatJid, paymentMsg(phone)); // re-mandar el link a pedido
      } else if (lapsed) {
        await sendBot(chatJid, PAST_DUE_MSG);
      } else if (!unknownGreeted.has(phone)) {
        unknownGreeted.add(phone);
        await sendBot(chatJid, paymentMsg(phone)); // saludo + link, una sola vez
      }
      return;
    }

    // Pagó (o es cortesía) pero no está vinculado → asegurar el pairing y mandar el código. cpProvision
    // es idempotente (no re-spawnea si ya hay un job en curso), así que sirve tanto para el primer
    // disparo como para reenviar el código en mensajes siguientes.
    if (provisioning.has(phone)) return;
    provisioning.add(phone);
    try {
      const res = await cpProvision(phone);
      if (res.code) await sendBot(chatJid, pairingMsg(res.code));
      else if (res.status === "connected") await sendBot(chatJid, "¡Ya estás vinculado! Escribime lo que quieras 😄");
      else await sendBot(chatJid, "Estoy generando tu código de vinculación 🙏 Escribime de nuevo en un ratito.");
      console.log(dim(`[bot] onboard ${phone} → ${res.status}${res.code ? " (código)" : ""}`));
    } catch (e) {
      console.log(dim(`[bot] onboard ${phone} falló: ${(e as Error)?.message ?? e}`));
      await sendBot(chatJid, "Uf, no pude arrancar la vinculación 🫤 Probá de nuevo en un minuto.");
    } finally {
      provisioning.delete(phone);
    }
  };

  const handleWebhook = (raw: WacliWebhookMessage): void => {
    if (raw.FromMe && raw.SenderJID) botIds.add(resolve(stripDeviceSuffix(raw.SenderJID)));
    const m = normalizeForMemu(raw, botIds, resolve);
    // Solo DMs entrantes de personas: nada de grupos, difusiones, self, propios, reacciones, borrados.
    if (isBroadcastJid(m.chatJid) || m.chatKind !== "dm" || m.fromMe || m.revoked || m.reactionEmoji) return;
    if (sentByMemu.has(m.id)) return;
    const hasContent = Boolean(m.text.trim()) || isAudioType(m.mediaType);
    if (!hasContent) return;

    const phone = phoneOf(m.chatJid);

    // ¿Es un token de login por WhatsApp? (el usuario lo generó en la web y lo mandó acá). Al ser
    // iniciado por el usuario NO hay riesgo de spam/ban. Verifica (crea el usuario si es nuevo →
    // signup) y corta, sin rutearlo al agente.
    const maybeToken = m.text.trim().toUpperCase();
    if (/^MEMU-[A-Z0-9]{6}$/.test(maybeToken)) {
      const userId = registry.verifyLogin(maybeToken, phone);
      const reply = userId
        ? "✅ ¡Listo! Verificaste tu WhatsApp. Volvé a la web para continuar."
        : "Ese código de acceso no es válido o expiró 🫤 Generá uno nuevo en la web.";
      void client
        .sendText(m.chatJid, reply)
        .then((r) => { if (r.id) sentByMemu.add(r.id); })
        .catch(() => {});
      console.log(dim(`[bot] login ${maybeToken} ${userId ? `→ u${userId}` : "inválido"}`));
      return;
    }

    const user = registry.getUserByPhone(phone);
    // Gate de inferencia: solo hablan con el agente los usuarios ACTIVOS (pairing conectado) Y
    // elegibles (suscripción vigente o cortesía). El resto entra al onboarding in-chat (pago →
    // pairing → código). Una suscripción vencida corta la inferencia aunque siga vinculado. Ver onboard().
    if (!user || user.status !== "active" || !isEligible(phone, user)) {
      void onboard(phone, m.chatJid, m.text);
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
            if (sent.id) sentByMemu.add(sent.id);
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
