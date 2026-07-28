// Carga el .env del repo (best-effort) para las scripts. Importar PRIMERO en cada entrypoint.
import { existsSync } from "node:fs";

if (existsSync(".env")) {
  try {
    process.loadEnvFile(".env");
  } catch {
    /* .env ilegible → seguimos con el entorno actual */
  }
}

// La box corre en UTC pero todo Memu razona en "hora local" de la persona (reminders, AHORA del
// prompt, digests). Sin esto, "10:00" se agenda como 10:00 UTC = 07:00 en Uruguay.
process.env.TZ ||= "America/Montevideo";
