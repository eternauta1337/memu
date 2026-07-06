// Cliente del Customer Portal de Stripe. La Stripe key vive SOLO en la box (memu-web); acá le pedimos
// server-to-server una sesión del portal (gate con el token compartido CONTROL_PLANE_TOKEN) y
// devolvemos la URL efímera. Lo usan el agente (tool `gestionar_suscripcion`) y el onboarding (aviso
// de pago vencido). Ver memu-web/app/api/stripe/portal/route.ts.

import "./env.ts";

const WEB_BASE = (process.env.MEMU_WEB_URL ?? "https://memu.chat").replace(/\/$/, "");
const CP_TOKEN = process.env.CONTROL_PLANE_TOKEN ?? "";

/** Pide a la box una sesión del Customer Portal para un customer de Stripe. Devuelve la URL, o null
 *  si falla (red, gate, o portal sin configurar). */
export async function portalUrl(customerId: string): Promise<string | null> {
  try {
    const res = await fetch(`${WEB_BASE}/api/stripe/portal`, {
      method: "POST",
      headers: { authorization: `Bearer ${CP_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ customerId }),
    });
    const json = (await res.json().catch(() => ({}))) as { url?: string };
    return res.ok && typeof json.url === "string" ? json.url : null;
  } catch {
    return null;
  }
}
