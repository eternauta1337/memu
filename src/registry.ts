// Registro central de usuarios (multi-tenant). Un solo `data/registry.db` con la tabla `users`:
// id (PK), phone, status, timestamps. Es lo ÚNICO central — los DATOS de cada usuario viven
// aislados en `data/users/<id>/` (memo.db + wacli/, ver users.ts). El pool de ingest (paso 4c)
// prioriza por `last_active_at`. Onboarding: `pnpm add-user --phone` (paso 4c); signup web +
// Stripe queda para Fase 3.

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const REGISTRY_DB = process.env.MEMO_REGISTRY_DB ?? "./data/registry.db";

// 'pending' = creado, pairing en curso (todavía no lo sirve el pool); 'active' = pareado y en
// servicio; 'paused'/'disabled' = fuera de servicio.
export type UserStatus = "pending" | "active" | "paused" | "disabled";

export interface User {
  id: number;
  phone: string | null;
  status: UserStatus;
  createdAt: string;
  lastActiveAt: string | null;
}

export interface Registry {
  db: Database.Database;
  /** Alta de usuario. `id` explícito solo para migrar al dueño como user 1. */
  addUser(phone: string | null, opts?: { id?: number; status?: UserStatus }): User;
  getUser(id: number): User | null;
  getUserByPhone(phone: string): User | null;
  /** Usuarios, opcionalmente filtrados por status; del más recientemente activo al más viejo. */
  listUsers(opts?: { status?: UserStatus }): User[];
  setStatus(id: number, status: UserStatus): void;
  /** Marca actividad (para la priorización del pool de follows). */
  touchActive(id: number): void;
  close(): void;
}

const rowToUser = (r: Record<string, unknown>): User => ({
  id: r.id as number,
  phone: (r.phone as string | null) ?? null,
  status: r.status as UserStatus,
  createdAt: r.created_at as string,
  lastActiveAt: (r.last_active_at as string | null) ?? null,
});

export function openRegistry(dbPath: string = REGISTRY_DB): Registry {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      phone          TEXT UNIQUE,
      status         TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'paused' | 'disabled'
      created_at     TEXT NOT NULL DEFAULT (datetime('now')),
      last_active_at TEXT
    );
  `);

  const insAuto = db.prepare("INSERT INTO users (phone, status) VALUES (?, ?)");
  const insWithId = db.prepare("INSERT INTO users (id, phone, status) VALUES (?, ?, ?)");
  const selById = db.prepare("SELECT * FROM users WHERE id = ?");
  const selByPhone = db.prepare("SELECT * FROM users WHERE phone = ?");
  const selAll = db.prepare("SELECT * FROM users ORDER BY (last_active_at IS NULL), last_active_at DESC, id ASC");
  const selByStatus = db.prepare(
    "SELECT * FROM users WHERE status = ? ORDER BY (last_active_at IS NULL), last_active_at DESC, id ASC",
  );
  const updStatus = db.prepare("UPDATE users SET status = ? WHERE id = ?");
  const updActive = db.prepare("UPDATE users SET last_active_at = datetime('now') WHERE id = ?");

  return {
    db,
    addUser(phone, opts) {
      const status = opts?.status ?? "active";
      const res = opts?.id != null ? insWithId.run(opts.id, phone, status) : insAuto.run(phone, status);
      const id = opts?.id ?? Number(res.lastInsertRowid);
      return rowToUser(selById.get(id) as Record<string, unknown>);
    },
    getUser(id) {
      const r = selById.get(id) as Record<string, unknown> | undefined;
      return r ? rowToUser(r) : null;
    },
    getUserByPhone(phone) {
      const r = selByPhone.get(phone) as Record<string, unknown> | undefined;
      return r ? rowToUser(r) : null;
    },
    listUsers(opts) {
      const rows = (opts?.status ? selByStatus.all(opts.status) : selAll.all()) as Array<Record<string, unknown>>;
      return rows.map(rowToUser);
    },
    setStatus(id, status) {
      updStatus.run(status, id);
    },
    touchActive(id) {
      updActive.run(id);
    },
    close() {
      db.close();
    },
  };
}

let registry: Registry | null = null;

/** Registro compartido (abre una vez). */
export function getRegistry(): Registry {
  if (!registry) registry = openRegistry();
  return registry;
}
