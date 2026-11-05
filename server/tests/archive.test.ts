import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createDb } from '../src/db.js';
import { ApplicationService, type UserScope } from '../src/service.js';
import { DEMO_USER_ID } from '../src/auth.js';
import { makeTestApp, addTestUser } from './helpers.js';
import { createApplicationSchema } from '@offerflow/shared/schemas';
import { buildOverview } from '../src/analytics.js';

const FIXED_NOW = new Date('2026-11-05T12:00:00.000Z');

describe('archive: service rules', () => {
  let service: UserScope;

  beforeEach(() => {
    const db = createDb(':memory:');
    service = new ApplicationService(db, () => FIXED_NOW).forUser(DEMO_USER_ID);
  });

  const create = (company = 'Acme', followUpAt: string | null = null) =>
    service.create(createApplicationSchema.parse({ company, position: 'FE', followUpAt }));

  it('archive stamps archivedAt, bumps version, and logs an event', () => {
    const app = create();
    const archived = service.archive(app.id);
    expect(archived.archivedAt).toBe(FIXED_NOW.toISOString());
    expect(archived.version).toBe(app.version + 1);
    expect(
      archived.events.some((e) => e.type === 'archive' && e.message === 'Application archived'),
    ).toBe(true);
  });

  it('archive and restore are idempotent (no event, no version bump on repeat)', () => {
    const app = create();
    const once = service.archive(app.id);
    const twice = service.archive(app.id);
    expect(twice.version).toBe(once.version);
    expect(twice.events.filter((e) => e.type === 'archive')).toHaveLength(1);

    const restored = service.restore(app.id);
    expect(restored.archivedAt).toBeNull();
    const again = service.restore(app.id);
    expect(again.version).toBe(restored.version);
    expect(again.events.filter((e) => e.message === 'Application restored')).toHaveLength(1);
  });

  it('archived rows leave the active list and appear in the archive list', () => {
    const a = create('Gone');
    create('Stays');
    service.archive(a.id);
    expect(
      service.listPage({ archived: 'false', limit: 100, offset: 0 }).items.map((x) => x.company),
    ).toEqual(['Stays']);
    expect(
      service.listPage({ archived: 'true', limit: 100, offset: 0 }).items.map((x) => x.company),
    ).toEqual(['Gone']);
  });

  it('archived rows leave analytics and reminders', () => {
    const db = createDb(':memory:');
    const svc = new ApplicationService(db, () => FIXED_NOW).forUser(DEMO_USER_ID);
    const app = svc.create(
      createApplicationSchema.parse({
        company: 'A',
        position: 'FE',
        followUpAt: '2026-11-06',
        status: 'interview',
      }),
    );
    expect(buildOverview(db, DEMO_USER_ID).totals.total).toBe(1);
    expect(svc.listReminders()).toHaveLength(1);
    svc.archive(app.id);
    expect(buildOverview(db, DEMO_USER_ID).totals.total).toBe(0);
    expect(svc.listReminders()).toHaveLength(0);
    svc.restore(app.id);
    expect(buildOverview(db, DEMO_USER_ID).totals.total).toBe(1);
    expect(svc.listReminders()).toHaveLength(1);
  });

  it('CSV export includes archived rows with their timestamp', () => {
    const app = create('Archived Co');
    service.archive(app.id);
    const csv = service.exportCsv();
    expect(csv).toContain('Archived Co');
    expect(csv).toContain(FIXED_NOW.toISOString());
  });
});

