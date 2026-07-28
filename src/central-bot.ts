// Bot central de Memu: la conexión ÚNICA (un número dedicado) por donde la gente conversa
// con Memu — reemplaza el self-chat. Recibe DMs, identifica al usuario por su TELÉFONO (remitente),
// corre su agente sobre SU memoria (su memu.db, alimentado por su companion link), y responde
// desde el número central. Los runtimes por-usuario siguen LEYENDO los chats de cada uno (el
// segundo cerebro); acá vive solo la CHARLA + los reminders/digests salientes.

import { type ChildProcess, spawn } from "node:child_process";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { askMemu, chatNames } from "./agent.ts";
import { portalUrl } from "./billing.ts";
import { cpProvision, cpStatus } from "./cp-client.ts";
import { generateDigest } from "./digest.ts";
import { type MemuMessage, normalizeForMemu } from "./ingest.ts";
import { openLidMap } from "./lidmap.ts";
import { openMediaIndex } from "./media.ts";
import { getRegistry } from "./registry.ts";
import { nextFire } from "./reminders.ts";
import { remMessage, runRem } from "./rem.ts";
import { getStore } from "./store.ts";
import { transcribe } from "./stt.ts";
import { synthesize } from "./tts.ts";
import { WacliClient } from "./wacli/wacli-client.ts";
import { isBroadcastJid, stripDeviceSuffix, type WacliWebhookMessage } from "./wacli/wacli-webhook-types.ts";

const CENTRAL_STORE = process.env.CENTRAL_WACLI_STORE ?? "./data/central/wacli";
// Loguear CONTENIDO (preguntas/respuestas) al journal. Default: NO — ver user-runtime.ts.
const LOG_CONTENT = process.env.MEMU_LOG_CONTENT === "1";
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const isAudioType = (t?: string): boolean => t === "audio" || t === "ptt";
const phoneOf = (jid: string): string => stripDeviceSuffix(jid).split("@")[0]!.replace(/\D/g, "");

// Onboarding in-chat.
const pairingMsg = (code: string): string =>
  "¡Listo el pago! 🎉 Ahora conectá tu WhatsApp:\n\n" +
  "1) Abrí WhatsApp → *Ajustes → Dispositivos vinculados*\n" +
  '2) Tocá *"Vincular un dispositivo"* → *"Vincular con número de teléfono"*\n' +
  `3) Ingresá este código: *${code}*\n\n` +
  "Cuando lo vincules, leo tu historial unos minutos y ya te respondo. 📚";

// --- Suscripción (Fase B, Stripe) ---
// El acceso lo da el estado de la suscripción: 'trialing' | 'active'. La cortesía/comp (dueño, testers,
// invitados) se hace con un cupón 100%-off en Stripe, que deja la sub en 'trialing'/'active' —
// indistinguible de un pago, sin allowlist en el env. Ver onboard() y scripts/stripe-comp-setup.mjs.
const subActive = (u: { subscriptionStatus: string | null } | null): boolean =>
  u?.subscriptionStatus === "trialing" || u?.subscriptionStatus === "active";

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
// Aviso de suscripción vencida (past_due): el link del portal se appendea aparte (para arreglar la
// tarjeta). Para usuarios activos que quieren gestionar/cancelar, eso lo maneja el AGENTE con la tool
// `gestionar_suscripcion` (tools.ts) — sin palabras clave.
const PAST_DUE_MSG =
  "Tu suscripción a Memu está vencida 😕 Suele ser un problema con la tarjeta. La actualizás o revisás tu plan acá:";

