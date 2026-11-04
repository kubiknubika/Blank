import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { AuthService, SESSION_COOKIE, hashPassword, verifyPassword } from '../src/auth.js';
import { makeTestApp } from './helpers.js';

const creds = { email: 'alice@example.com', password: 'correct-horse-battery' };

describe('auth: password hashing', () => {
  it('produces a parameterized scrypt hash with a random salt', () => {
    const a = hashPassword('same-password');
    const b = hashPassword('same-password');
    expect(a).toMatch(/^scrypt\$16384\$8\$1\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
    expect(a).not.toBe(b); // per-hash salt
    expect(verifyPassword('same-password', a)).toBe(true);
    expect(verifyPassword('wrong-password', a)).toBe(false);
  });

  it('rejects malformed stored hashes instead of throwing', () => {
    expect(verifyPassword('x', 'garbage')).toBe(false);
    expect(verifyPassword('x', 'bcrypt$1$2$3$aa$bb')).toBe(false);
  });
});

describe('auth: register / login / logout over HTTP', () => {
  let app: Express;
  beforeEach(() => {
    app = createApp({ db: createDb(':memory:') });
  });

  it('register returns 201, the user, and an HttpOnly SameSite=Lax session cookie', async () => {
    const res = await request(app).post('/api/auth/register').send(creds);
    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe('alice@example.com');
    expect(res.body.user.isDemo).toBe(false);
    expect(res.body.user.displayName).toBe('alice');
    expect(res.body.user.password).toBeUndefined();
    expect(res.body.user.passwordHash).toBeUndefined();
    const cookie = res.headers['set-cookie'][0];
    expect(cookie).toContain(`${SESSION_COOKIE}=`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Max-Age=604800');
    expect(cookie).not.toContain('Secure'); // dev/test: plain HTTP
  });

  it('sets the Secure cookie flag on HTTPS requests (trust-proxy aware)', async () => {
    const proxied = createApp({ db: createDb(':memory:'), trustProxyHops: 1 });
    const res = await request(proxied)
      .post('/api/auth/register')
      .set('X-Forwarded-Proto', 'https')
      .send(creds);
    expect(res.headers['set-cookie'][0]).toContain('Secure');
    // Plain HTTP (CI E2E, local curl) stays functional: no Secure flag.
    const plain = await request(proxied).post('/api/auth/login').send(creds);
    expect(plain.headers['set-cookie'][0]).not.toContain('Secure');
  });

  it('normalizes email case and whitespace; duplicate email is 409', async () => {
    await request(app).post('/api/auth/register').send(creds);
    const dup = await request(app)
      .post('/api/auth/register')
      .send({ email: '  ALICE@example.com ', password: 'another-password' });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('CONFLICT');
  });

  it('rejects short passwords and invalid emails with field details', async () => {
    const short = await request(app)
      .post('/api/auth/register')
      .send({ email: 'a@b.co', password: 'short' });
    expect(short.status).toBe(400);
    expect(short.body.details.some((d: { path: string[] }) => d.path.includes('password'))).toBe(
      true,
    );
    const badEmail = await request(app)
      .post('/api/auth/register')
      .send({ email: 'not-an-email', password: 'long-enough-password' });
    expect(badEmail.status).toBe(400);
  });

  it('login issues a session; wrong password and unknown email are indistinguishable 401s', async () => {
    await request(app).post('/api/auth/register').send(creds);
    const ok = await request(app).post('/api/auth/login').send(creds);
    expect(ok.status).toBe(200);
    expect(ok.body.user.email).toBe(creds.email);

    const wrong = await request(app)
      .post('/api/auth/login')
      .send({ email: creds.email, password: 'wrong-password-here' });
    const unknown = await request(app)
      .post('/api/auth/login')
      .send({ email: 'ghost@example.com', password: 'wrong-password-here' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error).toBe(unknown.body.error);
    expect(wrong.body.code).toBe('UNAUTHORIZED');
  });

  it('the demo account cannot be logged into with a password', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'demo@offerflow.local', password: 'anything-long-enough' });
    expect(res.status).toBe(401);
  });

  it('GET /api/auth/me reflects the session; logout revokes it', async () => {
    const agent = request.agent(app);
    const reg = await agent.post('/api/auth/register').send(creds);
    expect(reg.status).toBe(201);

    const me = await agent.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(creds.email);

    const out = await agent.post('/api/auth/logout');
    expect(out.status).toBe(204);
    expect(out.headers['set-cookie'][0]).toContain('Max-Age=0');

    // The old token is dead even when replayed manually.
    const token = reg.headers['set-cookie'][0].split(';')[0];
    const replay = await request(app).get('/api/auth/me').set('Cookie', token);
    expect(replay.status).toBe(401);
  });

  it('logout without a session is a no-op 204 (idempotent)', async () => {
    const res = await request(app).post('/api/auth/logout');
    expect(res.status).toBe(204);
  });

  it('POST /api/auth/demo signs into the shared demo account', async () => {
    const res = await request(app).post('/api/auth/demo');
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe('demo');
    expect(res.body.user.isDemo).toBe(true);
    const cookie = res.headers['set-cookie'][0].split(';')[0];
    const apps = await request(app).get('/api/applications').set('Cookie', cookie);
    expect(apps.status).toBe(200);
  });

  it('garbage and expired session tokens are rejected', async () => {
    const bad = await request(app)
      .get('/api/applications')
      .set('Cookie', `${SESSION_COOKIE}=not-a-real-token`);
    expect(bad.status).toBe(401);
    expect(bad.body.code).toBe('UNAUTHORIZED');

    // Expire a real session by rewinding the service clock view.
    const db = createDb(':memory:');
    const future = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000);
    const auth = new AuthService(db, () => new Date());
    const { token } = auth.register(creds);
    const stale = new AuthService(db, () => future);
    expect(stale.userForToken(token)).toBeNull();
  });

  it('credential endpoints have their own tighter rate budget', async () => {
    const guarded = createApp({
      db: createDb(':memory:'),
      credentialRateLimit: { windowMs: 60_000, max: 2 },
    });
    for (let i = 0; i < 2; i++) {
      const res = await request(guarded).post('/api/auth/login').send(creds);
      expect(res.status).toBe(401); // wrong creds, but budget consumed
    }
    const blocked = await request(guarded).post('/api/auth/login').send(creds);
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe('RATE_LIMITED');
    // The general mutation budget is separate: reads still fine.
    expect((await request(guarded).get('/api/health')).status).toBe(200);
  });
});

