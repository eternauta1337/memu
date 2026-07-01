// Carga el .env del repo (best-effort) para las scripts. Importar PRIMERO en cada entrypoint.
import { existsSync } from "node:fs";

if (existsSync(".env")) {
  try {
    process.loadEnvFile(".env");
  } catch {
    /* .env ilegible → seguimos con el entorno actual */
  }
}
