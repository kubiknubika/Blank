import { describe, it, expect } from 'vitest';
import { makeTestApp, addTestUser } from './helpers.js';

/**
 * Property-based owner isolation (ADR-0014).
 *
 * The deterministic isolation suite checks named scenarios; this one
 * checks the SECURITY INVARIANT under random operation interleavings:
 * across hundreds of randomized list/get/patch/delete/event/archive/
 * restore/search/analytics/reminders/export calls by four users, no
 * response may ever contain another user's data, and a foreign id must
 * always read as 404 (never 403, never 200). Ordering-dependent leaks
 * that a fixed scenario would miss surface here.
 *
 * Deterministic mulberry32 seed -> reproducible, never flaky. Limiters
 * are off and the quota raised so every operation reaches the handler.
 */

const SEED = 0x1501a7;
const USERS = 4;
const OPS = 300;

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Distinctive per-user marker that cannot occur in random suffixes. */
const marker = (u: number) => `OWN${u}#`;

interface AppRow {
  id: string;
  owner: number;
  deleted: boolean;
  archived: boolean;
}

describe('property: owner isolation holds under random interleavings', () => {
  it(`${OPS} randomized operations across ${USERS} users never leak`, async () => {
    const rng = mulberry32(SEED);
    const ri = (n: number) => Math.floor(rng() * n);
    const pick = <T>(arr: T[]): T => arr[ri(arr.length)];

    const ctx = makeTestApp({
      rateLimit: { max: 0 },
      readRateLimit: { max: 0 },
      limits: { maxApplicationsPerUser: 1_000_000 },
    });
    // Four authenticated users on the same app.
    const users = [
      { agent: ctx.agent, userId: ctx.userId },
      addTestUser(ctx),
      addTestUser(ctx),
      addTestUser(ctx),
    ];

    // Seed each user with a handful of marked applications.
    const apps: AppRow[] = [];
    for (let u = 0; u < USERS; u++) {
      const count = 6 + ri(5);
      for (let k = 0; k < count; k++) {
        const res = await users[u].agent.post('/api/applications').send({
          company: `${marker(u)}${k}-${ri(1e6)}`,
          position: 'Engineer',
          status: pick(['wishlist', 'applied', 'interview', 'offer', 'rejected']),
          notes: `private-${u}`,
          followUpAt: rng() < 0.4 ? '2026-12-01' : null,
        });
        expect(res.status, `seed user ${u}`).toBe(201);
        apps.push({ id: res.body.id, owner: u, deleted: false, archived: false });
      }
    }

    /** No foreign marker may appear anywhere in a response payload. */
    const assertNoLeak = (body: unknown, actor: number, where: string) => {
      const text = typeof body === 'string' ? body : JSON.stringify(body);
      for (let u = 0; u < USERS; u++) {
        if (u === actor) continue;
        expect(
          text.includes(marker(u)),
          `LEAK seed=${SEED} ${where}: user ${actor} saw user ${u}'s data`,
        ).toBe(false);
      }
    };

    const idOps = ['get', 'patch', 'delete', 'event', 'archive', 'restore'] as const;
    const readOps = ['list', 'search', 'analytics', 'reminders', 'export'] as const;
    let foreignProbes = 0;
    let ownSuccesses = 0;

    for (let i = 0; i < OPS; i++) {
      const actor = ri(USERS);
      const agent = users[actor].agent;
      const isIdOp = rng() < 0.6;

      if (isIdOp) {
        const op = pick([...idOps]);
        // Bias toward the actor's own rows so success paths are exercised,
        // but frequently probe foreign rows to test the 404 boundary.
        const own = apps.filter((a) => a.owner === actor);
        const target = rng() < 0.5 && own.length ? pick(own) : pick(apps);
        const path = `/api/applications/${target.id}${op === 'event' ? '/events' : op === 'archive' ? '/archive' : op === 'restore' ? '/restore' : ''}`;
        const where = `iter=${i} actor=${actor} op=${op} owner=${target.owner}`;

        let res;
        if (op === 'get') res = await agent.get(path);
        else if (op === 'patch') res = await agent.patch(path).send({ notes: `touch-${i}` });
        else if (op === 'delete') res = await agent.delete(path);
        else if (op === 'event')
          res = await agent.post(path).send({ type: 'note', message: `note-${i}` });
        else if (op === 'archive') res = await agent.post(path);
        else res = await agent.post(path); // restore

        const foreign = target.owner !== actor;
        if (foreign || target.deleted) {
          // Foreign or already-deleted rows must never be readable/mutable.
          expect(res.status, `${where} → expected 404, got ${res.status}`).toBe(404);
          expect(res.body.code).toBe('NOT_FOUND');
          if (foreign) foreignProbes++;
        } else {
          // Own, live row: the operation succeeds.
          const ok = op === 'delete' ? 204 : op === 'event' ? 201 : 200;
          expect(res.status, `${where} → expected ${ok}, got ${res.status}`).toBe(ok);
          ownSuccesses++;
          if (op === 'delete') target.deleted = true;
          if (op === 'archive') target.archived = true;
          if (op === 'restore') target.archived = false;
          if (op !== 'delete') assertNoLeak(res.body, actor, where);
        }
      } else {
        const op = pick([...readOps]);
        const where = `iter=${i} actor=${actor} op=${op}`;
        let res;
        if (op === 'list') res = await agent.get('/api/applications?limit=500');
        else if (op === 'search')
          res = await agent.get(`/api/applications?q=${encodeURIComponent(marker(actor))}`);
        else if (op === 'analytics') res = await agent.get('/api/analytics/overview');
        else if (op === 'reminders') res = await agent.get('/api/reminders');
        else res = await agent.get('/api/export/csv');
        expect(res.status, `${where} → ${res.status}`).toBe(200);
        assertNoLeak(res.body, actor, where);
      }
    }

    // The fuzzer must have exercised both sides of the boundary.
    expect(foreignProbes, 'no foreign-id probes happened').toBeGreaterThan(20);
    expect(ownSuccesses, 'no own-row successes happened').toBeGreaterThan(20);

    // Final consistency: each user's active board is EXACTLY their own
    // surviving, non-archived rows — no more (leak), no less (loss).
    for (let u = 0; u < USERS; u++) {
      const res = await users[u].agent.get('/api/applications?limit=500');
      const expected = apps
        .filter((a) => a.owner === u && !a.deleted && !a.archived)
        .map((a) => a.id)
        .sort();
      const actual = (res.body as { id: string }[]).map((a) => a.id).sort();
      expect(actual, `user ${u} final board mismatch`).toEqual(expected);
      assertNoLeak(res.body, u, `final user=${u}`);
    }
  });
});
