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
import { normalizeForMemo } from "./ingest.ts";
import { openStore } from "./store.ts";
import { WacliClient } from "./wacli/wacli-client.ts";
import { WacliWebhookServer } from "./wacli/wacli-webhook-server.ts";
import { stripDeviceSuffix } from "./wacli/wacli-webhook-types.ts";

const WACLI_BIN = process.env.WACLI_BIN ?? "wacli";
const STORE = process.env.WACLI_STORE ?? "./data/wacli";
const DB = process.env.MEMO_DB ?? "./data/memo.db";
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

  // Identidades propias para detectar el self-chat: sembramos el JID de teléfono y aprendemos
  // el/los LID propios del SenderJID de los mensajes FromMe (ver nota en ingest.ts).
  const ownIds = new Set<string>();
  if (ownJid) ownIds.add(stripDeviceSuffix(ownJid));

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
        try {
          const ans = (await askMemo(store, q)).trim();
          if (ans) {
            const r = await client.sendText(ownJid, ans);
            if (r.id) sentByMemo.add(r.id);
          }
        } catch (e) {
          console.log(dim(`[memo] error respondiendo: ${(e as Error)?.message ?? e}`));
          await client.sendText(ownJid, "Uf, algo falló procesando eso 🫤").catch(() => {});
        }
      }
    } finally {
      answering = false;
    }
  };

  const webhook = new WacliWebhookServer();
  webhook.onMessage((raw) => {
    if (raw.FromMe && raw.SenderJID) ownIds.add(stripDeviceSuffix(raw.SenderJID));
    const m = normalizeForMemo(raw, ownIds);
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

  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${dim("cerrando…")} total en DB: ${store.count()}`);
    if (proc && !proc.killed) proc.kill("SIGTERM");
    setTimeout(() => process.exit(0), 800).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main();
