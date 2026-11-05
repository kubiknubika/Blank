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

export const MAX_TRACKED_IPS = 10_000;

export function rateLimit({ windowMs, max, now = Date.now }: RateLimitOptions) {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  let lastSweep = now();

  return (req: Request, res: Response, next: NextFunction): void => {
    if (max <= 0) return next();

    const t = now();
    // Lazy sweep: at most once per window, drop expired buckets.
    if (t - lastSweep >= windowMs) {
      for (const [key, bucket] of buckets) {
        if (bucket.resetAt <= t) buckets.delete(key);
      }
      lastSweep = t;
    }

    const key = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= t) {
      // Hard cap. The expired-only sweep above does NOT bound the map
      // against a spray of FRESH IPs inside one window (IPv6 makes source
      // addresses effectively unlimited): every bucket is still live, so
      // the sweep frees nothing and the map — plus the O(n) scan that used
      // to run on every request once over cap — grows without bound.
      // FIFO-evict the oldest-inserted bucket to make room; memory stays
      // at MAX_TRACKED_IPS entries. An evicted IP gets a fresh budget:
      // the standard bounded-memory tradeoff, far better than OOM.
      if (!buckets.has(key) && buckets.size >= MAX_TRACKED_IPS) {
        const oldest = buckets.keys().next().value;
        if (oldest !== undefined) buckets.delete(oldest);
      }
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
