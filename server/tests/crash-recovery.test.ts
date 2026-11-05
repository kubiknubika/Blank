import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDb } from '../src/db.js';
import { ApplicationService } from '../src/service.js';
import { DEMO_USER_ID } from '../src/auth.js';
import { createApplicationSchema } from '@offerflow/shared/schemas';

/**
 * Crash recovery (ADR-0015): createDb documents that `synchronous=NORMAL`
 * in WAL mode is "durable against app crashes". This test PROVES that
 * claim instead of trusting it: a child process writes committed rows,
 * gets SIGKILLed mid-stream (no clean close, no checkpoint), and every
 * acknowledged commit must survive when the database is reopened.
 *
 * The child mirrors createDb's connection pragmas exactly and writes via
 * autocommitted INSERTs, printing each commit so the parent can kill it
 * after a known number of acknowledged writes. (Process death, not power
 * loss: the OS page cache survives SIGKILL, which is precisely the
 * failure mode NORMAL guarantees.)
 */

// Mirrors the durability-relevant pragmas in src/db.ts createDb().
const CHILD = `
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[1]);
db.exec('PRAGMA busy_timeout = 5000;');
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA synchronous = NORMAL;');
db.exec('PRAGMA foreign_keys = ON;');
const stmt = db.prepare(
  'INSERT INTO applications (id, company, position, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
);
let i = 0;
function tick() {
  i++;
  const ts = new Date().toISOString();
  stmt.run('crash-' + i, 'Crash Co ' + i, 'Engineer', 'demo', ts, ts);
  process.stdout.write('commit ' + i + '\\n');
  if (i < 100000) setImmediate(tick);
}
tick();
`;

const ACK_TARGET = 50;

describe('crash recovery: acknowledged writes survive SIGKILL', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'offerflow-crash-'));
    dbPath = path.join(dir, 'offerflow.db');
    const db = createDb(dbPath);
    new ApplicationService(db)
      .forUser(DEMO_USER_ID)
      .create(createApplicationSchema.parse({ company: 'Baseline Co', position: 'SRE' }));
    db.close();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('recovers every acknowledged commit with integrity intact', async () => {
    const child = spawn(process.execPath, ['-e', CHILD, dbPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Kill the child hard once it has acknowledged ACK_TARGET commits.
    await new Promise<void>((resolve, reject) => {
      let buf = '';
      let maxCommit = 0;
      let done = false;
      const finish = (fn: () => void) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        fn();
      };
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(() => reject(new Error(`child only reached ${maxCommit} commits in time`)));
      }, 15000);
      child.stdout!.on('data', (d: Buffer) => {
        buf += d.toString();
        for (const m of buf.matchAll(/commit (\d+)/g)) maxCommit = Math.max(maxCommit, +m[1]);
        if (maxCommit >= ACK_TARGET) {
          child.kill('SIGKILL');
          finish(resolve);
        }
      });
      child.on('error', (err) => finish(() => reject(err)));
      child.on('exit', () => {
        if (maxCommit < ACK_TARGET) {
          finish(() => reject(new Error(`child exited early at ${maxCommit} commits`)));
        }
      });
    });
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.on('exit', () => resolve());
    });

    // The crash left an uncheckpointed WAL behind — recovery must replay it.
    expect(existsSync(`${dbPath}-wal`)).toBe(true);

    // Reopen exactly as the server would on restart.
    const recovered = createDb(dbPath);
    try {
      expect(recovered.prepare('PRAGMA integrity_check').get()).toMatchObject({
        integrity_check: 'ok',
      });
      const ids = new Set(
        recovered
          .prepare('SELECT id FROM applications')
          .all()
          .map((r) => (r as { id: string }).id),
      );
      // Every acknowledged commit (1..ACK_TARGET) survived the hard kill.
      for (let i = 1; i <= ACK_TARGET; i++) {
        expect(ids.has(`crash-${i}`), `acknowledged commit crash-${i} was lost`).toBe(true);
      }
      expect(ids.has('crash-1')).toBe(true);
      // The pre-crash baseline row is intact too.
      const baseline = recovered
        .prepare('SELECT company FROM applications WHERE company = ?')
        .get('Baseline Co') as { company: string } | undefined;
      expect(baseline?.company).toBe('Baseline Co');

      // The app is fully functional on the recovered database.
      const scope = new ApplicationService(recovered).forUser(DEMO_USER_ID);
      expect(scope.listPage({}).total).toBeGreaterThanOrEqual(ACK_TARGET + 1);
      scope.create(createApplicationSchema.parse({ company: 'After Recovery', position: 'Eng' }));
      expect(scope.listPage({}).total).toBeGreaterThanOrEqual(ACK_TARGET + 2);
    } finally {
      recovered.close();
    }
  }, 30000);
});