describe('archive + CSV: HTTP and isolation', () => {
  it('archive/restore require a session and hide foreign ids', async () => {
    const ctx = makeTestApp();
    const bob = addTestUser(ctx);
    const created = await ctx.agent
      .post('/api/applications')
      .send({ company: 'A', position: 'FE' });
    const id = created.body.id;

    expect((await request(ctx.app).post(`/api/applications/${id}/archive`)).status).toBe(401);
    expect((await bob.agent.post(`/api/applications/${id}/archive`)).status).toBe(404);
    expect((await bob.agent.post(`/api/applications/${id}/restore`)).status).toBe(404);

    const archived = await ctx.agent.post(`/api/applications/${id}/archive`);
    expect(archived.status).toBe(200);
    expect(archived.body.archivedAt).toBeTruthy();

    // Disappears from the active board, visible with ?archived=true.
    expect((await ctx.agent.get('/api/applications')).body).toHaveLength(0);
    const archiveList = await ctx.agent.get('/api/applications?archived=true');
    expect(archiveList.body).toHaveLength(1);

    const restored = await ctx.agent.post(`/api/applications/${id}/restore`);
    expect(restored.body.archivedAt).toBeNull();
  });

  it("export downloads only the caller's rows as an attachment", async () => {
    const ctx = makeTestApp();
    const bob = addTestUser(ctx);
    await ctx.agent.post('/api/applications').send({ company: 'Alice Export Co', position: 'FE' });
    await bob.agent.post('/api/applications').send({ company: 'Bob Secret Co', position: 'BE' });

    expect((await request(ctx.app).get('/api/export/csv')).status).toBe(401);
    const res = await ctx.agent.get('/api/export/csv');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toMatch(
      /attachment; filename="offerflow-\d{4}-\d{2}-\d{2}\.csv"/,
    );
    expect(res.text).toContain('Alice Export Co');
    expect(res.text).not.toContain('Bob Secret Co');
  });

  it('import is atomic: one bad row writes nothing', async () => {
    const ctx = makeTestApp();
    const res = await ctx.agent
      .post('/api/import/csv')
      .send({ csv: 'company,position\nGood Co,FE\n,BE\n' });
    expect(res.status).toBe(400);
    expect(res.body.details.some((d: { path: string }) => d.path === 'row 3: company')).toBe(true);
    expect((await ctx.agent.get('/api/applications')).body).toHaveLength(0);
  });

  it('import lands rows (incl. archived) and round-trips the export', async () => {
    const ctx = makeTestApp();
    const created = await ctx.agent.post('/api/applications').send({
      company: 'Round,Trip "Co"',
      position: 'SRE',
      notes: '=1+1',
      followUpAt: '2026-11-20',
    });
    await ctx.agent.post(`/api/applications/${created.body.id}/archive`);

    const exported = await ctx.agent.get('/api/export/csv');
    const fresh = makeTestApp();
    const imported = await fresh.agent.post('/api/import/csv').send({ csv: exported.text });
    expect(imported.status).toBe(201);
    expect(imported.body.imported).toBe(1);

    const active = await fresh.agent.get('/api/applications');
    expect(active.body).toHaveLength(0); // was archived in the export
    const archive = await fresh.agent.get('/api/applications?archived=true');
    expect(archive.body).toHaveLength(1);
    expect(archive.body[0].company).toBe('Round,Trip "Co"');
    expect(archive.body[0].notes).toBe('=1+1');
    expect(archive.body[0].followUpAt).toBe('2026-11-20');
  });

  it('import validates the JSON envelope and the row cap', async () => {
    const ctx = makeTestApp();
    expect((await ctx.agent.post('/api/import/csv').send({})).status).toBe(400);
    const big = 'company,position\n' + 'A,FE\n'.repeat(1001);
    const res = await ctx.agent.post('/api/import/csv').send({ csv: big });
    expect(res.status).toBe(400);
    expect(res.body.details[0].message).toMatch(/Too many rows/);
  });

  it('the archive event type is not user-writable', async () => {
    const ctx = makeTestApp();
    const created = await ctx.agent
      .post('/api/applications')
      .send({ company: 'A', position: 'FE' });
    const res = await ctx.agent
      .post(`/api/applications/${created.body.id}/events`)
      .send({ type: 'archive', message: 'fake' });
    expect(res.status).toBe(400);
  });
});
