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
  addUser(phone: string | null, opts?: { id?: number; status?: UserStatus }): User;
  getUser(id: number): User | null;
  getUserByPhone(phone: string): User | null;
  getUserByStripeCustomer(customerId: string): User | null;
  /** Usuarios, opcionalmente filtrados por status; del más recientemente activo al más viejo. */
  listUsers(opts?: { status?: UserStatus }): User[];
  setStatus(id: number, status: UserStatus): void;
  /** Actualiza los campos de suscripción provistos (Stripe). Los `undefined` no se tocan. */
  setBilling(id: number, fields: { status?: string; customerId?: string; subscriptionId?: string }): void;
  /** Fase de onboarding post-pairing ('indexando' | 'activo'). */
  setOnboardingState(id: number, state: string): void;
  /** Marca actividad (para la priorización del pool de follows). */
  touchActive(id: number): void;

  // --- Consentimiento de Términos + Privacidad (append-only, por teléfono). Ver central-bot.ts.
  /** Registra que se le mostraron los términos (versión) a un teléfono. */
  recordTermsPrompt(phone: string, version: string): void;
  /** Registra la aceptación de los términos (con el texto literal del mensaje, para auditoría). */
  recordTermsAcceptance(phone: string, version: string, text: string): void;
  /** ¿El teléfono ya aceptó ESTA versión de los términos? */
  hasAcceptedTerms(phone: string, version: string): boolean;
  /** ¿Ya le mostramos ESTA versión de los términos? (para interpretar la respuesta como aceptación). */
  wasPromptedTerms(phone: string, version: string): boolean;
  /** Última aceptación registrada para el teléfono (o null). */
  latestTermsAcceptance(phone: string): { version: string; acceptedAt: string; text: string | null } | null;

  // --- Borrado de datos (promesa de la privacy policy §6). El bot/las cancelaciones REGISTRAN el
  // pedido; el wipe real lo corre el admin con `pnpm delete-user` (ver delete-user.ts). ---------
  /** Registra un pedido de borrado (dedup: no crea otro si ya hay uno abierto para el teléfono). */
  recordDeletionRequest(phone: string, userId: number | null, source: string): void;
  /** ¿Hay un pedido de borrado abierto (pending/notified) para el teléfono? */
  hasOpenDeletionRequest(phone: string): boolean;
  /** Pedidos todavía no avisados al admin (status 'pending'). */
  unnotifiedDeletionRequests(): Array<{ id: number; phone: string; userId: number | null; source: string }>;
  /** Marca un pedido como avisado al admin. */
  markDeletionNotified(id: number): void;
  /** Cierra todos los pedidos abiertos de un teléfono (los marca 'done'; lo llama delete-user). */
  resolveDeletionRequests(phone: string): void;
  /** Borra el teléfono de la fila del usuario (anonimiza; quedan los ids de Stripe para lo contable). */
  clearPhone(id: number): void;

  close(): void;
}

const rowToUser = (r: Record<string, unknown>): User => ({
  id: r.id as number,
  phone: (r.phone as string | null) ?? null,
  status: r.status as UserStatus,
  createdAt: r.created_at as string,
  lastActiveAt: (r.last_active_at as string | null) ?? null,
  subscriptionStatus: (r.subscription_status as string | null) ?? null,
  stripeCustomerId: (r.stripe_customer_id as string | null) ?? null,
  stripeSubscriptionId: (r.stripe_subscription_id as string | null) ?? null,
  onboardingState: (r.onboarding_state as string | null) ?? null,
});

