// Alertas operativas al admin (deslink/ban de WhatsApp, etc.). Sin servicios externos: los
// canales son los DOS links de WhatsApp que ya tenemos, y cada uno cubre la caída del otro —
//   1) el bot central le manda un DM al teléfono del admin (cubre caídas de companions), y
//   2) el companion del admin le escribe a su PROPIO self-chat (cubre la caída del central).
// Los canales se prueban en orden hasta que uno entrega. Si ninguno puede, queda en el journal
// (journalctl -u memu-ingest). El throttle por clave evita spamear la misma alerta en loop.

export type AlertChannel = (text: string) => Promise<boolean>;

export interface Alerter {
  /** Manda `text` al admin por el primer canal que funcione. `key` dedupea (throttle). */
  alert(key: string, text: string): Promise<void>;
}

export function createAlerter(opts: { channels: AlertChannel[]; throttleMs?: number }): Alerter {
  const throttleMs = opts.throttleMs ?? 6 * 3600_000; // misma alerta como mucho cada 6h
  const lastAt = new Map<string, number>();
  return {
    async alert(key, text) {
      const now = Date.now();
      if (now - (lastAt.get(key) ?? 0) < throttleMs) return;
      lastAt.set(key, now);
      console.error(`[alerta] ${text}`);
      for (const channel of opts.channels) {
        try {
          if (await channel(text)) return;
        } catch {
          /* canal caído → probar el siguiente */
        }
      }
      console.error("[alerta] ⚠️ ningún canal pudo entregar la alerta — quedó solo en el journal");
    },
  };
}
