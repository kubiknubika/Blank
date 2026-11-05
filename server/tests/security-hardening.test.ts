import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { AuthService, SESSION_COOKIE, DEMO_USER_ID, verifyPassword } from '../src/auth.js';
import { HOST_SESSION_COOKIE } from '../src/http/auth.js';
import { parseImport, toCsv } from '../src/csv.js';
import { createApplicationSchema } from '@offerflow/shared/schemas';
import type { Logger } from '../src/logger.js';
import { makeTestApp } from './helpers.js';

/**
 * Second-pass hardening (ADR-0012): resource-exhaustion ceilings,
 * body-parser error mapping, __Host- cookies, CSP/HSTS, and the
 * fail-closed password verifier. Each test pins one concrete abuse
 * scenario so a regression reopens a named hole, not a vague feeling.
 */

describe('body-parser failures map to 4xx, never 500', () => {
  it('oversized JSON body → 413 PAYLOAD_TOO_LARGE (was 500 + stack log)', async () => {
    const errors: string[] = [];
    const logger: Logger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: (m) => errors.push(m),
      child: () => logger,
    };
    const ctx = makeTestApp({ logger });
    const res = await ctx.agent
      .post('/api/applications')
      .send({ company: 'Acme', position: 'FE', notes: 'x'.repeat(300 * 1024) });
    expect(res.status).toBe(413);
    expect(res.body.code).toBe('PAYLOAD_TOO_LARGE');
    expect(res.body.requestId).toBeTruthy();
    // The whole point: an expected client error must not page anyone.
    expect(errors).toHaveLength(0);
  });

  it('unsupported Content-Encoding → 415, not 500', async () => {
    const ctx = makeTestApp();
    const res = await ctx.agent
      .post('/api/applications')
      .set('Content-Type', 'application/json')
      .set('Content-Encoding', 'definitely-not-an-encoding')
      .send(JSON.stringify({ company: 'Acme', position: 'FE' }));
    expect(res.status).toBe(415);
    expect(res.body.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });
});

describe('verifyPassword never throws on hostile parameters', () => {
  const salt = 'ab'.repeat(16);
  const key = 'cd'.repeat(64);

  it('rejects parameter sets whose memory demand exceeds maxmem', () => {
    // 128 * 2^20 * 32 = 4 GiB > 256 MiB maxmem: scryptSync would throw.
    expect(verifyPassword('x', `scrypt$1048576$32$1$${salt}$${key}`)).toBe(false);
  });

  it('rejects non-power-of-two N (scrypt would throw)', () => {
    expect(verifyPassword('x', `scrypt$16385$8$1$${salt}$${key}`)).toBe(false);
  });

  it('rejects non-integer r/p and non-hex encodings', () => {
    expect(verifyPassword('x', `scrypt$16384$8.5$1$${salt}$${key}`)).toBe(false);
    expect(verifyPassword('x', `scrypt$16384$8$1.5$${salt}$${key}`)).toBe(false);
    expect(verifyPassword('x', `scrypt$16384$8$1$${'zz'.repeat(16)}$${key}`)).toBe(false);
    expect(verifyPassword('x', `scrypt$16384$8$1$${salt}$${'zz'.repeat(64)}`)).toBe(false);
  });
});

describe('session table is bounded per user', () => {
  it('keeps only the newest 50 sessions; older tokens stop resolving', () => {
    const ctx = makeTestApp();
    const tokens: string[] = [];
    // demoLogin does no password hashing — 52 iterations stay fast.
    for (let i = 0; i < 52; i++) tokens.push(ctx.auth.demoLogin().token);
    const row = ctx.db
      .prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?')
      .get(DEMO_USER_ID) as { n: number };
    expect(row.n).toBe(50);
    expect(ctx.auth.userForToken(tokens[0])).toBeNull(); // evicted
    expect(ctx.auth.userForToken(tokens[1])).toBeNull(); // evicted
    expect(ctx.auth.userForToken(tokens[2])?.id).toBe(DEMO_USER_ID); // oldest survivor
    expect(ctx.auth.userForToken(tokens[51])?.id).toBe(DEMO_USER_ID); // newest
  });
});

