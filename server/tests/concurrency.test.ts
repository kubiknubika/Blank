import { describe, it, expect, beforeEach } from 'vitest';
import { createDb } from '../src/db.js';
import { makeTestApp } from './helpers.js';
import type { UserScope } from '../src/service.js';
import { PreconditionFailedError } from '../src/errors.js';
import { parseIfMatch } from '../src/http/concurrency.js';

/**
 * Optimistic concurrency: two tabs edit the same card. Without a guard,
 * the second save silently destroys the first (lost update). With
 * If-Match, the stale writer gets 412 and can rebase.
 */
describe('optimistic concurrency (ETag / If-Match)', () => {
  let agent: ReturnType<typeof makeTestApp>['agent'];
  let service: UserScope;
  let id: string;

  beforeEach(async () => {
    const ctx = makeTestApp();
    agent = ctx.agent;
    service = ctx.scope;
    const res = await agent.post('/api/applications').send({ company: 'Acme', position: 'FE' });
    id = res.body.id;
  });

  it('new rows start at version 1 and GET exposes a strong ETag', async () => {
    const res = await agent.get(`/api/applications/${id}`);
    expect(res.body.version).toBe(1);
    expect(res.headers.etag).toBe('"1"');
  });

  it('every field update bumps the version and returns the new ETag', async () => {
    const first = await agent.patch(`/api/applications/${id}`).send({ notes: 'one' });
    expect(first.body.version).toBe(2);
    expect(first.headers.etag).toBe('"2"');
    const second = await agent.patch(`/api/applications/${id}`).send({ notes: 'two' });
    expect(second.body.version).toBe(3);
  });

  it('If-Match with the current version succeeds', async () => {
    const res = await agent
      .patch(`/api/applications/${id}`)
      .set('If-Match', '"1"')
      .send({ notes: 'fresh' });
    expect(res.status).toBe(200);
    expect(res.body.version).toBe(2);
  });

  it('a stale If-Match gets 412 and does NOT overwrite the newer write', async () => {
    // Tab A saves first.
    await agent.patch(`/api/applications/${id}`).send({ notes: 'tab A' });
    // Tab B still holds version 1.
    const stale = await agent
      .patch(`/api/applications/${id}`)
      .set('If-Match', '"1"')
      .send({ notes: 'tab B' });
    expect(stale.status).toBe(412);
    expect(stale.body.code).toBe('PRECONDITION_FAILED');

    const current = await agent.get(`/api/applications/${id}`);
    expect(current.body.notes).toBe('tab A'); // not clobbered
    expect(current.body.version).toBe(2); // failed write did not bump
  });

  it('If-Match * passes for any existing row', async () => {
    await agent.patch(`/api/applications/${id}`).send({ notes: 'x' });
    const res = await agent
      .patch(`/api/applications/${id}`)
      .set('If-Match', '*')
      .send({ notes: 'y' });
    expect(res.status).toBe(200);
  });

  it('no If-Match keeps last-write-wins (drag-and-drop moves, old clients)', async () => {
    await agent.patch(`/api/applications/${id}`).send({ notes: 'a' });
    const res = await agent.patch(`/api/applications/${id}`).send({ notes: 'b' });
    expect(res.status).toBe(200);
    expect(res.body.notes).toBe('b');
  });

  it('malformed If-Match is a 400, not a silently ignored guard', async () => {
    for (const bad of ['1', 'W/"1"', '"abc"', '"1", "2"', '"0"', '-"1"']) {
      const res = await agent
        .patch(`/api/applications/${id}`)
        .set('If-Match', bad)
        .send({ notes: 'x' });
      expect(res.status, `If-Match: ${bad}`).toBe(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    }
  });

  it('412 does not record a phantom status event', async () => {
    await agent.patch(`/api/applications/${id}`).send({ status: 'applied' });
    const before = await agent.get(`/api/applications/${id}`);
    const stale = await agent
      .patch(`/api/applications/${id}`)
      .set('If-Match', '"1"')
      .send({ status: 'offer' });
    expect(stale.status).toBe(412);
    const after = await agent.get(`/api/applications/${id}`);
    expect(after.body.events).toHaveLength(before.body.events.length);
    expect(after.body.status).toBe('applied');
  });

  it('service-level compare-and-swap throws PreconditionFailedError', () => {
    service.update(id, { notes: 'first' }); // version 2
    expect(() => service.update(id, { notes: 'stale' }, 1)).toThrow(PreconditionFailedError);
    expect(service.get(id).notes).toBe('first');
  });

  it('migration 3 backfills version=1 on pre-existing rows', () => {
    // The beforeEach row was created through the API on a fresh schema;
    // simulate an older DB by checking the column default directly.
    const db = createDb(':memory:');
    db.prepare(
      `INSERT INTO applications (id, company, position, created_at, updated_at)
       VALUES ('legacy', 'Old', 'Row', 'now', 'now')`,
    ).run();
    const row = db.prepare('SELECT version FROM applications WHERE id = ?').get('legacy') as {
      version: number;
    };
    expect(row.version).toBe(1);
    db.close();
  });
});

describe('parseIfMatch', () => {
  it('accepts undefined, *, and quoted positive integers', () => {
    expect(parseIfMatch(undefined)).toBeUndefined();
    expect(parseIfMatch('*')).toBeUndefined();
    expect(parseIfMatch(' "42" ')).toBe(42);
  });

  it('rejects weak tags, lists and garbage', () => {
    for (const bad of ['W/"1"', '"1", "2"', 'unquoted', '""', '"999999999999999999999"']) {
      expect(() => parseIfMatch(bad), bad).toThrow();
    }
  });
});
