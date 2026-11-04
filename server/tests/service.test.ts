import { describe, it, expect, beforeEach } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { createDb, transaction } from '../src/db.js';
import { ApplicationService } from '../src/service.js';
import { NotFoundError } from '../src/errors.js';

/**
 * Service-level tests with an injected clock — no HTTP, no timers,
 * deterministic timestamps.
 */
const FIXED_NOW = new Date('2026-11-04T12:00:00.000Z');

const baseInput = {
  company: 'Acme Corp',
  position: 'Frontend Engineer',
  status: 'wishlist',
  source: 'linkedin',
  priority: 'medium',
  location: null,
  workMode: 'remote',
  salaryMin: null,
  salaryMax: null,
  currency: 'EUR',
  url: null,
  notes: null,
  appliedAt: null,
} as const;

describe('ApplicationService', () => {
  let db: DatabaseSync;
  let service: ApplicationService;

  beforeEach(() => {
    db = createDb(':memory:');
    service = new ApplicationService(db, () => FIXED_NOW);
  });

  it('create stamps timestamps from the injected clock and logs an event', () => {
    const app = service.create({ ...baseInput });
    expect(app.createdAt).toBe(FIXED_NOW.toISOString());
    expect(app.events).toHaveLength(1);
    expect(app.events[0].type).toBe('created');
  });

  it('update to applied auto-fills appliedAt with the injected date', () => {
    const app = service.create({ ...baseInput });
    const updated = service.update(app.id, { status: 'applied' });
    expect(updated.appliedAt).toBe('2026-11-04');
  });

  it('update to applied respects an explicit appliedAt', () => {
    const app = service.create({ ...baseInput });
    const updated = service.update(app.id, { status: 'applied', appliedAt: '2026-10-01' });
    expect(updated.appliedAt).toBe('2026-10-01');
  });

  it('does not overwrite appliedAt on subsequent status changes', () => {
    const app = service.create({ ...baseInput });
    service.update(app.id, { status: 'applied' });
    const later = service.update(app.id, { status: 'interview' });
    expect(later.appliedAt).toBe('2026-11-04');
  });

  it('same-status update does not create a status event', () => {
    const app = service.create({ ...baseInput, status: 'applied', appliedAt: '2026-11-01' });
    const updated = service.update(app.id, { status: 'applied', notes: 'ping' });
    expect(updated.events.filter((e) => e.type === 'status')).toHaveLength(0);
  });

  it('get/update/delete/addEvent throw NotFoundError for unknown ids', () => {
    expect(() => service.get('nope')).toThrow(NotFoundError);
    expect(() => service.update('nope', { notes: 'x' })).toThrow(NotFoundError);
    expect(() => service.delete('nope')).toThrow(NotFoundError);
    expect(() => service.addEvent('nope', { type: 'note', message: 'x' })).toThrow(NotFoundError);
  });

  it('delete cascades events', () => {
    const app = service.create({ ...baseInput });
    service.addEvent(app.id, { type: 'note', message: 'remember me' });
    service.delete(app.id);
    const row = db
      .prepare('SELECT COUNT(*) AS n FROM events WHERE application_id = ?')
      .get(app.id) as { n: number };
    expect(row.n).toBe(0);
  });

  it('resetDemo is atomic: a failing seed leaves the old data intact', () => {
    const app = service.create({ ...baseInput, company: 'Original' });
    expect(() =>
      service.resetDemo(() => {
        throw new Error('seed exploded');
      }),
    ).toThrow('seed exploded');
    // Old data survived the rollback.
    expect(service.get(app.id).company).toBe('Original');
  });
});

describe('transaction()', () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = createDb(':memory:');
  });

  it('rolls back on throw', () => {
    expect(() =>
      transaction(db, () => {
        db.prepare(
          `INSERT INTO applications (id, company, position, created_at, updated_at)
           VALUES ('t1', 'T', 'T', 'now', 'now')`,
        ).run();
        throw new Error('boom');
      }),
    ).toThrow('boom');
    const row = db.prepare('SELECT COUNT(*) AS n FROM applications').get() as { n: number };
    expect(row.n).toBe(0);
  });

  it('nested transactions use savepoints: inner failure does not kill outer work', () => {
    transaction(db, () => {
      db.prepare(
        `INSERT INTO applications (id, company, position, created_at, updated_at)
         VALUES ('outer', 'O', 'O', 'now', 'now')`,
      ).run();
      try {
        transaction(db, () => {
          db.prepare(
            `INSERT INTO applications (id, company, position, created_at, updated_at)
             VALUES ('inner', 'I', 'I', 'now', 'now')`,
          ).run();
          throw new Error('inner boom');
        });
      } catch {
        // handled: outer work should survive
      }
    });
    const ids = (
      db.prepare('SELECT id FROM applications ORDER BY id').all() as unknown as { id: string }[]
    ).map((r) => r.id);
    expect(ids).toEqual(['outer']);
  });
});
