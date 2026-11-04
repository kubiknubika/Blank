import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS applications (
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
    updated_at TEXT NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL
  );`,
  `CREATE INDEX IF NOT EXISTS idx_applications_status ON applications(status);`,
  `CREATE INDEX IF NOT EXISTS idx_events_application ON events(application_id);`,
];

export function createDb(path: string): DatabaseSync {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  for (const migration of MIGRATIONS) {
    db.exec(migration);
  }
  return db;
}
