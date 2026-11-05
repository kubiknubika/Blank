import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestApp, demoAgent } from './helpers.js';
import type { UserScope } from '../src/service.js';
import { seedDatabase } from '../src/seed.js';

const validPayload = {
  company: 'Acme Corp',
  position: 'Frontend Engineer',
  status: 'applied',
  source: 'linkedin',
  salaryMin: 60000,
  salaryMax: 80000,
  location: 'Berlin, DE',
};

describe('Applications API', () => {
  let agent: ReturnType<typeof makeTestApp>['agent'];
  let service: UserScope;

  beforeEach(() => {
    ({ agent, scope: service } = makeTestApp());
  });

  it('GET /api/health returns ok', async () => {
    const res = await agent.get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('attaches a request id to every response', async () => {
    const res = await agent.get('/api/health');
    expect(res.headers['x-request-id']).toMatch(/[0-9a-f-]{36}/);
  });

  it('echoes a caller-provided request id', async () => {
    const res = await agent.get('/api/health').set('x-request-id', 'trace-me-123');
    expect(res.headers['x-request-id']).toBe('trace-me-123');
  });

  it('POST /api/applications creates an application with defaults', async () => {
    const res = await agent.post('/api/applications').send({
      company: 'Acme Corp',
      position: 'Backend Engineer',
    });
    expect(res.status).toBe(201);
    expect(res.body.company).toBe('Acme Corp');
    expect(res.body.status).toBe('wishlist');
    expect(res.body.currency).toBe('EUR');
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0].type).toBe('created');
  });

  it('validation errors carry a machine-readable code and field details', async () => {
    const res = await agent.post('/api/applications').send({ company: '' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(res.body.requestId).toBeTruthy();
    expect(res.body.details.length).toBeGreaterThan(0);
    expect(res.body.details[0]).toHaveProperty('path');
    expect(res.body.details[0]).toHaveProperty('message');
  });

  it('POST /api/applications rejects salaryMin > salaryMax', async () => {
    const res = await agent
      .post('/api/applications')
      .send({ ...validPayload, salaryMin: 90000, salaryMax: 80000 });
    expect(res.status).toBe(400);
  });

  it('POST /api/applications rejects an invalid URL', async () => {
    const res = await agent.post('/api/applications').send({ ...validPayload, url: 'not-a-url' });
    expect(res.status).toBe(400);
  });

  it('malformed JSON returns INVALID_JSON, not a crash', async () => {
    const res = await agent
      .post('/api/applications')
      .set('Content-Type', 'application/json')
      .send('{broken');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_JSON');
  });

  it('GET /api/applications lists and filters by status and search', async () => {
    await agent.post('/api/applications').send(validPayload);
    await agent
      .post('/api/applications')
      .send({ company: 'Globex', position: 'Data Engineer', status: 'wishlist' });

    const all = await agent.get('/api/applications');
    expect(all.status).toBe(200);
    expect(all.body).toHaveLength(2);

    const filtered = await agent.get('/api/applications?status=wishlist');
    expect(filtered.body).toHaveLength(1);
    expect(filtered.body[0].company).toBe('Globex');

    const searched = await agent.get('/api/applications?q=acme');
    expect(searched.body).toHaveLength(1);
    expect(searched.body[0].company).toBe('Acme Corp');
  });

  it('GET /api/applications supports limit and offset', async () => {
    for (let i = 0; i < 5; i++) {
      await agent.post('/api/applications').send({ company: `Co ${i}`, position: 'FE' });
    }
    const page = await agent.get('/api/applications?limit=2&offset=0');
    expect(page.body).toHaveLength(2);
    const bad = await agent.get('/api/applications?limit=9999');
    expect(bad.status).toBe(400);
  });

  it('GET /api/applications/:id returns a coded 404 for unknown id', async () => {
    const res = await agent.get('/api/applications/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  it('PATCH updates fields and records a status-change event', async () => {
    const created = await agent.post('/api/applications').send(validPayload);
    const id = created.body.id;

    const res = await agent.patch(`/api/applications/${id}`).send({ status: 'interview' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('interview');
    const statusEvents = res.body.events.filter((e: { type: string }) => e.type === 'status');
    expect(statusEvents).toHaveLength(1);
    expect(statusEvents[0].message).toContain('applied → interview');
  });

  it('PATCH sets appliedAt automatically when moving to applied', async () => {
    const created = await agent.post('/api/applications').send({ company: 'Acme', position: 'FE' });
    const res = await agent
      .patch(`/api/applications/${created.body.id}`)
      .send({ status: 'applied' });
    expect(res.body.appliedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('PATCH rejects an empty body', async () => {
    const created = await agent.post('/api/applications').send(validPayload);
    const res = await agent.patch(`/api/applications/${created.body.id}`).send({});
    expect(res.status).toBe(400);
  });

  it('DELETE removes the application and its events', async () => {
    const created = await agent.post('/api/applications').send(validPayload);
    const id = created.body.id;
    const res = await agent.delete(`/api/applications/${id}`);
    expect(res.status).toBe(204);
    expect(() => service.get(id)).toThrow(/not found/);
    const gone = await agent.get(`/api/applications/${id}`);
    expect(gone.status).toBe(404);
  });

  it('POST /applications/:id/events adds a user event', async () => {
    const created = await agent.post('/api/applications').send(validPayload);
    const res = await agent
      .post(`/api/applications/${created.body.id}/events`)
      .send({ type: 'note', message: 'Recruiter called, follow up Friday' });
    expect(res.status).toBe(201);
    expect(res.body.type).toBe('note');

    const detail = await agent.get(`/api/applications/${created.body.id}`);
    expect(detail.body.events).toHaveLength(2);
  });

  it('POST /applications/:id/events forbids system event types', async () => {
    const created = await agent.post('/api/applications').send(validPayload);
    const res = await agent
      .post(`/api/applications/${created.body.id}/events`)
      .send({ type: 'status', message: 'fake' });
    expect(res.status).toBe(400);
  });

  it('POST /applications/:id/events on unknown id returns 404', async () => {
    const res = await agent
      .post('/api/applications/nope/events')
      .send({ type: 'note', message: 'hi' });
    expect(res.status).toBe(404);
  });
});

describe('Analytics API', () => {
  it('returns a coherent overview for seeded data', async () => {
    const ctx = makeTestApp();
    ctx.scope.resetDemo(seedDatabase);
    const res = await ctx.agent.get('/api/analytics/overview');
    expect(res.status).toBe(200);
    expect(res.body.totals.total).toBe(16);
    expect(res.body.totals.offers).toBe(1);
    expect(res.body.byStatus).toHaveLength(6);
    expect(res.body.weekly).toHaveLength(8);
    expect(res.body.totals.responseRate).toBeGreaterThan(0);
    expect(res.body.totals.medianSalary).toBeGreaterThan(0);
    const sum = res.body.byStatus.reduce((s: number, x: { count: number }) => s + x.count, 0);
    expect(sum).toBe(16);
  });

  it('handles an empty database without dividing by zero', async () => {
    const ctx = makeTestApp();
    const res = await ctx.agent.get('/api/analytics/overview');
    expect(res.status).toBe(200);
    expect(res.body.totals.total).toBe(0);
    expect(res.body.totals.responseRate).toBe(0);
    expect(res.body.totals.medianSalary).toBeNull();
  });

  it('POST /api/demo/reset reseeds the database for the demo account', async () => {
    const ctx = makeTestApp();
    const demo = demoAgent(ctx);
    await demo.post('/api/applications').send(validPayload);
    const res = await demo.post('/api/demo/reset');
    expect(res.status).toBe(200);
    expect(res.body.applications).toBe(16);
  });

  it('POST /api/demo/reset is forbidden for regular accounts', async () => {
    const ctx = makeTestApp();
    const res = await ctx.agent.post('/api/demo/reset');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });
});