// --- Consentimiento de Términos + Privacidad (gate legal, ANTES del pago) -----------------------
// Antes de mandar el link de pago le pedimos al usuario nuevo que acepte los Términos y la Política
// de Privacidad, y lo dejamos REGISTRADO (append-only en registry.db, ver registry.ts). Bumpear esta
// versión cuando cambie la fecha de "Última actualización" de /terminos + /privacidad hace que los
// usuarios en el embudo (todavía sin pagar) tengan que volver a aceptar; los clientes ya existentes
// (con suscripción en Stripe) no se re-preguntan. Mantener en sync con app/(legal)/*/page.tsx.
const TERMS_VERSION = "2026-07-07";
const WEB = process.env.MEMU_WEB_URL ?? "https://memu.chat";
// Respuesta afirmativa a "¿aceptás?". Solo se evalúa DESPUÉS de haberle mostrado los términos, así
// que un "sí/dale/ok" acá es inequívocamente consentimiento a lo que le mostramos.
const ACCEPT_RE = /\b(acepto|acept[aá]s?|de acuerdo|confirmo)\b|^\s*(s[ií]|dale|ok(ay)?|listo)(?![\p{L}])/iu;
// Negación: nunca contar como consentimiento algo que trae un "no/nunca/rechazo…" (p.ej. "no acepto").
// Ante la duda, re-preguntamos (falso negativo) antes que registrar un consentimiento que no fue.
const NEGATE_RE = /\b(no|nunca|jam[aá]s|rechazo|niego|tampoco)\b/iu;
const isAcceptance = (text: string): boolean => ACCEPT_RE.test(text) && !NEGATE_RE.test(text);
const termsMsg = (): string =>
  "Antes de arrancar, un paso rápido 📄 Necesito que aceptes los *Términos del Servicio* y la " +
  "*Política de Privacidad* de Memu:\n\n" +
  `• Términos: ${WEB}/terminos\n` +
  `• Privacidad: ${WEB}/privacidad\n\n` +
  "En breve: Memu se vincula a tu WhatsApp como *dispositivo*, lee tus chats para armarte una memoria " +
  "y *nunca* le escribe a nadie por vos. Usar apps de terceros sobre WhatsApp puede ir contra las " +
  "reglas de Meta y, en algún caso, derivar en el bloqueo de tu cuenta — lo asumís vos.\n\n" +
  "Si estás de acuerdo, respondé *ACEPTO* y seguimos 🙌";
const TERMS_REPROMPT =
  "Para poder seguir necesito tu OK a los Términos y la Privacidad (memu.chat/terminos · memu.chat/privacidad). " +
  "Respondé por *texto* la palabra *ACEPTO* y arrancamos 🙌";
const TERMS_OK = "¡Genial! Quedó registrado tu consentimiento ✅";

// --- Fase de INDEXADO (post-pairing) ---
// Recién vinculado, el bot lee el historial antes de poder responder bien. Durante esa fase NO
// infiere: avisa que está leyendo y, cuando el índice está al día, avisa que ya está listo.
const INDEXING_START =
  "¡WhatsApp vinculado! 🎉 Ahora estoy leyendo tu historial para armar tu memoria — te aviso apenas termine (puede tardar unos minutos). 📚";
const INDEXING_WAIT =
  "Todavía estoy leyendo tu historial 📚 Ya casi — te aviso apenas pueda responderte bien 🙌";
const INDEXING_DONE =
  "¡Listo! 🧠 Ya leí tu historial. Preguntame lo que quieras — qué tenés pendiente, qué se dijo en algún grupo, lo que necesites.";

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
  /** DM desde el número central a un teléfono (E.164 sin +). Devuelve si pudo entregar. */
  sendToPhone(phone: string, text: string): Promise<boolean>;
  /** Avisa a un usuario que su companion se desvinculó y le manda un código fresco de re-pairing. */
  notifyRelink(phone: string): Promise<void>;
  startFollow(): void;
  stopFollow(): void;
  close(): void;
}

export interface CentralBotOptions {
  webhookUrl: string; // …/wacli/central
  webhookSecret: string;
  wacliBin: string;
  /** Se llama UNA vez cuando el NÚMERO CENTRAL quedó desvinculado/baneado (detectado al morir el
   *  follow o por el watchdog). El orquestador alerta al admin por el canal de fallback (su
   *  companion → self-chat), porque este número ya no puede mandar nada. */
  onDeslink?: () => void;
}