describe('event history is bounded per application', () => {
  it('prunes oldest beyond the cap on insert; reads stay bounded', async () => {
    const ctx = makeTestApp({ limits: { maxEventsPerApplication: 3 } });
    const created = await ctx.agent
      .post('/api/applications')
      .send({ company: 'Acme', position: 'FE' });
    const id = created.body.id;
    for (let i = 0; i < 5; i++) {
      await ctx.agent
        .post(`/api/applications/${id}/events`)
        .send({ type: 'note', message: `n${i}` });
    }
    const res = await ctx.agent.get(`/api/applications/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(3);
    expect(res.body.events.map((e: { message: string }) => e.message)).toEqual(['n4', 'n3', 'n2']);
    const row = ctx.db
      .prepare('SELECT COUNT(*) AS n FROM events WHERE application_id = ?')
      .get(id) as {
      n: number;
    };
    expect(row.n).toBe(3); // pruned at rest, not just filtered on read
  });
});

describe('per-account application quota', () => {
  it('create beyond the quota → 422 QUOTA_EXCEEDED', async () => {
    const ctx = makeTestApp({ limits: { maxApplicationsPerUser: 3 } });
    for (let i = 0; i < 3; i++) {
      expect(
        (await ctx.agent.post('/api/applications').send({ company: `C${i}`, position: 'FE' }))
          .status,
      ).toBe(201);
    }
    const blocked = await ctx.agent
      .post('/api/applications')
      .send({ company: 'One too many', position: 'FE' });
    expect(blocked.status).toBe(422);
    expect(blocked.body.code).toBe('QUOTA_EXCEEDED');
  });

  it('import is rejected atomically when it would exceed the quota', async () => {
    const ctx = makeTestApp({ limits: { maxApplicationsPerUser: 3 } });
    for (let i = 0; i < 2; i++) {
      await ctx.agent.post('/api/applications').send({ company: `C${i}`, position: 'FE' });
    }
    const res = await ctx.agent
      .post('/api/import/csv')
      .send({ csv: 'company,position\nA,FE\nB,BE\n' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('QUOTA_EXCEEDED');
    // Nothing was written — not even the first row.
    const list = await ctx.agent.get('/api/applications');
    expect(list.body).toHaveLength(2);
  });
});

describe('import error details are capped', () => {
  it('60 bad rows → 50 details + one summary entry', async () => {
    const ctx = makeTestApp();
    const rows = Array.from({ length: 60 }, (_, i) => `C${i},FE,bogus-status`).join('\n');
    const res = await ctx.agent
      .post('/api/import/csv')
      .send({ csv: `company,position,status\n${rows}\n` });
    expect(res.status).toBe(400);
    expect(res.body.details).toHaveLength(51);
    expect(res.body.details[50].path).toBe('csv');
    expect(res.body.details[50].message).toContain('10 more issue(s)');
  });
});

describe('CSV formula guard covers LF-prefixed cells', () => {
  it('escapes a leading newline at the codec layer', () => {
    const ctx = makeTestApp();
    const app = ctx.scope.create(
      createApplicationSchema.parse({ company: 'Acme', position: 'FE' }),
    );
    // The API schema trims strings, so a leading LF cannot arrive via
    // HTTP — but toCsv must defend on its own for any other caller.
    const csv = toCsv([{ ...app, notes: '\n=HYPERLINK("x")' }]);
    expect(csv).toContain('"\'\n=HYPERLINK(""x"")"');
    // Import side: the quote is stripped, the schema trims the LF, and
    // what remains is inert text — never a live formula.
    const [row] = parseImport(csv);
    expect(row.input.notes).toBe('=HYPERLINK("x")');
  });
});

describe('security headers: CSP, Permissions-Policy, conditional HSTS', () => {
  it("sets a script-src 'self' CSP without frame-ancestors by default", async () => {
    const ctx = makeTestApp();
    const res = await ctx.agent.get('/api/applications');
    const csp = res.headers['content-security-policy'];
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toContain('frame-ancestors'); // iframe preview must keep working
    expect(res.headers['permissions-policy']).toContain('camera=()');
    expect(res.headers['strict-transport-security']).toBeUndefined(); // plain HTTP
  });

  it('adds frame-ancestors when configured', async () => {
    const ctx = makeTestApp({ security: { frameAncestors: "'none'" } });
    const res = await ctx.agent.get('/api/applications');
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
  });

  it('sets HSTS only on requests that arrived over TLS', async () => {
    const proxied = createApp({ db: createDb(':memory:'), trustProxyHops: 1 });
    const secure = await request(proxied).get('/api/health').set('X-Forwarded-Proto', 'https');
    expect(secure.headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');
    const plain = await request(proxied).get('/api/health');
    expect(plain.headers['strict-transport-security']).toBeUndefined();
  });
});

describe('__Host- session cookie on HTTPS', () => {
  const proxiedApp = () => createApp({ db: createDb(':memory:'), trustProxyHops: 1 });

  it('issues __Host-…; Secure on HTTPS and ignores tossed plain cookies', async () => {
    const app = proxiedApp();
    const res = await request(app).post('/api/auth/demo').set('X-Forwarded-Proto', 'https');
    const cookie = res.headers['set-cookie'][0];
    expect(cookie.startsWith(`${HOST_SESSION_COOKIE}=`)).toBe(true);
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('Path=/');
    expect(cookie).not.toContain('Domain=');
    const token = cookie.split(';')[0].slice(HOST_SESSION_COOKIE.length + 1);

    // The prefixed cookie authenticates…
    const ok = await request(app)
      .get('/api/auth/me')
      .set('X-Forwarded-Proto', 'https')
      .set('Cookie', `${HOST_SESSION_COOKIE}=${token}`);
    expect(ok.status).toBe(200);

    // …while a plain-name cookie (e.g. tossed from a sibling subdomain)
    // is never read on a secure request, even with a valid token.
    const tossed = await request(app)
      .get('/api/auth/me')
      .set('X-Forwarded-Proto', 'https')
      .set('Cookie', `${SESSION_COOKIE}=${token}`);
    expect(tossed.status).toBe(401);
  });

  it('plain HTTP keeps the plain cookie name (curl, CI E2E)', async () => {
    const app = proxiedApp();
    const res = await request(app).post('/api/auth/demo');
    const cookie = res.headers['set-cookie'][0];
    expect(cookie.startsWith(`${SESSION_COOKIE}=`)).toBe(true);
    expect(cookie).not.toContain('Secure');
    const token = cookie.split(';')[0].slice(SESSION_COOKIE.length + 1);
    const me = await request(app).get('/api/auth/me').set('Cookie', `${SESSION_COOKIE}=${token}`);
    expect(me.status).toBe(200);
  });

  it('logout clears BOTH cookie names; the __Host- clear carries Secure', async () => {
    const app = proxiedApp();
    const res = await request(app).post('/api/auth/logout').set('X-Forwarded-Proto', 'https');
    expect(res.status).toBe(204);
    const cookies: string[] = res.headers['set-cookie'];
    expect(cookies).toHaveLength(2);
    const plain = cookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`));
    const host = cookies.find((c) => c.startsWith(`${HOST_SESSION_COOKIE}=`));
    expect(plain).toContain('Max-Age=0');
    expect(host).toContain('Max-Age=0');
    expect(host).toContain('Secure');
  });

  it('a secure session survives when the AuthService is shared across requests', async () => {
    // Regression guard: readSessionCookie must derive the name from
    // req.secure on EVERY request, not from a value captured at boot.
    const db = createDb(':memory:');
    const app = createApp({ db, trustProxyHops: 1 });
    const auth = new AuthService(db);
    const { token } = auth.demoLogin();
    const me = await request(app)
      .get('/api/auth/me')
      .set('X-Forwarded-Proto', 'https')
      .set('Cookie', `${HOST_SESSION_COOKIE}=${token}`);
    expect(me.status).toBe(200);
    expect(me.body.user.id).toBe(DEMO_USER_ID);
  });
});
