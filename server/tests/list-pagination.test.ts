import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApplicationSchema } from '@offerflow/shared/schemas';
import { createDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { makeTestApp } from './helpers.js';
import type { UserScope } from '../src/service.js';
import { requestContext } from '../src/http/middleware.js';
import { silentLogger } from '../src/logger.js';

/**
 * The list endpoint must never silently truncate: X-Total-Count reports
 * the full filtered size so clients can page through everything, and
 * search treats LIKE metacharacters as literals.
 */
describe('list pagination and search semantics', () => {
  let agent: ReturnType<typeof makeTestApp>['agent'];
  let service: UserScope;

  const seed = (company: string, status?: string) =>
    service.create(createApplicationSchema.parse({ company, position: 'FE', status }));

  beforeEach(() => {
    ({ agent, scope: service } = makeTestApp());
  });

  it('X-Total-Count reports the full size, not the page size', async () => {
    for (let i = 0; i < 7; i++) seed(`Co ${i}`);
    const res = await agent.get('/api/applications?limit=3');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(3);
    expect(res.headers['x-total-count']).toBe('7');
  });

  it('X-Total-Count respects filters', async () => {
    seed('A', 'applied');
    seed('B', 'applied');
    seed('C', 'wishlist');
    const res = await agent.get('/api/applications?status=applied&limit=1');
    expect(res.body).toHaveLength(1);
    expect(res.headers['x-total-count']).toBe('2');
  });

  it('pages tile the full set exactly once', async () => {
    for (let i = 0; i < 5; i++) seed(`Co ${i}`);
    const ids = new Set<string>();
    for (const offset of [0, 2, 4]) {
      const res = await agent.get(`/api/applications?limit=2&offset=${offset}`);
      for (const item of res.body as { id: string }[]) ids.add(item.id);
    }
    expect(ids.size).toBe(5);
  });

  it('treats % and _ in search as literals, not wildcards', async () => {
    seed('100% Remote');
    seed('Acme Corp');
    seed('a_b labs');
    seed('axb labs');

    const percent = await agent.get('/api/applications?q=100%25');
    expect(percent.body).toHaveLength(1);
    expect(percent.body[0].company).toBe('100% Remote');

    const underscore = await agent.get('/api/applications?q=a_b');
    expect(underscore.body).toHaveLength(1);
    expect(underscore.body[0].company).toBe('a_b labs');

    // A bare % must not match everything.
    const bare = await agent.get('/api/applications?q=%25');
    expect(bare.body).toHaveLength(1);
  });

  it('a backslash in search is also literal', async () => {
    seed('path\\to');
    seed('pathXto');
    const res = await agent.get('/api/applications?q=path%5Cto');
    expect(res.body).toHaveLength(1);
    expect(res.body[0].company).toBe('path\\to');
  });
});

describe('request id hardening', () => {
  let app: Express;
  beforeEach(() => {
    app = createApp({ db: createDb(':memory:') });
  });

  it('replaces overlong ids', async () => {
    const res = await request(app).get('/api/health').set('x-request-id', 'a'.repeat(200));
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('replaces ids with spaces', async () => {
    const res = await request(app).get('/api/health').set('x-request-id', 'has space');
    expect(res.headers['x-request-id']).not.toBe('has space');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('still echoes well-formed caller ids', async () => {
    const res = await request(app).get('/api/health').set('x-request-id', 'trace_me.123-abc');
    expect(res.headers['x-request-id']).toBe('trace_me.123-abc');
  });

  // Node's HTTP client refuses to SEND CRLF/unicode header values, so
  // these hostile inputs are exercised at the middleware boundary —
  // exactly where a non-Node proxy might still let them through.
  it('middleware never echoes header-breaking or non-ASCII ids', () => {
    const mw = requestContext(silentLogger);
    for (const hostile of ['evil\r\nx-injected: yes', 'трассировка', 'a\tb', '']) {
      const headers: Record<string, string> = {};
      const req = { headers: { 'x-request-id': hostile } } as unknown as Parameters<typeof mw>[0];
      const res = {
        setHeader: (k: string, v: string) => {
          headers[k] = v;
        },
      } as unknown as Parameters<typeof mw>[1];
      let called = false;
      mw(req, res, () => {
        called = true;
      });
      expect(called).toBe(true);
      expect(headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
      expect(req.requestId).toBe(headers['x-request-id']);
    }
  });
});
