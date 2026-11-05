import type { DatabaseSync } from 'node:sqlite';
import { randomBytes, scryptSync, timingSafeEqual, createHash, randomUUID } from 'node:crypto';
import type { AuthUser } from '@offerflow/shared';
import type { LoginInput, RegisterInput } from '@offerflow/shared/schemas';
import { transaction } from './db.js';
import { ConflictError, UnauthorizedError } from './errors.js';

/**
 * Session-based auth on node:crypto alone — no passport, no JWT library.
 *
 * Passwords: scrypt (N=2^17, r=8, p=1, 64-byte key — the OWASP Password
 * Storage Cheat Sheet baseline) with a per-user random salt, compared in
 * constant time. Format: scrypt$N$r$p$saltHex$hashHex — parameters travel
 * with the hash, so hashes created at older costs keep verifying while
 * new ones use the current parameters.
 *
 * Sessions: the cookie carries 32 random bytes; the database stores only
 * their SHA-256. A stolen database dump therefore does not yield usable
 * session tokens (same reasoning as storing password hashes).
 *
 * The demo account has no password hash: it is reachable ONLY through
 * POST /api/auth/demo, and its data is shared, public and resettable.
 */

const SCRYPT_N = 131072; // 2^17, OWASP baseline; ~350ms per hash here
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;

export const SESSION_COOKIE = 'offerflow_session';
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days, absolute
export const DEMO_USER_ID = 'demo';

interface UserRow {
  id: string;
  email: string;
  password_hash: string | null;
  display_name: string;
  is_demo: number;
}

function toAuthUser(row: UserRow): AuthUser {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    isDemo: row.is_demo === 1,
  };
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 256 * 1024 * 1024,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('hex')}$${key.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltHex, hashHex] = parts;
  const expected = Buffer.from(hashHex, 'hex');
  // Defense in depth: a tampered/corrupt row must fail closed, never
  // succeed. An empty hashHex would derive a 0-byte key and compare
  // equal; absurd parameters would throw instead of returning false.
  if (expected.length !== KEY_LEN || saltHex.length !== 32) return false;
  const cost = Number(n);
  if (!Number.isInteger(cost) || cost < 1024 || cost > 2 ** 20) return false;
  if (Number(r) < 1 || Number(r) > 32 || Number(p) < 1 || Number(p) > 16) return false;
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: 256 * 1024 * 1024,
  });
  return timingSafeEqual(actual, expected);
}

// Burned on unknown-email logins so "user not found" and "wrong password"
// take comparable time — no timing oracle for account enumeration.
const DUMMY_HASH = hashPassword('timing-equalizer-not-a-real-password');

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface SessionResult {
  user: AuthUser;
  token: string;
  expiresAt: string;
}

export class AuthService {
  constructor(
    private db: DatabaseSync,
    private now: () => Date = () => new Date(),
  ) {}

  register(input: RegisterInput): SessionResult {
    return transaction(this.db, () => {
      const existing = this.db.prepare('SELECT id FROM users WHERE email = ?').get(input.email);
      if (existing) throw new ConflictError('An account with this email already exists');
      const id = randomUUID();
      const displayName = input.displayName ?? input.email.split('@')[0];
      this.db
        .prepare(
          'INSERT INTO users (id, email, password_hash, display_name, is_demo, created_at) VALUES (?, ?, ?, ?, 0, ?)',
        )
        .run(id, input.email, hashPassword(input.password), displayName, this.now().toISOString());
      this.sweepExpiredSessions();
      return this.createSession(id);
    });
  }

  login(input: LoginInput): SessionResult {
    const row = this.db
      .prepare('SELECT id, email, password_hash, display_name, is_demo FROM users WHERE email = ?')
      .get(input.email) as UserRow | undefined;
    if (!row || row.password_hash === null) {
      verifyPassword(input.password, DUMMY_HASH); // constant-ish work
      throw new UnauthorizedError('Invalid email or password');
    }
    if (!verifyPassword(input.password, row.password_hash)) {
      throw new UnauthorizedError('Invalid email or password');
    }
    this.sweepExpiredSessions();
    return this.createSession(row.id);
  }

  demoLogin(): SessionResult {
    this.sweepExpiredSessions();
    return this.createSession(DEMO_USER_ID);
  }

  /** Resolves a cookie token to a user, or null (missing/expired/revoked). */
  userForToken(token: string | undefined): AuthUser | null {
    if (!token || token.length > 128) return null;
    const row = this.db
      .prepare(
        `SELECT u.id, u.email, u.password_hash, u.display_name, u.is_demo, s.expires_at
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ?`,
      )
      .get(hashToken(token)) as (UserRow & { expires_at: string }) | undefined;
    if (!row) return null;
    if (new Date(row.expires_at).getTime() <= this.now().getTime()) return null;
    return toAuthUser(row);
  }

  logout(token: string | undefined): void {
    if (!token) return;
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
  }

  private createSession(userId: string): SessionResult {
    const token = randomBytes(32).toString('base64url');
    const now = this.now();
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
    this.db
      .prepare(
        'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
      )
      .run(hashToken(token), userId, now.toISOString(), expiresAt);
    const row = this.db
      .prepare('SELECT id, email, password_hash, display_name, is_demo FROM users WHERE id = ?')
      .get(userId) as unknown as UserRow;
    return { user: toAuthUser(row), token, expiresAt };
  }

  /** Opportunistic cleanup — no timers; auth traffic is frequent enough. */
  private sweepExpiredSessions(): void {
    this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(this.now().toISOString());
  }
}
