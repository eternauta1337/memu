// Cliente del control-plane para el bot central. El bot corre en host-backend (misma máquina que el
// control-plane) y lo llama server-side para: (a) disparar el pairing de un usuario nuevo desde
// la conversación de WhatsApp (onboarding in-chat) y (b) consultar el estado/código del pairing.
// Ver control-plane.ts (el server) y central-bot.ts (el consumidor).

import "./env.ts";

// El control-plane bindea a CONTROL_PLANE_HOST (acá la IP de Tailscale de host-backend, no 0.0.0.0), así
// que apuntamos ahí salvo override explícito. Si es 0.0.0.0/vacío, loopback.
const CP_HOST = process.env.CONTROL_PLANE_HOST;
const HOST = !CP_HOST || CP_HOST === "0.0.0.0" ? "127.0.0.1" : CP_HOST;
const BASE = process.env.CONTROL_PLANE_URL ?? `http://${HOST}:${process.env.CONTROL_PLANE_PORT ?? 8788}`;
const TOKEN = process.env.CONTROL_PLANE_TOKEN ?? "";

async function req<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error((json.error as string) ?? `control-plane ${res.status}`);
  return json as T;
}

export interface CpPairing {
  userId: number;
  status: "pairing" | "connected" | "failed";
  code?: string;
  error?: string;
}

/** Crea (o reusa) el usuario del teléfono y arranca el pairing; espera brevemente el pair-code. */
export const cpProvision = (phone: string): Promise<CpPairing> => req("POST", "/provision", { phone });

/** Estado del pairing de un usuario (incluye el código si ya se emitió). */
export const cpStatus = (userId: number): Promise<CpPairing> => req("GET", `/status/${userId}`);
