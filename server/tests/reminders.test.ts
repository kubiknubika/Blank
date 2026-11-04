import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createDb } from '../src/db.js';
import { ApplicationService, type UserScope } from '../src/service.js';
import { DEMO_USER_ID } from '../src/auth.js';
import { makeTestApp, addTestUser } from './helpers.js';
import { createApplicationSchema } from '@offerflow/shared/schemas';

const FIXED_NOW = new Date('2026-11-04T12:00:00.000Z');

describe('reminders: service rules', () => {
  let service: UserScope;

  beforeEach(() => {
    const db = createDb(':memory:');
    service = new ApplicationService(db, () => FIXED_NOW).forUser(DEMO_USER_ID);
  });

  const create = (followUpAt: string | null = null, company = 'Acme') =>
    service.create(createApplicationSchema.parse({ company, position: 'FE', followUpAt }));

  it('scheduling a follow-up records a reminder event atomically', () => {
    const app = create();
    const updated = service.update(app.id, { followUpAt: '2026-11-10' });
    expect(updated.followUpAt).toBe('2026-11-10');
    const events = updated.events.filter((e) => e.type === 'reminder');
    expect(events).toHaveLength(1);
    expect(events[0].message).toBe('Follow-up scheduled for 2026-11-10');
    expect(events[0].createdAt).toBe(FIXED_NOW.toISOString());
  });

  it('rescheduling replaces the date and logs the new one', () => {
    const app = create('2026-11-05');
    const updated = service.update(app.id, { followUpAt: '2026-11-12' });
    expect(updated.followUpAt).toBe('2026-11-12');
    expect(updated.events.filter((e) => e.type === 'reminder')).toHaveLength(1);
  });

  it('setting the same date is a no-op for the timeline', () => {
    const app = create('2026-11-05');
    const updated = service.update(app.id, { followUpAt: '2026-11-05', notes: 'x' });
    expect(updated.events.filter((e) => e.type === 'reminder')).toHaveLength(0);
  });

  it('clearing a follow-up records a cleared event', () => {
    const app = create('2026-11-05');
    const updated = service.update(app.id, { followUpAt: null });
    expect(updated.followUpAt).toBeNull();
    const events = updated.events.filter((e) => e.type === 'reminder');
    expect(events).toHaveLength(1);
    expect(events[0].message).toBe('Follow-up cleared');
  });

  it('moving to rejected auto-clears the follow-up with an explanatory event', () => {
    const app = create('2026-11-05');
    const updated = service.update(app.id, { status: 'rejected' });
    expect(updated.followUpAt).toBeNull();
    const events = updated.events.filter((e) => e.type === 'reminder');
    expect(events).toHaveLength(1);
    expect(events[0].message).toBe('Follow-up cleared (application rejected)');
    // The status event is still there too.
    expect(updated.events.filter((e) => e.type === 'status')).toHaveLength(1);
  });

  it('an explicit followUpAt in the same patch wins over auto-clear', () => {
    const app = create('2026-11-05');
    const updated = service.update(app.id, { status: 'rejected', followUpAt: '2026-12-01' });
    expect(updated.followUpAt).toBe('2026-12-01');
    expect(updated.events.some((e) => e.message === 'Follow-up scheduled for 2026-12-01')).toBe(
      true,
    );
  });

  it('other status changes keep the follow-up', () => {
    const app = create('2026-11-05');
    const updated = service.update(app.id, { status: 'interview' });
    expect(updated.followUpAt).toBe('2026-11-05');
  });

  it('listReminders returns only dated rows, soonest first', () => {
    create(null, 'No reminder');
    create('2026-11-20', 'Later');
    create('2026-11-01', 'Overdue');
    create('2026-11-04', 'Today');
    const reminders = service.listReminders();
    expect(reminders.map((r) => r.company)).toEqual(['Overdue', 'Today', 'Later']);
  });

  it('a rejected application drops out of the reminders list', () => {
    const app = create('2026-11-05');
    expect(service.listReminders()).toHaveLength(1);
    service.update(app.id, { status: 'rejected' });
    expect(service.listReminders()).toHaveLength(0);
  });
});

describe('reminders: HTTP + isolation', () => {
  it("GET /api/reminders requires a session and returns the caller's rows only", async () => {
    const ctx = makeTestApp();
    const bob = addTestUser(ctx);

    expect((await request(ctx.app).get('/api/reminders')).status).toBe(401);

    await ctx.agent
      .post('/api/applications')
      .send({ company: 'Alice Co', position: 'FE', followUpAt: '2026-11-06' });
    await bob.agent
      .post('/api/applications')
      .send({ company: 'Bob Co', position: 'BE', followUpAt: '2026-11-07' });

    const aliceList = await ctx.agent.get('/api/reminders');
    expect(aliceList.status).toBe(200);
    expect(aliceList.body).toHaveLength(1);
    expect(aliceList.body[0].company).toBe('Alice Co');
    expect(aliceList.body[0].followUpAt).toBe('2026-11-06');

    const bobList = await bob.agent.get('/api/reminders');
    expect(bobList.body).toHaveLength(1);
    expect(bobList.body[0].company).toBe('Bob Co');
  });

  it('PATCH validates the date format and empty string clears', async () => {
    const ctx = makeTestApp();
    const created = await ctx.agent
      .post('/api/applications')
      .send({ company: 'Acme', position: 'FE', followUpAt: '2026-11-06' });
    const id = created.body.id;

    const bad = await ctx.agent.patch(`/api/applications/${id}`).send({ followUpAt: '11/06/2026' });
    expect(bad.status).toBe(400);

    const cleared = await ctx.agent.patch(`/api/applications/${id}`).send({ followUpAt: '' });
    expect(cleared.status).toBe(200);
    expect(cleared.body.followUpAt).toBeNull();
  });

  it('the reminder event type is readable but not user-writable', async () => {
    const ctx = makeTestApp();
    const created = await ctx.agent
      .post('/api/applications')
      .send({ company: 'Acme', position: 'FE' });
    const res = await ctx.agent
      .post(`/api/applications/${created.body.id}/events`)
      .send({ type: 'reminder', message: 'fake' });
    expect(res.status).toBe(400);
  });

  it('migration 5 adds follow_up_at with NULL for pre-existing rows', () => {
    const db = createDb(':memory:');
    const row = db.prepare('SELECT follow_up_at FROM applications LIMIT 1').all();
    expect(row).toHaveLength(0); // fresh DB, but the column must exist
    const cols = db.prepare('PRAGMA table_info(applications)').all() as { name: string }[];
    expect(cols.some((c) => c.name === 'follow_up_at')).toBe(true);
    const idx = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_applications_follow_up'",
      )
      .all();
    expect(idx).toHaveLength(1);
  });
});
