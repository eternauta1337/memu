// Parea el WhatsApp al store de wacli (una sola vez). Corre `wacli auth` interactivo
// (stdio heredado → el QR / pairing-code aparece en tu terminal), paréa y sale.
//
//   pnpm pair                       # QR (WhatsApp → Dispositivos vinculados → Vincular)
//   pnpm pair -- --phone +59899XXXXXXX   # pairing-code en vez de QR

import "./env.ts";
import { spawn } from "node:child_process";

const bin = process.env.WACLI_BIN ?? "wacli";
const store = process.env.WACLI_STORE ?? "./data/wacli";

const phoneIdx = process.argv.indexOf("--phone");
const phone = phoneIdx >= 0 ? process.argv[phoneIdx + 1] : undefined;

const args = ["auth", "--store", store, "--download-media"];
if (phone) args.push("--phone", phone);

console.log(`Pareando WhatsApp · store=${store}${phone ? ` · phone=${phone}` : " · QR"}`);
console.log("Escaneá el QR (WhatsApp → Dispositivos vinculados) o ingresá el código.\n");

const child = spawn(bin, args, { stdio: "inherit", env: process.env });
child.on("error", (err) => {
  console.error(`No pude correr ${bin}: ${err.message}`);
  process.exit(1);
});
child.on("exit", (code) => {
  console.log(code === 0 ? "\n✅ Pareado. Ahora corré `pnpm ingest`." : `\nwacli auth salió con código ${code}.`);
  process.exit(code ?? 1);
});
