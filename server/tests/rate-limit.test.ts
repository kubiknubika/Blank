import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestApp } from './helpers.js';

/**
 * The mutation budget: a compromised script (or a buggy retry loop)
 * must not be able to hammer writes. Reads have a separate, generous
 * budget (analytics/export are CPU levers); operational probes are
 * exempt so health checks never trip a limiter.
 */
describe('rate limiting (per-IP)', () => {
  let agent: ReturnType<typeof makeTestApp>['agent'];
  let clock: number;

  beforeEach(() => {
    clock = 1_000_000;
    ({ agent } = makeTestApp({
      rateLimit: { windowMs: 60_000, max: 3, now: () => clock },
    }));
  });

  const create = () => agent.post('/api/applications').send({ company: 'Acme', position: 'FE' });

  it('allows up to the budget, then returns 429 with code and Retry-After', async () => {
    for (let i = 0; i < 3; i++) {
      const ok = await create();
      expect(ok.status).toBe(201);
      expect(ok.headers['x-ratelimit-remaining']).toBe(String(2 - i));
    }
    const blocked = await create();
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe('RATE_LIMITED');
    expect(blocked.body.requestId).toBeTruthy();
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(blocked.headers['x-ratelimit-limit']).toBe('3');
    expect(blocked.headers['x-ratelimit-remaining']).toBe('0');
  });

  it('a rejected request creates nothing', async () => {
    for (let i = 0; i < 4; i++) await create();
    const list = await agent.get('/api/applications');
    expect(list.body).toHaveLength(3); // the 4th (429) never reached the service
  });

  it('reads do not consume the mutation budget; probes are exempt', async () => {
    for (let i = 0; i < 10; i++) {
      const res = await agent.get('/api/applications');
      expect(res.status).toBe(200);
      // Reads carry their OWN generous budget (default 600), not the
      // mutation budget of 3 configured for this test app.
      expect(res.headers['x-ratelimit-limit']).toBe('600');
    }
    // The mutation budget is still intact after all those reads.
    for (let i = 0; i < 3; i++) expect((await create()).status).toBe(201);
    for (const probe of ['/api/health', '/api/ready', '/api/metrics', '/api/openapi.json']) {
      const res = await agent.get(probe);
      expect(res.status).toBe(200);
      expect(res.headers['x-ratelimit-limit']).toBeUndefined();
    }
  });

  it('reads have their own budget, with 429 + Retry-After when exhausted', async () => {
    const readLimited = makeTestApp({
      readRateLimit: { windowMs: 60_000, max: 2, now: () => clock },
    });
    for (let i = 0; i < 2; i++) {
      expect((await readLimited.agent.get('/api/applications')).status).toBe(200);
    }
    const blocked = await readLimited.agent.get('/api/applications');
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe('RATE_LIMITED');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    // Mutations are a different bucket and still work.
    expect(
      (await readLimited.agent.post('/api/applications').send({ company: 'Acme', position: 'FE' }))
        .status,
    ).toBe(201);
    // Probes never see the read limiter even when the bucket is empty.
    expect((await readLimited.agent.get('/api/health')).status).toBe(200);
    expect((await readLimited.agent.get('/api/ready')).status).toBe(200);
    // Window rollover restores the read budget.
    clock += 60_001;
    expect((await readLimited.agent.get('/api/applications')).status).toBe(200);
  });

  it('readRateLimit max: 0 disables the read limiter', async () => {
    const unlimited = makeTestApp({ readRateLimit: { max: 0 } });
    for (let i = 0; i < 8; i++) {
      const res = await unlimited.agent.get('/api/applications');
      expect(res.status).toBe(200);
      expect(res.headers['x-ratelimit-limit']).toBeUndefined();
    }
  });

  it('the budget resets when the window rolls over', async () => {
    for (let i = 0; i < 4; i++) await create();
    expect((await create()).status).toBe(429);
    clock += 60_001; // next window
    expect((await create()).status).toBe(201);
  });

  it('counts all mutation methods against one budget', async () => {
    const created = await create();
    const id = created.body.id;
    await agent.patch(`/api/applications/${id}`).send({ notes: 'x' });
    await agent.post(`/api/applications/${id}/events`).send({ type: 'note', message: 'hi' });
    const blocked = await agent.delete(`/api/applications/${id}`);
    expect(blocked.status).toBe(429);
  });

  it('429s short-circuit BEFORE body parsing: invalid JSON still gets 429, not 400', async () => {
    for (let i = 0; i < 3; i++) await create();
    const res = await agent
      .post('/api/applications')
      .set('Content-Type', 'application/json')
      .send('{broken json');
    expect(res.status).toBe(429);
  });

  it('max: 0 disables the limiter entirely', async () => {
    const unlimited = makeTestApp({ rateLimit: { max: 0 } });
    for (let i = 0; i < 8; i++) {
      const res = await unlimited.agent
        .post('/api/applications')
        .send({ company: 'Acme', position: 'FE' });
      expect(res.status).toBe(201);
      expect(res.headers['x-ratelimit-limit']).toBeUndefined();
    }
  });

  it('buckets are per-IP when a trusted proxy forwards the client address', async () => {
    const proxied = makeTestApp({
      trustProxyHops: 1,
      rateLimit: { windowMs: 60_000, max: 1, now: () => clock },
    });
    const a = () =>
      proxied.agent
        .post('/api/applications')
        .set('X-Forwarded-For', '203.0.113.10')
        .send({ company: 'A', position: 'FE' });
    const b = () =>
      proxied.agent
        .post('/api/applications')
        .set('X-Forwarded-For', '203.0.113.20')
        .send({ company: 'B', position: 'FE' });
    expect((await a()).status).toBe(201);
    expect((await a()).status).toBe(429); // same client, exhausted
    expect((await b()).status).toBe(201); // different client, fresh bucket
  });

  it('without trusted proxy hops, spoofed X-Forwarded-For does not mint new buckets', async () => {
    for (let i = 0; i < 3; i++) {
      await agent
        .post('/api/applications')
        .set('X-Forwarded-For', `198.51.100.${i}`)
        .send({ company: 'Acme', position: 'FE' });
    }
    const res = await agent
      .post('/api/applications')
      .set('X-Forwarded-For', '198.51.100.99')
      .send({ company: 'Acme', position: 'FE' });
    expect(res.status).toBe(429); // still the socket IP's bucket
  });
});
