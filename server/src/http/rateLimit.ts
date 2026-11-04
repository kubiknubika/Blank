import type { NextFunction, Request, Response } from 'express';
import { RateLimitedError } from '../errors.js';

/**
 * Fixed-window per-IP rate limiter, in memory (single-process app; a
 * Redis-backed limiter would be the multi-instance upgrade path).
 *
 * The window clock is injected so tests are deterministic. Buckets are
 * swept lazily and the map is capped so a spray of spoofed IPs cannot
 * grow memory without bound.
 */
export interface RateLimitOptions {
  windowMs: number;
  /** Requests per window per IP. 0 disables the limiter entirely. */
  max: number;
  now?: () => number;
}

const MAX_TRACKED_IPS = 10_000;

export function rateLimit({ windowMs, max, now = Date.now }: RateLimitOptions) {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  let lastSweep = now();

  return (req: Request, res: Response, next: NextFunction): void => {
    if (max <= 0) return next();

    const t = now();
    // Lazy sweep: at most once per window, drop expired buckets.
    if (t - lastSweep >= windowMs || buckets.size > MAX_TRACKED_IPS) {
      for (const [key, bucket] of buckets) {
        if (bucket.resetAt <= t) buckets.delete(key);
      }
      lastSweep = t;
    }

    const key = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= t) {
      bucket = { count: 0, resetAt: t + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;

    const remaining = Math.max(0, max - bucket.count);
    const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - t) / 1000));
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    res.setHeader('X-RateLimit-Reset', String(retryAfter));

    if (bucket.count > max) {
      res.setHeader('Retry-After', String(retryAfter));
      next(new RateLimitedError(retryAfter));
      return;
    }
    next();
  };
}