export function openRegistry(dbPath: string = REGISTRY_DB): Registry {
  mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 }); // datos de usuarios: solo el dueño
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
  // Limpieza: el login por WhatsApp (token de un solo uso + email de Google) fue removido. Tiramos su
  // tabla y —si el SQLite lo soporta— su columna. Cada una en su try/catch: corre sobre la DB en vivo
  // (la abren ingest + control-plane), así que un lock transitorio, un "no existe" o un SQLite viejo
  // sin DROP COLUMN NO deben tumbar el arranque — el objeto sobrante queda inerte, sin código que lo use.
  try {
    db.exec("DROP TABLE IF EXISTS login_tokens");
  } catch {
    /* lock transitorio / ya no existe → queda inerte, se reintenta en el próximo arranque */
  }
  try {
    db.exec("ALTER TABLE users DROP COLUMN email");
  } catch {
    /* lock transitorio / ya no existe / SQLite sin DROP COLUMN → queda inerte */
  }
  // Consentimiento de Términos + Privacidad (append-only, para que "quede registrado"). Se lleva por
  // TELÉFONO porque el gate corre en el onboarding, antes de que exista la fila de `users`. Cada
  // fila es un evento: 'prompted' (le mostramos los términos) o 'accepted' (respondió que acepta,
  // con el texto literal). `version` es la fecha de "Última actualización" de la web (ver central-bot.ts).
  // Pedidos de borrado de datos (privacy policy §6): el bot o una cancelación de Stripe registran
  // el pedido; un sweep del orquestador alerta al admin ('pending' → 'notified'); `pnpm delete-user`
  // hace el wipe y los cierra ('done'). Por TELÉFONO (igual que terms_events).
  db.exec(`
    CREATE TABLE IF NOT EXISTS deletion_requests (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      phone       TEXT NOT NULL,
      user_id     INTEGER,
      source      TEXT NOT NULL,                    -- 'bot' | 'cancelacion' | 'admin'
      status      TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'notified' | 'done'
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_deletion_requests_phone ON deletion_requests (phone);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS terms_events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      phone      TEXT NOT NULL,
      kind       TEXT NOT NULL,   -- 'prompted' | 'accepted'
      version    TEXT NOT NULL,
      text       TEXT,            -- mensaje literal con el que aceptó (auditoría)
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_terms_events_phone ON terms_events (phone);
  `);

  const insAuto = db.prepare("INSERT INTO users (phone, status) VALUES (?, ?)");
  const insWithId = db.prepare("INSERT INTO users (id, phone, status) VALUES (?, ?, ?)");
  const selById = db.prepare("SELECT * FROM users WHERE id = ?");
  const selByPhone = db.prepare("SELECT * FROM users WHERE phone = ?");
  const selByCustomer = db.prepare("SELECT * FROM users WHERE stripe_customer_id = ?");
  const selAll = db.prepare("SELECT * FROM users ORDER BY (last_active_at IS NULL), last_active_at DESC, id ASC");
  const selByStatus = db.prepare(
    "SELECT * FROM users WHERE status = ? ORDER BY (last_active_at IS NULL), last_active_at DESC, id ASC",
  );
  const updStatus = db.prepare("UPDATE users SET status = ? WHERE id = ?");
  const updSubStatus = db.prepare("UPDATE users SET subscription_status = ? WHERE id = ?");
  const updOnbState = db.prepare("UPDATE users SET onboarding_state = ? WHERE id = ?");
  const updCustomer = db.prepare("UPDATE users SET stripe_customer_id = ? WHERE id = ?");
  const updSubId = db.prepare("UPDATE users SET stripe_subscription_id = ? WHERE id = ?");
  const updActive = db.prepare("UPDATE users SET last_active_at = datetime('now') WHERE id = ?");

  const insTermsEvent = db.prepare(
    "INSERT INTO terms_events (phone, kind, version, text) VALUES (?, ?, ?, ?)",
  );
  const selTermsExists = db.prepare(
    "SELECT 1 FROM terms_events WHERE phone = ? AND kind = ? AND version = ? LIMIT 1",
  );
  const selLatestAcceptance = db.prepare(
    "SELECT version, text, created_at FROM terms_events WHERE phone = ? AND kind = 'accepted' ORDER BY id DESC LIMIT 1",
  );

  const insDeletionReq = db.prepare("INSERT INTO deletion_requests (phone, user_id, source) VALUES (?, ?, ?)");
  const selOpenDeletionReq = db.prepare(
    "SELECT 1 FROM deletion_requests WHERE phone = ? AND status IN ('pending','notified') LIMIT 1",
  );
  const selUnnotifiedDeletionReqs = db.prepare(
    "SELECT id, phone, user_id, source FROM deletion_requests WHERE status = 'pending' ORDER BY id ASC",
  );
  const updDeletionNotified = db.prepare("UPDATE deletion_requests SET status = 'notified' WHERE id = ?");
  const updDeletionDone = db.prepare(
    "UPDATE deletion_requests SET status = 'done', resolved_at = datetime('now') WHERE phone = ? AND status IN ('pending','notified')",
  );
  const updClearPhone = db.prepare("UPDATE users SET phone = NULL WHERE id = ?");

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
    recordTermsPrompt(phone, version) {
      insTermsEvent.run(phone, "prompted", version, null);
    },
    recordTermsAcceptance(phone, version, text) {
      insTermsEvent.run(phone, "accepted", version, text);
    },
    hasAcceptedTerms(phone, version) {
      return selTermsExists.get(phone, "accepted", version) != null;
    },
    wasPromptedTerms(phone, version) {
      return selTermsExists.get(phone, "prompted", version) != null;
    },
    latestTermsAcceptance(phone) {
      const r = selLatestAcceptance.get(phone) as
        | { version: string; text: string | null; created_at: string }
        | undefined;
      return r ? { version: r.version, acceptedAt: r.created_at, text: r.text } : null;
    },
    recordDeletionRequest(phone, userId, source) {
      if (selOpenDeletionReq.get(phone)) return; // ya hay uno abierto → no duplicar
      insDeletionReq.run(phone, userId, source);
    },
    hasOpenDeletionRequest(phone) {
      return selOpenDeletionReq.get(phone) != null;
    },
    unnotifiedDeletionRequests() {
      const rows = selUnnotifiedDeletionReqs.all() as Array<{
        id: number;
        phone: string;
        user_id: number | null;
        source: string;
      }>;
      return rows.map((r) => ({ id: r.id, phone: r.phone, userId: r.user_id, source: r.source }));
    },
    markDeletionNotified(id) {
      updDeletionNotified.run(id);
    },
    resolveDeletionRequests(phone) {
      updDeletionDone.run(phone);
    },
    clearPhone(id) {
      updClearPhone.run(id);
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
