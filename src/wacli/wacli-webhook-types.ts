// Forma del payload JSON que `wacli sync --webhook URL` postea por cada mensaje vivo.
// Espeja el struct Go `wa.ParsedMessage` (github.com/steipete/wacli). Los nombres son
// PascalCase porque Go marshalea sin struct tags. Los opcionales pueden venir como ""
// o null (zero-value de Go) → los tratamos tolerantes.
// Portado de proyecto-interno/packages/channels/src/wacli-webhook-types.ts (sin cambios).

export interface WacliWebhookMessage {
  /** JID del chat (DM o grupo). Puede venir como objeto {User,Server,…} o string. */
  Chat: WacliJID | string;
  /** ID del stanza del mensaje en WhatsApp. */
  ID: string;
  /** JID del remitente. En DMs == Chat; en grupos el participante real. */
  SenderJID: string;
  /** Timestamp RFC3339. */
  Timestamp: string;
  /** True si lo mandó este device (incluye nuestros propios envíos y lo que el usuario tipea). */
  FromMe: boolean;
  /** Texto plano (caption en media). */
  Text: string;
  /** Nombre visible del remitente. */
  PushName: string;
  /** Metadata del adjunto (mimetype, caption, …). Null en texto plano. */
  Media?: WacliMedia | null;
  /** Emoji si el mensaje es una reacción. */
  ReactionEmoji?: string;
  /** ID del mensaje al que apunta la reacción. */
  ReactionToID?: string;
  /** ID del mensaje citado (si responde). */
  ReplyToID?: string;
  /** True si el mensaje fue borrado/revocado. */
  Revoked?: boolean;
}

export interface WacliJID {
  User: string;
  Server: string;
  Device?: number;
}

export interface WacliMedia {
  Type: string;
  Caption?: string;
  Filename?: string;
  MimeType?: string;
  DirectPath?: string;
  FileLength?: number;
}

/** Normaliza un JID (objeto o string) a la forma canónica `user@server`. */
export function jidToString(jid: WacliJID | string): string {
  if (typeof jid === "string") return jid;
  return `${jid.User}@${jid.Server}`;
}

/** True para JIDs de grupo (sufijo `@g.us`); false para DMs (`@s.whatsapp.net`). */
export function isGroupJid(jid: string): boolean {
  return jid.endsWith("@g.us");
}

/** True para JIDs de broadcast (Estados `status@broadcast` y listas de difusión `…@broadcast`).
 *  No son conversaciones → Memo los ignora (ensucian retrieval y pendientes). */
export function isBroadcastJid(jid: string): boolean {
  return jid.endsWith("@broadcast");
}

/**
 * Saca el sufijo de device-id de un JID. WhatsApp agrega `:<device>` al JID de un
 * participante para desambiguar qué device linkeado mandó el mensaje (ej.
 * `221796573954137:24@lid`). Para routing/identidad queremos la forma independiente del
 * device (`221796573954137@lid`).
 */
export function stripDeviceSuffix(jid: string): string {
  const atIndex = jid.lastIndexOf("@");
  if (atIndex < 0) return jid;
  const local = jid.slice(0, atIndex);
  const server = jid.slice(atIndex);
  const colonIndex = local.indexOf(":");
  if (colonIndex < 0) return jid;
  return local.slice(0, colonIndex) + server;
}
