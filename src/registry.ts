// Registro central de usuarios (multi-tenant). Un solo `data/registry.db` con la tabla `users`:
// id (PK), phone, status, timestamps. Es lo ÚNICO central — los DATOS de cada usuario viven
// aislados en `data/users/<id>/` (memu.db + wacli/, ver users.ts). El pool de ingest (paso 4c)
// prioriza por `last_active_at`. Onboarding: `pnpm add-user --phone` (paso 4c); signup web +
// Stripe queda para Fase 3.

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const REGISTRY_DB = process.env.MEMU_REGISTRY_DB ?? "./data/registry.db";

// 'pending' = creado, pairing en curso (todavía no lo sirve el pool); 'active' = pareado y en
// servicio; 'paused'/'disabled' = fuera de servicio.
export type UserStatus = "pending" | "active" | "paused" | "disabled";

export interface User {
  id: number;
  phone: string | null;
  /** Email de login (Google) — atado en el signup. Sirve para el "¿ya vinculaste?" de la web. */
  email: string | null;
  status: UserStatus;
  createdAt: string;
  lastActiveAt: string | null;
  // --- Suscripción (Stripe, Fase B). `subscriptionStatus` guarda el status crudo de Stripe
  // ('trialing' | 'active' | 'past_due' | 'canceled' | …); el acceso lo dan trialing|active.
  subscriptionStatus: string | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  /** Fase de onboarding post-pairing: 'indexando' (leyendo el historial) → 'activo' (listo).
   *  null = legacy/activo (usuarios previos a la feature). Ver central-bot.ts. */
  onboardingState: string | null;
}

export interface Registry {
  db: Database.Database;
  /** Alta de usuario. `id` explícito solo para migrar al dueño como user 1. */
  addUser(phone: string | null, opts?: { id?: number; status?: UserStatus; email?: string | null }): User;
  getUser(id: number): User | null;
  getUserByPhone(phone: string): User | null;
  getUserByEmail(email: string): User | null;
  getUserByStripeCustomer(customerId: string): User | null;
  /** Usuarios, opcionalmente filtrados por status; del más recientemente activo al más viejo. */
  listUsers(opts?: { status?: UserStatus }): User[];
  setStatus(id: number, status: UserStatus): void;
  setEmail(id: number, email: string): void;
  /** Actualiza los campos de suscripción provistos (Stripe). Los `undefined` no se tocan. */
  setBilling(id: number, fields: { status?: string; customerId?: string; subscriptionId?: string }): void;
  /** Fase de onboarding post-pairing ('indexando' | 'activo'). */
  setOnboardingState(id: number, state: string): void;
  /** Marca actividad (para la priorización del pool de follows). */
  touchActive(id: number): void;

  // --- Login por WhatsApp: token de un solo uso, compartido entre el control-plane (que lo crea
  // y lo consulta) y el bot central (que lo verifica cuando el usuario se lo manda por WhatsApp).
  /** Crea un token de login pendiente. */
  createLogin(token: string): void;
  /** Estado del token (o null si no existe / expiró). */
  getLogin(token: string): { status: "pending" | "verified"; userId: number | null; phone: string | null } | null;
  /** Verifica un token pendiente con el teléfono del remitente: asegura el usuario y lo ata al
   *  token. Devuelve el userId, o null si el token no existe / no está pendiente / expiró. */
  verifyLogin(token: string, phone: string): number | null;

  close(): void;
}

