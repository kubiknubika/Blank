import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Forward-only migrations. Each entry runs exactly once, inside a
 * transaction, and is recorded in schema_migrations. To change the schema,
 * append a new migration — never edit an applied one.
 */
const MIGRATIONS: { id: number; name: string; up: string }[] = [
  {
    id: 1,
    name: 'initial-schema',
    up: `
      CREATE TABLE applications (
        id TEXT PRIMARY KEY,
        company TEXT NOT NULL,
        position TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'wishlist',
        source TEXT NOT NULL DEFAULT 'other',
        priority TEXT NOT NULL DEFAULT 'medium',
        location TEXT,
        work_mode TEXT NOT NULL DEFAULT 'remote',
        salary_min INTEGER,
        salary_max INTEGER,
        currency TEXT NOT NULL DEFAULT 'EUR',
        url TEXT,
        notes TEXT,
        applied_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (status IN ('wishlist','applied','screening','interview','offer','rejected')),
        CHECK (work_mode IN ('remote','hybrid','onsite')),
        CHECK (salary_min IS NULL OR salary_max IS NULL OR salary_min <= salary_max)
      );
      CREATE TABLE events (
        id TEXT PRIMARY KEY,
        application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_applications_status ON applications(status);
      CREATE INDEX idx_events_application ON events(application_id);
    `,
  },
  {
    id: 2,
    name: 'events-created-at-index',
    up: `CREATE INDEX idx_events_created_at ON events(created_at DESC);`,
  },
  {
    id: 3,
    name: 'applications-version',
    // Optimistic concurrency: every field update bumps version; writers
    // may pass If-Match to detect lost updates. Existing rows start at 1.
    up: `ALTER TABLE applications ADD COLUMN version INTEGER NOT NULL DEFAULT 1;`,
  },
  {
    id: 4,
    name: 'users-and-sessions',
    // Multi-user: accounts, hashed session tokens, and per-row ownership.
    // The shared demo account owns all pre-auth rows (backfill below).
    // user_id is nullable at the schema level because SQLite's ALTER TABLE
    // ADD COLUMN with REFERENCES requires a NULL default under
    // PRAGMA foreign_keys=ON; the repository binds it on EVERY insert and
    // scopes EVERY read, and a test pins that no row is ever ownerless.
    up: `
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT,
        display_name TEXT NOT NULL,
        is_demo INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1)),
        created_at TEXT NOT NULL
      );
      CREATE TABLE sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE INDEX idx_sessions_user ON sessions(user_id);
      CREATE INDEX idx_sessions_expires ON sessions(expires_at);
      INSERT INTO users (id, email, password_hash, display_name, is_demo, created_at)
      VALUES ('demo', 'demo@offerflow.local', NULL, 'Demo User', 1, '2026-01-01T00:00:00.000Z');
      ALTER TABLE applications ADD COLUMN user_id TEXT REFERENCES users(id);
      UPDATE applications SET user_id = 'demo' WHERE user_id IS NULL;
      CREATE INDEX idx_applications_user ON applications(user_id, updated_at DESC);
    `,
  },
  {
    id: 5,
    name: 'applications-follow-up',
    // Date-only reminder ("follow up on this application"). Partial index:
    // only a small fraction of rows ever carry a reminder, and the only
    // query that filters on it is the reminders list.
    up: `
      ALTER TABLE applications ADD COLUMN follow_up_at TEXT;
      CREATE INDEX idx_applications_follow_up
        ON applications(user_id, follow_up_at)
        WHERE follow_up_at IS NOT NULL;
    `,
  },
  {
    id: 6,
    name: 'applications-archive',
    // Soft archive: rows leave the active board and analytics but keep
    // their history. NULL = active; the timestamp records WHEN.
    up: `
      ALTER TABLE applications ADD COLUMN archived_at TEXT;
      CREATE INDEX idx_applications_archived
        ON applications(user_id, archived_at);
    `,
  },
];

export interface DbOptions {
  /** How long a blocked writer waits for the lock before SQLITE_BUSY. */
  busyTimeoutMs?: number;
}

export function createDb(path: string, { busyTimeoutMs = 5_000 }: DbOptions = {}): DatabaseSync {
  if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
    throw new Error(`busyTimeoutMs must be a non-negative integer, got ${busyTimeoutMs}`);
  }
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new DatabaseSync(path);
  // busy_timeout FIRST: node:sqlite defaults it to 0, so any concurrent
  // writer fails instantly with "database is locked" (nodejs/node#57597,
  // nanobpm/nano-bpm#1287). Even the WAL switch below contends for the lock.
  db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs};`);
  db.exec('PRAGMA journal_mode = WAL;');
  // NORMAL is the recommended WAL pairing: durable against app crashes,
  // fsync only at checkpoints (vs. every commit with FULL).
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

export function migrate(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  );`);
  const applied = new Set(
    (db.prepare('SELECT id FROM schema_migrations').all() as unknown as { id: number }[]).map(
      (r) => r.id,
    ),
  );

  // Baseline: a database created before the migration system existed already
  // has the initial schema. Record migration 1 as applied instead of failing
  // on CREATE TABLE. (Real-world pattern for adopting migrations on live DBs.)
  if (applied.size === 0) {
    const legacy = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'applications'`)
      .get();
    if (legacy) {
      db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)').run(
        1,
        'initial-schema (baselined)',
        new Date().toISOString(),
      );
      applied.add(1);
    }
  }
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(migration.up);
      db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)').run(
        migration.id,
        migration.name,
        new Date().toISOString(),
      );
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`Migration ${migration.id} (${migration.name}) failed: ${String(err)}`);
    }
  }
}

const txDepth = new WeakMap<DatabaseSync, number>();

/**
 * Run fn inside a write transaction; rolls back on any throw.
 *
 * BEGIN IMMEDIATE (not DEFERRED): our transactions read then write
 * (e.g. getById → update). In WAL mode a deferred read→write upgrade
 * fails with SQLITE_BUSY *instantly*, ignoring busy_timeout, because
 * waiting cannot refresh a stale snapshot. Taking the write lock at
 * BEGIN is where the busy handler actually applies.
 *
 * Re-entrant: nested calls use SAVEPOINTs, so a failure deep in a call
 * stack (e.g. seed → create) rolls back only its own work, and the
 * outermost call decides the final commit.
 */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  const depth = txDepth.get(db) ?? 0;
  const savepoint = `sp_${depth}`;
  db.exec(depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`);
  txDepth.set(db, depth + 1);
  try {
    const result = fn();
    db.exec(depth === 0 ? 'COMMIT' : `RELEASE ${savepoint}`);
    return result;
  } catch (err) {
    if (depth === 0) {
      db.exec('ROLLBACK');
    } else {
      db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
    }
    throw err;
  } finally {
    txDepth.set(db, depth);
  }
}
