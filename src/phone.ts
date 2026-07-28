// Normalización de teléfonos a E.164 canónico (sin '+') — la MISMA forma que usa WhatsApp/wacli.
// Así el signup dedup-ea bien (distintos formatos → una sola entrada) y el número guardado matchea
// al remitente que ve el bot central. Usa libphonenumber, que maneja las reglas por país (el "9"
// de Argentina, el de Brasil, prefijos de troncal, el "00" de acceso internacional, etc.).
// Devuelve null si el número no es válido (mejor rechazar en el signup que crear basura).

import { parsePhoneNumberFromString } from "libphonenumber-js";

export function normalizePhone(input: string): string | null {
  let s = (input ?? "").trim().replace(/[^\d+]/g, ""); // dígitos + un eventual '+'
  if (!s) return null;
  if (s.startsWith("00")) s = `+${s.slice(2)}`; // 00 = acceso internacional → '+'
  else if (!s.startsWith("+")) s = `+${s}`; // asumimos que tipearon el código de país
  const parsed = parsePhoneNumberFromString(s);
  if (!parsed || !parsed.isValid()) return null;
  return parsed.number.slice(1); // E.164 sin el '+' (ej. "59899123456")
}