const rowToUser = (r: Record<string, unknown>): User => ({
  id: r.id as number,
  phone: (r.phone as string | null) ?? null,
  email: (r.email as string | null) ?? null,
  status: r.status as UserStatus,
  createdAt: r.created_at as string,
  lastActiveAt: (r.last_active_at as string | null) ?? null,
  subscriptionStatus: (r.subscription_status as string | null) ?? null,
  stripeCustomerId: (r.stripe_customer_id as string | null) ?? null,
  stripeSubscriptionId: (r.stripe_subscription_id as string | null) ?? null,
  onboardingState: (r.onboarding_state as string | null) ?? null,
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
  // Migración idempotente: columna email para atar el login al usuario.
  try {
    db.exec("ALTER TABLE users ADD COLUMN email TEXT");
  } catch {
    /* ya existe */
  }
  // Migración idempotente: campos de suscripción (Stripe, Fase B) + fase de onboarding.
  for (const col of [
    "subscription_status TEXT",
    "stripe_customer_id TEXT",
    "stripe_subscription_id TEXT",
    "onboarding_state TEXT",
  ]) {
    try {
      db.exec(`ALTER TABLE users ADD COLUMN ${col}`);
    } catch {
      /* ya existe */
    }
  }
  // Tokens de login por WhatsApp (un solo uso, TTL corto).
  db.exec(`
    CREATE TABLE IF NOT EXISTS login_tokens (
      token      TEXT PRIMARY KEY,
      status     TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'verified'
      user_id    INTEGER,
      phone      TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const insAuto = db.prepare("INSERT INTO users (phone, status, email) VALUES (?, ?, ?)");
  const insWithId = db.prepare("INSERT INTO users (id, phone, status, email) VALUES (?, ?, ?, ?)");
  const selById = db.prepare("SELECT * FROM users WHERE id = ?");
  const selByPhone = db.prepare("SELECT * FROM users WHERE phone = ?");
  const selByEmail = db.prepare("SELECT * FROM users WHERE email = ? COLLATE NOCASE");
  const selByCustomer = db.prepare("SELECT * FROM users WHERE stripe_customer_id = ?");
  const selAll = db.prepare("SELECT * FROM users ORDER BY (last_active_at IS NULL), last_active_at DESC, id ASC");
  const selByStatus = db.prepare(
    "SELECT * FROM users WHERE status = ? ORDER BY (last_active_at IS NULL), last_active_at DESC, id ASC",
  );
  const updStatus = db.prepare("UPDATE users SET status = ? WHERE id = ?");
  const updEmail = db.prepare("UPDATE users SET email = ? WHERE id = ?");
  const updSubStatus = db.prepare("UPDATE users SET subscription_status = ? WHERE id = ?");
  const updOnbState = db.prepare("UPDATE users SET onboarding_state = ? WHERE id = ?");
  const updCustomer = db.prepare("UPDATE users SET stripe_customer_id = ? WHERE id = ?");
  const updSubId = db.prepare("UPDATE users SET stripe_subscription_id = ? WHERE id = ?");
  const updActive = db.prepare("UPDATE users SET last_active_at = datetime('now') WHERE id = ?");

  const insLogin = db.prepare("INSERT INTO login_tokens (token) VALUES (?)");
  const selLogin = db.prepare("SELECT status, user_id, phone FROM login_tokens WHERE token = ?");
  // Solo pendientes y no expirados (TTL 15 min).
  const selPendingLogin = db.prepare(
    "SELECT token FROM login_tokens WHERE token = ? AND status = 'pending' AND created_at > datetime('now','-15 minutes')",
  );
  const updLoginVerified = db.prepare(
    "UPDATE login_tokens SET status = 'verified', user_id = ?, phone = ? WHERE token = ?",
  );

  return {
    db,
    addUser(phone, opts) {
      const status = opts?.status ?? "active";
      const email = opts?.email ?? null;
      const res =
        opts?.id != null ? insWithId.run(opts.id, phone, status, email) : insAuto.run(phone, status, email);
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
    getUserByEmail(email) {
      const r = selByEmail.get(email) as Record<string, unknown> | undefined;
      return r ? rowToUser(r) : null;
    },
    getUserByStripeCustomer(customerId) {
      const r = selByCustomer.get(customerId) as Record<string, unknown> | undefined;
      return r ? rowToUser(r) : null;
    },
    listUsers(opts) {
      const rows = (opts?.status ? selByStatus.all(opts.status) : selAll.all()) as Array<Record<string, unknown>>;
      return rows.map(rowToUser);
    },
    setStatus(id, status) {
      updStatus.run(status, id);
    },
    setEmail(id, email) {
      updEmail.run(email, id);
    },
    setBilling(id, fields) {
      if (fields.status !== undefined) updSubStatus.run(fields.status, id);
      if (fields.customerId !== undefined) updCustomer.run(fields.customerId, id);
      if (fields.subscriptionId !== undefined) updSubId.run(fields.subscriptionId, id);
    },
    setOnboardingState(id, state) {
      updOnbState.run(state, id);
    },
    touchActive(id) {
      updActive.run(id);
    },
    createLogin(token) {
      insLogin.run(token);
    },
    getLogin(token) {
      const r = selLogin.get(token) as { status: string; user_id: number | null; phone: string | null } | undefined;
      if (!r) return null;
      return { status: r.status as "pending" | "verified", userId: r.user_id ?? null, phone: r.phone ?? null };
    },
    verifyLogin(token, phone) {
      if (!selPendingLogin.get(token)) return null; // no existe / ya usado / expirado
      // Asegurar el usuario del teléfono (lo crea 'pending' si es nuevo → signup implícito).
      const existing = selByPhone.get(phone) as { id: number } | undefined;
      const userId = existing ? existing.id : Number(insAuto.run(phone, "pending", null).lastInsertRowid);
      updLoginVerified.run(userId, phone, token);
      return userId;
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
