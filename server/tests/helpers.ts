import type { Express } from 'express';
import request from 'supertest';
import { createDb } from '../src/db.js';
import { createApp, type AppDeps } from '../src/app.js';
import { ApplicationService, type UserScope } from '../src/service.js';
import { AuthService, SESSION_COOKIE } from '../src/auth.js';

export interface TestContext {
  app: Express;
  db: ReturnType<typeof createDb>;
  service: ApplicationService;
  auth: AuthService;
  /** Authenticated supertest agent (session cookie pre-set). */
  agent: request.Agent;
  userId: string;
  /** User-scoped service facade for direct (non-HTTP) assertions. */
  scope: UserScope;
}

let userSeq = 0;

/**
 * Fresh in-memory app + a registered user with a session cookie.
 * The user is created through AuthService directly — no HTTP round-trip,
 * so tests don't consume the credential rate-limit budget.
 */
export function makeTestApp(deps: Partial<AppDeps> = {}): TestContext {
  const db = createDb(':memory:');
  const app = createApp({ db, ...deps });
  const auth = new AuthService(db);
  const service = new ApplicationService(db);
  userSeq += 1;
  const { user, token } = auth.register({
    email: `test-${userSeq}@example.com`,
    password: 'correct-horse-battery',
  });
  const agent = request.agent(app);
  agent.jar.setCookie(`${SESSION_COOKIE}=${token}`, '127.0.0.1', '/');
  return { app, db, service, auth, agent, userId: user.id, scope: service.forUser(user.id) };
}

/** A second authenticated agent on the same app — for isolation tests. */
export function addTestUser(ctx: TestContext): {
  agent: request.Agent;
  userId: string;
  scope: UserScope;
} {
  userSeq += 1;
  const { user, token } = ctx.auth.register({
    email: `test-${userSeq}@example.com`,
    password: 'correct-horse-battery',
  });
  const agent = request.agent(ctx.app);
  agent.jar.setCookie(`${SESSION_COOKIE}=${token}`, '127.0.0.1', '/');
  return { agent, userId: user.id, scope: ctx.service.forUser(user.id) };
}

/** An agent authenticated as the shared demo account. */
export function demoAgent(ctx: TestContext): request.Agent {
  const { token } = ctx.auth.demoLogin();
  const agent = request.agent(ctx.app);
  agent.jar.setCookie(`${SESSION_COOKIE}=${token}`, '127.0.0.1', '/');
  return agent;
}
