import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createDb } from '../src/db.js';
import { createApp, type AppDeps } from '../src/app.js';
import { makeTestApp, demoAgent } from './helpers.js';

/**
 * Regression tests for the request-forgery / DNS-rebinding defenses.
 * Scenarios mirror published incidents in similar local-first apps
 * (docs/adr/0005-hardening-from-field-reports.md).
 */
function makeApp(security?: AppDeps['security']): Express {
  return createApp({ db: createDb(':memory:'), security });
}

// Authenticated app: security rejections must be tested with a VALID
// session, otherwise a 401 could mask a broken Origin/Content-Type check.
function makeAuthedApp(security?: AppDeps['security']) {
  return makeTestApp({ security });
}

const payload = { company: 'Acme', position: 'Engineer' };

describe('security: Origin checks on mutations', () => {
  let agent: ReturnType<typeof makeTestApp>['agent'];
  beforeEach(() => {
    ({ agent } = makeAuthedApp({ isDevelopment: false }));
  });

  it('rejects a cross-site POST (CSRF via form/fetch from another origin)', async () => {
    const res = await agent
      .post('/api/applications')
      .set('Origin', 'https://evil.example')
      .send(payload);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  it('rejects a cross-site bodyless POST /api/demo/reset (the real CSRF hole)', async () => {
    const res = await agent.post('/api/demo/reset').set('Origin', 'https://evil.example');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  it('allows a same-origin POST (Origin host matches Host, port included)', async () => {
    const res = await agent
      .post('/api/applications')
      .set('Host', 'app.example.com')
      .set('Origin', 'https://app.example.com')
      .send(payload);
    expect(res.status).toBe(201);
  });

  it('rejects an Origin that differs only by port', async () => {
    const res = await agent
      .post('/api/applications')
      .set('Host', 'app.example.com')
      .set('Origin', 'https://app.example.com:8443')
      .send(payload);
    expect(res.status).toBe(403);
  });

  it('allows explicitly trusted origins (e.g. a separate dev frontend)', async () => {
    const trusted = makeAuthedApp({
      isDevelopment: false,
      trustedOrigins: ['http://localhost:5173'],
    });
    const res = await trusted.agent
      .post('/api/applications')
      .set('Host', 'localhost:3000')
      .set('Origin', 'http://localhost:5173')
      .send(payload);
    expect(res.status).toBe(201);
  });

  it('allows loopback origins in development (Vite proxy rewrites Host)', async () => {
    const dev = makeAuthedApp({ isDevelopment: true });
    const res = await dev.agent
      .post('/api/applications')
      .set('Host', 'localhost:3000')
      .set('Origin', 'http://localhost:5173')
      .send(payload);
    expect(res.status).toBe(201);
  });

  it('rejects a malformed Origin header', async () => {
    const res = await agent.post('/api/applications').set('Origin', 'not a url').send(payload);
    expect(res.status).toBe(403);
  });

  it('allows non-browser clients without an Origin header (curl, tests)', async () => {
    const res = await agent.post('/api/applications').send(payload);
    expect(res.status).toBe(201);
  });

  it('does not block reads: GET with a foreign Origin still works', async () => {
    const res = await agent.get('/api/health').set('Origin', 'https://evil.example');
    expect(res.status).toBe(200);
  });

  it('checks DELETE too, not just body-carrying methods', async () => {
    const res = await agent
      .delete('/api/applications/whatever')
      .set('Origin', 'https://evil.example');
    expect(res.status).toBe(403);
  });
});

describe('security: Content-Type enforcement', () => {
  let agent: ReturnType<typeof makeTestApp>['agent'];
  beforeEach(() => {
    ({ agent } = makeAuthedApp({ isDevelopment: false }));
  });

  it('rejects a text/plain POST body with 415 (simple-request CSRF vector)', async () => {
    const res = await agent
      .post('/api/applications')
      .set('Content-Type', 'text/plain')
      .send(JSON.stringify(payload));
    expect(res.status).toBe(415);
    expect(res.body.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('rejects a form-encoded POST body with 415', async () => {
    const res = await agent
      .post('/api/applications')
      .type('form')
      .send({ company: 'Acme', position: 'Engineer' });
    expect(res.status).toBe(415);
  });

  it('accepts application/json with charset suffix', async () => {
    const res = await agent
      .post('/api/applications')
      .set('Content-Type', 'application/json; charset=utf-8')
      .send(JSON.stringify(payload));
    expect(res.status).toBe(201);
  });

  it('does not demand a Content-Type on bodyless POST /api/demo/reset', async () => {
    const ctx = makeAuthedApp({ isDevelopment: false });
    const res = await demoAgent(ctx).post('/api/demo/reset');
    expect(res.status).toBe(200);
  });
});

describe('security: Host allowlist (DNS rebinding)', () => {
  it('rejects requests whose Host is not allowlisted, including reads', async () => {
    const app = makeApp({ isDevelopment: false, trustedHosts: ['offerflow.example.com'] });
    const res = await request(app).get('/api/health').set('Host', 'rebound.attacker.com');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  it('accepts an allowlisted Host regardless of port', async () => {
    const app = makeApp({ isDevelopment: false, trustedHosts: ['offerflow.example.com'] });
    const res = await request(app).get('/api/health').set('Host', 'offerflow.example.com:3000');
    expect(res.status).toBe(200);
  });

  it('skips the Host check when no allowlist is configured (dynamic previews)', async () => {
    const app = makeApp({ isDevelopment: false });
    const res = await request(app).get('/api/health').set('Host', 'anything.e2b.app');
    expect(res.status).toBe(200);
  });
});

describe('security headers', () => {
  it('sets nosniff and no-referrer on every response', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });
});
