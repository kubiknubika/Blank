import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestApp, addTestUser, demoAgent, type TestContext } from './helpers.js';
import { buildOverview } from '../src/analytics.js';
import { seedDatabase } from '../src/seed.js';
import { NotFoundError } from '../src/errors.js';

/**
 * Multi-user isolation: the core security property of round 5.
 * User B must never see, mutate, or infer the existence of user A's rows.
 */
describe('multi-user isolation', () => {
  let ctx: TestContext;
  let alice: { agent: ReturnType<typeof makeTestApp>['agent']; userId: string };
  let bob: ReturnType<typeof addTestUser>;
  let aliceAppId: string;

  beforeEach(async () => {
    ctx = makeTestApp();
    alice = { agent: ctx.agent, userId: ctx.userId };
    bob = addTestUser(ctx);
    const created = await alice.agent
      .post('/api/applications')
      .send({ company: 'Alice Secret Co', position: 'Staff Engineer', notes: 'private' });
    aliceAppId = created.body.id;
  });

  it("list endpoints return only the caller's rows", async () => {
    const aliceList = await alice.agent.get('/api/applications');
    const bobList = await bob.agent.get('/api/applications');
    expect(aliceList.body).toHaveLength(1);
    expect(bobList.body).toHaveLength(0);
    expect(bobList.headers['x-total-count']).toBe('0');
  });

  it("another user's id reads as 404 — existence is not leaked as 403", async () => {
    const res = await bob.agent.get(`/api/applications/${aliceAppId}`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  it("another user's id cannot be patched, deleted, or annotated", async () => {
    const patch = await bob.agent.patch(`/api/applications/${aliceAppId}`).send({ notes: 'pwned' });
    expect(patch.status).toBe(404);
    const event = await bob.agent
      .post(`/api/applications/${aliceAppId}/events`)
      .send({ type: 'note', message: 'pwned' });
    expect(event.status).toBe(404);
    const del = await bob.agent.delete(`/api/applications/${aliceAppId}`);
    expect(del.status).toBe(404);

    // Alice's row is untouched.
    const intact = await alice.agent.get(`/api/applications/${aliceAppId}`);
    expect(intact.status).toBe(200);
    expect(intact.body.notes).toBe('private');
  });

  it('search and filters never cross the ownership boundary', async () => {
    const res = await bob.agent.get('/api/applications?q=Alice');
    expect(res.body).toHaveLength(0);
    expect(res.headers['x-total-count']).toBe('0');
  });

  it('analytics are per-user: dashboards and activity feeds do not mix', async () => {
    const aliceStats = await alice.agent.get('/api/analytics/overview');
    const bobStats = await bob.agent.get('/api/analytics/overview');
    expect(aliceStats.body.totals.total).toBe(1);
    expect(bobStats.body.totals.total).toBe(0);
    expect(aliceStats.body.recentEvents.length).toBeGreaterThan(0);
    expect(bobStats.body.recentEvents).toHaveLength(0);
    // Direct call agrees with the HTTP view.
    expect(buildOverview(ctx.db, bob.userId).totals.total).toBe(0);
  });

  it('demo reset reseeds ONLY the demo account', async () => {
    const demo = demoAgent(ctx);
    const reset = await demo.post('/api/demo/reset');
    expect(reset.status).toBe(200);
    expect(reset.body.applications).toBe(16);

    // Alice's data survived; demo data is invisible to her.
    const aliceList = await alice.agent.get('/api/applications');
    expect(aliceList.body).toHaveLength(1);
    expect(aliceList.body[0].company).toBe('Alice Secret Co');
    const demoList = await demo.get('/api/applications');
    expect(demoList.body).toHaveLength(16);
  });

  it('a regular account cannot trigger demo reset at all', async () => {
    const res = await alice.agent.post('/api/demo/reset');
    expect(res.status).toBe(403);
    const intact = await alice.agent.get('/api/applications');
    expect(intact.body).toHaveLength(1);
  });

  it('service-level scopes are isolated too (no HTTP involved)', () => {
    const aliceScope = ctx.service.forUser(alice.userId);
    const bobScope = ctx.service.forUser(bob.userId);
    expect(aliceScope.count()).toBe(1);
    expect(bobScope.count()).toBe(0);
    expect(() => bobScope.get(aliceAppId)).toThrow(NotFoundError);
    expect(() => bobScope.update(aliceAppId, { notes: 'x' })).toThrow(NotFoundError);
    expect(() => bobScope.delete(aliceAppId)).toThrow(NotFoundError);
    expect(() => bobScope.addEvent(aliceAppId, { type: 'note', message: 'x' })).toThrow(
      NotFoundError,
    );
  });

  it('every application row has an owner (repository binds user_id on insert)', async () => {
    seedDatabase(ctx.service.forUser(bob.userId));
    const ownerless = ctx.db
      .prepare('SELECT COUNT(*) n FROM applications WHERE user_id IS NULL')
      .get() as { n: number };
    expect(ownerless.n).toBe(0);
  });

  it("logout by one user does not affect the other's session", async () => {
    await bob.agent.post('/api/auth/logout');
    const bobAfter = await bob.agent.get('/api/applications');
    expect(bobAfter.status).toBe(401);
    const aliceAfter = await alice.agent.get('/api/applications');
    expect(aliceAfter.status).toBe(200);
  });
});
