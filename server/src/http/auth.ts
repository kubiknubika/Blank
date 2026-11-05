import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { loginSchema, registerSchema } from '@offerflow/shared/schemas';
import type { AuthUser } from '@offerflow/shared';
import { AuthService, SESSION_COOKIE, SESSION_TTL_MS } from '../auth.js';
import { UnauthorizedError } from '../errors.js';
import { rateLimit } from './rateLimit.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

/**
 * Cookie-based sessions. The cookie is HttpOnly (no JS access → XSS can't
 * read it), SameSite=Lax (top-level navigations only, blocks cross-site
 * form/fetch submission), and Secure whenever the request arrived over
 * HTTPS (req.secure is trust-proxy aware: behind a TLS-terminating proxy
 * set TRUST_PROXY_HOPS so X-Forwarded-Proto is honored). Deriving the
 * flag from the request instead of NODE_ENV keeps plain-HTTP setups —
 * CI E2E on http://127.0.0.1, local curl — fully functional. The existing
 * securityChecks (Origin + JSON Content-Type) remain as defense in depth.
 *
 * On HTTPS the cookie uses the __Host- prefix, which browsers only accept
 * with Secure + Path=/ + no Domain — that locks it to this exact origin
 * and defeats cookie tossing from sibling subdomains. On plain HTTP the
 * prefix is impossible (it requires Secure), so the plain name is used;
 * an HTTP→HTTPS switch therefore requires one re-login. The secure
 * reader accepts ONLY the prefixed name, so a tossed plain cookie can
 * never shadow a secure session.
 *
 * No cookie-parser dependency: we only ever read our own single cookie.
 */
export const HOST_SESSION_COOKIE = `__Host-${SESSION_COOKIE}`;

export function sessionCookieName(secure: boolean): string {
  return secure ? HOST_SESSION_COOKIE : SESSION_COOKIE;
}

export function readSessionCookie(req: Request): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  const wanted = sessionCookieName(req.secure);
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === wanted) {
      return part.slice(eq + 1).trim() || undefined;
    }
  }
  return undefined;
}

function setSessionCookie(res: Response, token: string, secure: boolean): void {
  const parts = [
    `${sessionCookieName(secure)}=${token}`,
    'Path=/',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res: Response): void {
  // Clear BOTH names: the client may hold a plain cookie from an earlier
  // HTTP session and a __Host- one from HTTPS. The __Host- clear must
  // carry Secure or browsers reject it outright.
  res.setHeader('Set-Cookie', [
    [`${SESSION_COOKIE}=`, 'Path=/', 'Max-Age=0', 'HttpOnly', 'SameSite=Lax'].join('; '),
    [`${HOST_SESSION_COOKIE}=`, 'Path=/', 'Max-Age=0', 'HttpOnly', 'SameSite=Lax', 'Secure'].join(
      '; ',
    ),
  ]);
}

/** Populates req.user when a valid session cookie is present; never rejects. */
export function attachUser(auth: AuthService) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    req.user = auth.userForToken(readSessionCookie(req)) ?? undefined;
    next();
  };
}

/** Rejects unless a session was resolved. Mount AFTER attachUser. */
export function requireUser(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) {
    next(new UnauthorizedError());
    return;
  }
  next();
}

export interface AuthRouterOptions {
  /** Credential endpoints get their own tighter budget (brute-force brake). */
  credentialRateLimit?: { windowMs: number; max: number; now?: () => number };
}

export function createAuthRouter(auth: AuthService, options: AuthRouterOptions = {}): Router {
  const router = Router();
  const credentialLimit = rateLimit(options.credentialRateLimit ?? { windowMs: 60_000, max: 20 });

  router.post('/register', credentialLimit, (req, res) => {
    const input = registerSchema.parse(req.body);
    const result = auth.register(input);
    setSessionCookie(res, result.token, req.secure);
    res.status(201).json({ user: result.user, expiresAt: result.expiresAt });
  });

  router.post('/login', credentialLimit, (req, res) => {
    const input = loginSchema.parse(req.body);
    const result = auth.login(input);
    setSessionCookie(res, result.token, req.secure);
    res.json({ user: result.user, expiresAt: result.expiresAt });
  });

  router.post('/demo', credentialLimit, (req, res) => {
    const result = auth.demoLogin();
    setSessionCookie(res, result.token, req.secure);
    res.json({ user: result.user, expiresAt: result.expiresAt });
  });

  router.post('/logout', (req, res) => {
    auth.logout(readSessionCookie(req));
    clearSessionCookie(res);
    res.status(204).end();
  });

  router.get('/me', (req, res) => {
    if (!req.user) throw new UnauthorizedError();
    res.json({ user: req.user });
  });

  return router;
}
