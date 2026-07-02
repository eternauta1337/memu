// Normaliza un mensaje crudo de wacli a la forma que Memo guarda.
//
// DIFERENCIA CLAVE con el canal de Proyecto-interno (que descarta grupos, ecos y reacciones): Memo
// necesita VER todo. Conservamos grupos, self-chat, mensajes propios (fromMe) y reacciones;
// solo los clasificamos y marcamos con flags. Filtrar/decidir es responsabilidad de capas
// posteriores (indexador, agente), no de la ingesta.

import {
  isGroupJid,
  jidToString,
  stripDeviceSuffix,
  type WacliWebhookMessage,
} from "./wacli/wacli-webhook-types.ts";

export type ChatKind = "self" | "dm" | "group";

export interface MemoMessage {
  /** Stanza id (único). */
  id: string;
  /** JID del chat (destino de respuesta). */
  chatJid: string;
  /** self = "Mensajes contigo mismo"; dm = 1:1; group = @g.us. */
  chatKind: ChatKind;
  /** JID del remitente real (en grupos, el participante). */
  senderJid: string;
  /** Nombre visible del remitente. */
  pushName: string;
  /** True si lo envió este device (nuestros posts o lo que el usuario tipea desde el celu). */
  fromMe: boolean;
  /** Timestamp RFC3339 de wacli. */
  ts: string;
  /** Texto o caption. Vacío para audio (dispara STT más adelante). */
  text: string;
  /** Tipo de media crudo de wacli (image/ptt/audio/document/…), si hay. */
  mediaType?: string;
  mediaMime?: string;
  mediaName?: string;
  /** Emoji si el mensaje es una reacción. */
  reactionEmoji?: string;
  /** ID del mensaje citado. */
  replyToId?: string;
  /** True si fue borrado/revocado. */
  revoked: boolean;
}

/**
 * Normaliza un `WacliWebhookMessage`. `ownIds` es el conjunto de identidades propias
 * conocidas (JID de teléfono `@s.whatsapp.net` + LIDs `@lid` aprendidos): el chat cuyo JID
 * está en ese set es el self-chat ("Mensajes contigo mismo").
 *
 * OJO identidad LID↔teléfono: el webhook en vivo entrega DMs/self en formato `@lid`, mientras
 * que `wacli.db` los guarda como `@s.whatsapp.net`. El `resolve` (ver lidmap.ts) canonicaliza
 * `<lid>@lid` → `<pn>@s.whatsapp.net`, así lo vivo matchea el histórico y los nombres. Default
 * identidad (para tests puros). El self-chat se detecta con `ownIds` (ya canonicalizado).
 * Pura salvo por el `resolve` inyectado → testeable.
 */
export function normalizeForMemo(
  msg: WacliWebhookMessage,
  ownIds: ReadonlySet<string>,
  resolve: (jid: string) => string = (j) => j,
): MemoMessage {
  const rawChat = stripDeviceSuffix(jidToString(msg.Chat));
  const chatJid = resolve(rawChat);
  const senderJid = resolve(stripDeviceSuffix(msg.SenderJID || rawChat));

  let chatKind: ChatKind = isGroupJid(chatJid) ? "group" : "dm";
  if (ownIds.has(chatJid)) chatKind = "self";

  const mediaType = msg.Media ? (msg.Media.Type || "document").toLowerCase() : undefined;
  // Para audio/ptt wacli rellena Text con el placeholder "[Audio]" → lo vaciamos para que la
  // transcripción (STT) se dispare más adelante en vez de tomarlo como texto real.
  const isAudio = mediaType === "audio" || mediaType === "ptt";

  return {
    id: msg.ID,
    chatJid,
    chatKind,
    senderJid,
    pushName: msg.PushName ?? "",
    fromMe: Boolean(msg.FromMe),
    ts: msg.Timestamp ?? "",
    text: isAudio ? "" : msg.Text || msg.Media?.Caption || "",
    mediaType,
    mediaMime: msg.Media?.MimeType || undefined,
    mediaName: msg.Media?.Filename || undefined,
    reactionEmoji: msg.ReactionEmoji || undefined,
    replyToId: msg.ReplyToID || undefined,
    revoked: Boolean(msg.Revoked),
  };
}