describe('auth: data endpoints require a session', () => {
  it('every data route answers 401 without a cookie', async () => {
    const { app } = makeTestApp();
    const probes: [string, string][] = [
      ['get', '/api/applications'],
      ['post', '/api/applications'],
      ['get', '/api/applications/some-id'],
      ['patch', '/api/applications/some-id'],
      ['delete', '/api/applications/some-id'],
      ['post', '/api/applications/some-id/events'],
      ['get', '/api/analytics/overview'],
      ['post', '/api/demo/reset'],
    ];
    for (const [method, path] of probes) {
      const res = await (request(app) as unknown as Record<string, (p: string) => request.Test>)[
        method
      ](path);
      expect(res.status, `${method} ${path}`).toBe(401);
      expect(res.body.code).toBe('UNAUTHORIZED');
    }
  });

  it('health, ready and openapi stay public', async () => {
    const { app } = makeTestApp();
    for (const path of ['/api/health', '/api/ready', '/api/openapi.json']) {
      expect((await request(app).get(path)).status, path).toBe(200);
    }
  });
});

describe('auth: session storage', () => {
  it('stores only a SHA-256 of the token, never the token itself', () => {
    const db = createDb(':memory:');
    const auth = new AuthService(db);
    const { token } = auth.register(creds);
    const rows = db.prepare('SELECT token_hash FROM sessions').all() as { token_hash: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].token_hash).not.toBe(token);
  });

  it('issuing a new session sweeps expired ones', () => {
    const db = createDb(':memory:');
    let clock = new Date('2026-01-01T00:00:00.000Z');
    const auth = new AuthService(db, () => clock);
    auth.register(creds);
    expect((db.prepare('SELECT COUNT(*) n FROM sessions').get() as { n: number }).n).toBe(1);
    clock = new Date('2026-02-01T00:00:00.000Z'); // 31 days later
    auth.demoLogin();
    expect((db.prepare('SELECT COUNT(*) n FROM sessions').get() as { n: number }).n).toBe(1); // old session swept, only demo remains
  });

  it('migration 4 backfills pre-existing rows to the demo account', () => {
    const db = createDb(':memory:');
    const ownerless = db
      .prepare('SELECT COUNT(*) n FROM applications WHERE user_id IS NULL')
      .get() as { n: number };
    expect(ownerless.n).toBe(0);
    const demo = db.prepare('SELECT is_demo FROM users WHERE id = ?').get('demo') as {
      is_demo: number;
    };
    expect(demo.is_demo).toBe(1);
  });
});