export async function createCentralBot(opts: CentralBotOptions): Promise<CentralBot> {
  const { webhookUrl, webhookSecret, wacliBin, onDeslink } = opts;
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
  const paymentPromptAt = new Map<string, number>(); // último reenvío del link de pago/portal (throttle)
  const termsPromptAt = new Map<string, number>(); // último reenvío del gate de términos (throttle)
  const provisioning = new Set<string>(); // teléfonos con un /provision en vuelo (anti-doble-pairing)
  const indexingReplyAt = new Map<string, number>(); // throttle del aviso "todavía leyendo"

  // Envía texto desde el central marcándolo como propio (para no re-procesarlo por el follow).
  const sendBot = (jid: string, text: string): Promise<void> =>
    client
      .sendText(jid, text)
      .then((r) => { if (r.id) sentByMemu.add(r.id); })
      .catch(() => {});

  const sendToPhone = async (phone: string, text: string): Promise<boolean> => {
    try {
      const r = await client.sendText(`${phone}@s.whatsapp.net`, text);
      if (r.id) sentByMemu.add(r.id);
      return true;
    } catch {
      return false;
    }
  };

  // Re-vinculación tras un deslink del companion: aviso + código fresco (cpProvision es idempotente).
  // El orquestador ya bajó al usuario a 'pending', así que si el código caduca, su próximo mensaje
  // cae en onboard() y recibe otro. Ver index.ts (handleUserDeslink).
  const RELINK_INTRO =
    "Ojo 👀 tu WhatsApp se desvinculó de Memu, así que dejé de leer tus chats (tu memoria queda " +
    "congelada hasta reconectar). Se arregla en 1 minuto:";
  const RELINK_FALLBACK = `${RELINK_INTRO}\n\nEscribime cualquier cosa y te mando un código nuevo 📲`;
  const relinkMsg = (code: string): string =>
    `${RELINK_INTRO}\n\n` +
    "1) Abrí WhatsApp → *Ajustes → Dispositivos vinculados*\n" +
    '2) Tocá *"Vincular un dispositivo"* → *"Vincular con número de teléfono"*\n' +
    `3) Ingresá este código: *${code}*`;
  const notifyRelink = async (phone: string): Promise<void> => {
    try {
      const res = await cpProvision(phone);
      await sendToPhone(phone, res.code ? relinkMsg(res.code) : RELINK_FALLBACK);
      console.log(dim(`[bot] relink ${phone} → ${res.status}${res.code ? " (código)" : ""}`));
    } catch (e) {
      console.log(dim(`[bot] relink ${phone} falló: ${(e as Error)?.message ?? e}`));
      await sendToPhone(phone, RELINK_FALLBACK);
    }
  };
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
          console.log(
            dim(
              LOG_CONTENT
                ? `[bot] u${userId} ← "${question.slice(0, 40)}" → "${ans.slice(0, 40)}"`
                : `[bot] u${userId} ← «${question.length} chars» → «${ans.length} chars»`,
            ),
          );
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
  // está activo+suscripto todavía. Ramas: (1) sin suscripción vigente → link de pago (o aviso de vencido);
  // (2) suscripción OK pero sin vincular → dispara el pairing (idempotente) y manda el código. La
  // inferencia se habilita recién cuando el pairing conecta (status → 'active'). Ver onboarding-y-stripe.md.
  const PROMPT_THROTTLE_MS = 60_000; // no reenviar el mismo prompt más seguido que esto

  // Gate de consentimiento: antes de mandar el link de pago, el usuario nuevo tiene que aceptar los
  // Términos + Privacidad, y queda registrado (append-only). Devuelve true si el consentimiento ya
  // está OK y se puede seguir con el onboarding; false si todavía estamos esperando la aceptación
  // (ya mandamos/reenviamos el prompt). `text` es el mensaje entrante (para detectar la aceptación).
  const ensureTerms = async (phone: string, chatJid: string, text: string): Promise<boolean> => {
    if (registry.hasAcceptedTerms(phone, TERMS_VERSION)) return true;
    // Solo interpretamos la respuesta como aceptación si YA le mostramos los términos (así el primer
    // mensaje —que puede traer un "ok/dale" casual— nunca cuenta como consentimiento sin haberlos visto).
    if (registry.wasPromptedTerms(phone, TERMS_VERSION) && isAcceptance(text)) {
      registry.recordTermsAcceptance(phone, TERMS_VERSION, text.slice(0, 500));
      await sendBot(chatJid, TERMS_OK);
      console.log(dim(`[bot] términos aceptados por ${phone} (v${TERMS_VERSION})`));
      return true;
    }
    const already = registry.wasPromptedTerms(phone, TERMS_VERSION);
    const last = termsPromptAt.get(phone) ?? 0;
    if (Date.now() - last < PROMPT_THROTTLE_MS) return false;
    termsPromptAt.set(phone, Date.now());
    registry.recordTermsPrompt(phone, TERMS_VERSION);
    await sendBot(chatJid, already ? TERMS_REPROMPT : termsMsg());
    return false;
  };

  const onboard = async (phone: string, chatJid: string, text: string): Promise<void> => {
    const user = registry.getUserByPhone(phone);
    // Consentimiento primero (queda registrado). Si todavía no aceptó, cortamos acá: no mostramos el
    // link de pago ni disparamos el pairing hasta tener el OK a los Términos + Privacidad. Los que ya
    // pasaron por Stripe (stripeCustomerId) no se re-preguntan: un past_due que arregla la tarjeta no
    // debe toparse con el gate. Los usuarios nuevos reciben el customerId recién al pagar (post-gate).
    if (!user?.stripeCustomerId && !(await ensureTerms(phone, chatJid, text))) return;

    const paid = subActive(user);

    if (!paid) {
      // Sin keyword: el link se (re)manda solo cuando el usuario escribe y no está suscripto, pero
      // throttleado (evita spam si manda varios mensajes seguidos). past_due = la sub existe pero
      // falla el cobro → portal para arreglar la tarjeta; nuevo/cancelado → link de pago (alta).
      const last = paymentPromptAt.get(phone) ?? 0;
      if (Date.now() - last < PROMPT_THROTTLE_MS) return;
      paymentPromptAt.set(phone, Date.now());
      if (user?.subscriptionStatus === "past_due" && user.stripeCustomerId) {
        const url = await portalUrl(user.stripeCustomerId);
        await sendBot(chatJid, url ? `${PAST_DUE_MSG}\n👉 ${url}` : PAST_DUE_MSG);
      } else {
        await sendBot(chatJid, paymentMsg(phone));
      }
      return;
    }

    // Con suscripción vigente pero sin vincular → asegurar el pairing y mandar el código. cpProvision
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

    const user = registry.getUserByPhone(phone);
    // Gate de inferencia: solo hablan con el agente los usuarios ACTIVOS (pairing conectado) con
    // suscripción vigente ('trialing'/'active'). El resto entra al onboarding in-chat (pago → pairing →
    // código). Una suscripción vencida corta la inferencia aunque siga vinculado. Ver onboard(). La
    // autogestión (cambiar tarjeta / cancelar) de un usuario activo la maneja el agente con la tool
    // gestionar_suscripcion — no hay keyword acá.
    if (!user || user.status !== "active" || !subActive(user)) {
      void onboard(phone, m.chatJid, m.text.trim());
      return;
    }
    // Fase de INDEXADO: vinculado pero todavía leyendo el historial → no inferir, avisar (throttle).
    if (user.onboardingState === "indexando") {
      const last = indexingReplyAt.get(phone) ?? 0;
      if (Date.now() - last > 25_000) {
        indexingReplyAt.set(phone, Date.now());
        void sendBot(m.chatJid, INDEXING_WAIT);
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

  // --- REM: consolidación nocturna (rem.ts) --------------------------------------------------
  // Una vez por día, a las REM_HOUR (hora local de la persona; el server corre en UTC), repasa lo
  // nuevo de los chats de cada usuario buscando compromisos y le propone tareas. Silencioso si no
  // encuentra nada. Si el proceso estaba caído a esa hora, la corrida se recupera al arrancar
  // (rem_last_run < último disparo agendado).
  const REM_HOUR = Number(process.env.MEMU_REM_HOUR ?? 4);
  const REM_UTC_OFFSET = Number(process.env.MEMU_REM_UTC_OFFSET ?? -3); // UY/AR
  const REM_RETRY_MS = 30 * 60_000; // backoff si una corrida falla (ej. LLM caído)
  const remAttemptAt = new Map<string, number>();
  let remRunning = false;

  // Último disparo agendado: hoy a las REM_HOUR locales (o ayer, si hoy todavía no llegó).
  const lastScheduledRem = (nowMs: number): number => {
    const d = new Date(nowMs);
    let run = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), REM_HOUR - REM_UTC_OFFSET);
    if (run > nowMs) run -= 86_400_000;
    return run;
  };

  const remSweep = async (): Promise<void> => {
    if (remRunning || closing) return;
    remRunning = true;
    try {
      const due = lastScheduledRem(Date.now());
      for (const user of registry.listUsers({ status: "active" })) {
        if (closing) break;
        if (!user.phone) continue;
        const uid = String(user.id);
        const store = getStore(uid);
        if (Number(store.getState("rem_last_run") ?? 0) >= due) continue; // ya corrió este ciclo
        if (Date.now() - (remAttemptAt.get(uid) ?? 0) < REM_RETRY_MS) continue; // falló hace poco
        remAttemptAt.set(uid, Date.now());
        try {
          const names = chatNames(uid);
          const res = await runRem(store, names, { excludeJids: botIds });
          store.setState("rem_last_run", String(Date.now()));
          if (res.suggestions.length) {
            const body = remMessage(res.suggestions, names);
            const sent = await client.sendText(`${user.phone}@s.whatsapp.net`, body);
            if (sent.id) sentByMemu.add(sent.id);
            store.appendTurn("assistant", body); // el agente tiene que "saber" que propuso esto
          }
          console.log(
            dim(
              `[bot] REM u${uid}: ${res.baseline ? "línea de base fijada" : `${res.scanned} nuevos · ${res.judged} chats · ${res.suggestions.length} sugerencias`}`,
            ),
          );
        } catch (e) {
          console.log(dim(`[bot] REM u${uid} falló (reintento en 30min): ${(e as Error)?.message ?? e}`));
        }
      }
    } finally {
      remRunning = false;
    }
  };
  const remTimer = setInterval(() => void remSweep(), 60_000);
  remTimer.unref();

  // --- Fase de indexado: avisar "leyendo" al entrar, y "listo" cuando el índice está al día ---
  const indexNotified = new Set<string>(); // ya mandamos el aviso proactivo "estoy leyendo"
  const readyStreak = new Map<string, number>(); // ticks consecutivos con el índice al día (anti-race)
  const advanceOnboarding = (): void => {
    if (closing) return;
    for (const user of registry.listUsers()) {
      if (user.onboardingState !== "indexando" || !user.phone) continue;
      const uid = String(user.id);
      const to = `${user.phone}@s.whatsapp.net`;
      // Aviso proactivo una sola vez, apenas entra a la fase (recién vinculado).
      if (!indexNotified.has(uid)) {
        indexNotified.add(uid);
        void sendBot(to, INDEXING_START);
      }
      // Listo = historial importado (count>0) y sin backlog de embeddings, estable 2 ticks seguidos.
      let ready = false;
      try {
        const store = getStore(uid);
        ready = store.count() > 0 && store.pendingEmbeddings() === 0;
      } catch {
        ready = false;
      }
      const streak = ready ? (readyStreak.get(uid) ?? 0) + 1 : 0;
      readyStreak.set(uid, streak);
      if (streak >= 2) {
        registry.setOnboardingState(user.id, "activo");
        readyStreak.delete(uid);
        indexNotified.delete(uid);
        void sendBot(to, INDEXING_DONE);
        console.log(dim(`[bot] u${uid} indexado al día → activo`));
      }
    }
  };
  const onboardingTimer = setInterval(() => advanceOnboarding(), 20_000);
  onboardingTimer.unref();

  // --- Deslink/ban del NÚMERO CENTRAL: el peor caso (nadie puede chatear con Memu) -----------
  // Se detecta en dos puntos: al morir el follow (abajo) y por un watchdog periódico (cubre el
  // caso en que el follow sigue vivo pero la sesión quedó deslogueada). `onDeslink` dispara la
  // alerta al admin por el canal de fallback. Si alguien re-parea el central, el watchdog lo ve
  // y retoma el follow solo.
  let deslinked = false;
  const handleDeslink = (): void => {
    if (deslinked || closing) return;
    deslinked = true;
    console.error("[bot] 🚨 el número central quedó DESVINCULADO (¿ban?). No reintento el follow.");
    onDeslink?.();
  };
  const watchdog = async (): Promise<void> => {
    if (closing) return;
    const st = await client.authStatus().catch(() => null);
    if (!st) return; // no pude consultar → no sé nada, no alarmo
    if (!st.authenticated) {
      stopFollow();
      handleDeslink();
    } else if (deslinked) {
      deslinked = false;
      console.log("[bot] ✅ central re-pareado — retomo el follow");
      startFollow();
    }
  };
  const watchdogTimer = setInterval(() => void watchdog(), 600_000); // 10 min
  watchdogTimer.unref();

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
      void (async () => {
        // ¿Nos deslinkearon/banearon? Reconectar no sirve → cortar y alertar (no respawnear).
        const st = await client.authStatus().catch(() => null);
        if (st && !st.authenticated) {
          handleDeslink();
          return;
        }
        console.log(dim(`[bot] follow central salió (code=${code} signal=${signal}) — respawn en ${backoff / 1000}s`));
        setTimeout(() => startFollow(), backoff).unref();
      })();
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
    clearInterval(remTimer);
    clearInterval(onboardingTimer);
    clearInterval(watchdogTimer);
    stopFollow();
    lidmap.close();
    media.close();
  };

  return { handleWebhook, sendToPhone, notifyRelink, startFollow, stopFollow, close };
}
