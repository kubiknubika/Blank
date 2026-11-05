import type { DatabaseSync } from 'node:sqlite';

/**
 * Liveness vs readiness, kept deliberately separate:
 *  - /api/health  — liveness: the process is up and the DB handle works.
 *  - /api/ready   — readiness: may this instance receive traffic?
 *    Flips to 503 the moment graceful shutdown begins (draining), so a
 *    load balancer stops routing BEFORE the socket stops accepting.
 *
 * The state object is shared with the shutdown handler in index.ts.
 */
export interface LifecycleState {
  draining: boolean;
}

export function createLifecycleState(): LifecycleState {
  return { draining: false };
}

export type ReadinessResult =
  { ready: true; status: 'ready' } | { ready: false; status: 'draining' | 'unavailable' };

export function checkReadiness(db: DatabaseSync, lifecycle: LifecycleState): ReadinessResult {
  if (lifecycle.draining) return { ready: false, status: 'draining' };
  try {
    db.prepare('SELECT 1 AS ok').get();
    return { ready: true, status: 'ready' };
  } catch {
    return { ready: false, status: 'unavailable' };
  }
}
