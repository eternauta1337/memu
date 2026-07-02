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
import { askMemo } from "./agent.ts";
import { generateDigest } from "./digest.ts";
import { normalizeForMemo } from "./ingest.ts";
import { embedMissing } from "./indexer.ts";
import { openLidMap } from "./lidmap.ts";
import { nextFire } from "./reminders.ts";
import { openStore } from "./store.ts";
import { WacliClient } from "./wacli/wacli-client.ts";
import { WacliWebhookServer } from "./wacli/wacli-webhook-server.ts";
import { stripDeviceSuffix } from "./wacli/wacli-webhook-types.ts";

const WACLI_BIN = process.env.WACLI_BIN ?? "wacli";
const STORE = process.env.WACLI_STORE ?? "./data/wacli";
const DB = process.env.MEMO_DB ?? "./data/memo.db";
const MEMO_PREFIX = "🤖 "; // marca los mensajes de Memo en el self-chat (todos van a la derecha)
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

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

  const store = openStore(DB);
  console.log(dim(`store: ${DB} (${store.count()} mensajes ya guardados)`));

  // Mapa LID↔teléfono (whatsmeow, read-only): canonicaliza los `@lid` vivos a JID de teléfono
  // para que matcheen el histórico y los nombres (ver lidmap.ts).
  const lidmap = openLidMap(STORE);
  const resolve = lidmap.resolve;

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
  const queue: string[] = [];
  let answering = false;
  const answerInSelfChat = async (): Promise<void> => {
    if (answering || !ownJid) return;
    answering = true;
    try {
      while (queue.length) {
        const q = queue.shift() as string;
        // Ack "pensando…": indicador de typing nativo mientras gemma procesa (puede tardar varios
        // segundos con varias rondas de tools). WhatsApp expira el composing → lo refrescamos.
        let thinking = true;
        const pulse = () => client.presence(ownJid, "typing").catch(() => {});
        void pulse();
        const typingTimer = setInterval(() => thinking && void pulse(), 5000);
        typingTimer.unref();
        try {
          const ans = (await askMemo(store, q)).trim();
          if (ans) {
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
    const saved = store.save(m);
    const tag = m.chatKind === "self" ? "🧠SELF" : m.chatKind === "group" ? "👥GRP " : "💬DM  ";
    const dir = m.fromMe ? "→" : "←";
    const media = m.mediaType ? ` [${m.mediaType}]` : "";
    const body = (m.text || m.reactionEmoji || "").replace(/\s+/g, " ").slice(0, 80);
    console.log(`${tag} ${dir} ${m.pushName || m.senderJid}: ${body}${media}${saved ? "" : dim(" (dup)")}`);

    // Disparar respuesta solo para mensajes NUEVOS de la persona en el self-chat (texto real),
    // no reacciones/borrados ni nuestros propios envíos.
    if (saved && m.chatKind === "self" && m.text.trim() && !m.revoked && !m.reactionEmoji && !sentByMemo.has(m.id)) {
      queue.push(m.text.trim());
      void answerInSelfChat();
    }
  });
  await webhook.listen();
  console.log(dim(`webhook en ${webhook.url}`));

  let shuttingDown = false;
  let proc: ChildProcess | null = null;
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
    proc = spawn(WACLI_BIN, args, { stdio: ["ignore", "inherit", "inherit"], env: process.env });
    proc.once("exit", (code, signal) => {
      proc = null;
      if (!shuttingDown) {
        console.log(dim(`sync salió (code=${code} signal=${signal}) — respawn en 2s`));
        setTimeout(startSync, 2000).unref();
      }
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

  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (embedTimer) clearInterval(embedTimer);
    clearInterval(reminderTimer);
    lidmap.close();
    console.log(`\n${dim("cerrando…")} total en DB: ${store.count()}`);
    if (proc && !proc.killed) proc.kill("SIGTERM");
    setTimeout(() => process.exit(0), 800).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main();
