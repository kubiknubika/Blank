import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { ApplicationRepository } from '../src/repository.js';
import { seedDatabase } from '../src/seed.js';

function makeApp(): { app: Express; repo: ApplicationRepository } {
  const db = createDb(':memory:');
  return { app: createApp(db), repo: new ApplicationRepository(db) };
}

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
  let app: Express;
  let repo: ApplicationRepository;

  beforeEach(() => {
    ({ app, repo } = makeApp());
  });

  it('GET /api/health returns ok', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('POST /api/applications creates an application with defaults', async () => {
    const res = await request(app).post('/api/applications').send({
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

  it('POST /api/applications rejects invalid payloads', async () => {
    const res = await request(app).post('/api/applications').send({ company: '' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation failed');
    expect(res.body.details.length).toBeGreaterThan(0);
  });

  it('POST /api/applications rejects salaryMin > salaryMax', async () => {
    const res = await request(app)
      .post('/api/applications')
      .send({ ...validPayload, salaryMin: 90000, salaryMax: 80000 });
    expect(res.status).toBe(400);
  });

  it('POST /api/applications rejects an invalid URL', async () => {
    const res = await request(app)
      .post('/api/applications')
      .send({ ...validPayload, url: 'not-a-url' });
    expect(res.status).toBe(400);
  });

  it('GET /api/applications lists and filters by status and search', async () => {
    await request(app).post('/api/applications').send(validPayload);
    await request(app)
      .post('/api/applications')
      .send({ company: 'Globex', position: 'Data Engineer', status: 'wishlist' });

    const all = await request(app).get('/api/applications');
    expect(all.status).toBe(200);
    expect(all.body).toHaveLength(2);

    const filtered = await request(app).get('/api/applications?status=wishlist');
    expect(filtered.body).toHaveLength(1);
    expect(filtered.body[0].company).toBe('Globex');

    const searched = await request(app).get('/api/applications?q=acme');
    expect(searched.body).toHaveLength(1);
    expect(searched.body[0].company).toBe('Acme Corp');
  });

  it('GET /api/applications/:id returns 404 for unknown id', async () => {
    const res = await request(app).get('/api/applications/does-not-exist');
    expect(res.status).toBe(404);
  });

  it('PATCH updates fields and records a status-change event', async () => {
    const created = await request(app).post('/api/applications').send(validPayload);
    const id = created.body.id;

    const res = await request(app).patch(`/api/applications/${id}`).send({ status: 'interview' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('interview');
    const statusEvents = res.body.events.filter((e: { type: string }) => e.type === 'status');
    expect(statusEvents).toHaveLength(1);
    expect(statusEvents[0].message).toContain('applied → interview');
  });

  it('PATCH sets appliedAt automatically when moving to applied', async () => {
    const created = await request(app)
      .post('/api/applications')
      .send({ company: 'Acme', position: 'FE' });
    const res = await request(app)
      .patch(`/api/applications/${created.body.id}`)
      .send({ status: 'applied' });
    expect(res.body.appliedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('PATCH rejects an empty body', async () => {
    const created = await request(app).post('/api/applications').send(validPayload);
    const res = await request(app).patch(`/api/applications/${created.body.id}`).send({});
    expect(res.status).toBe(400);
  });

  it('DELETE removes the application and its events', async () => {
    const created = await request(app).post('/api/applications').send(validPayload);
    const id = created.body.id;
    const res = await request(app).delete(`/api/applications/${id}`);
    expect(res.status).toBe(204);
    expect(repo.getById(id)).toBeNull();
    const gone = await request(app).get(`/api/applications/${id}`);
    expect(gone.status).toBe(404);
  });

  it('POST /applications/:id/events adds a user event', async () => {
    const created = await request(app).post('/api/applications').send(validPayload);
    const res = await request(app)
      .post(`/api/applications/${created.body.id}/events`)
      .send({ type: 'note', message: 'Recruiter called, follow up Friday' });
    expect(res.status).toBe(201);
    expect(res.body.type).toBe('note');

    const detail = await request(app).get(`/api/applications/${created.body.id}`);
    expect(detail.body.events).toHaveLength(2);
  });

  it('POST /applications/:id/events forbids system event types', async () => {
    const created = await request(app).post('/api/applications').send(validPayload);
    const res = await request(app)
      .post(`/api/applications/${created.body.id}/events`)
      .send({ type: 'status', message: 'fake' });
    expect(res.status).toBe(400);
  });
});

describe('Analytics API', () => {
  it('returns a coherent overview for seeded data', async () => {
    const { app, repo } = makeApp();
    seedDatabase(repo);
    const res = await request(app).get('/api/analytics/overview');
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
    const { app } = makeApp();
    const res = await request(app).get('/api/analytics/overview');
    expect(res.status).toBe(200);
    expect(res.body.totals.total).toBe(0);
    expect(res.body.totals.responseRate).toBe(0);
    expect(res.body.totals.medianSalary).toBeNull();
  });

  it('POST /api/demo/reset reseeds the database', async () => {
    const { app } = makeApp();
    await request(app).post('/api/applications').send(validPayload);
    const res = await request(app).post('/api/demo/reset');
    expect(res.status).toBe(200);
    expect(res.body.applications).toBe(16);
  });
});
