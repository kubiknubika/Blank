import type { NextFunction, Request, Response } from 'express';
import { ForbiddenError, UnsupportedMediaTypeError } from '../errors.js';

/**
 * Defenses learned from real-world incidents in similar local-first apps:
 *
 * 1. Host allowlist — a DNS-rebound page is same-origin to the browser, so
 *    an Origin check alone does NOT stop rebinding reads; the Host header
 *    must be validated too (burakdede/lorepack#635).
 * 2. Content-Type enforcement — a "simple" cross-origin POST with
 *    text/plain or form encoding reaches localhost without a CORS
 *    preflight and can execute mutations (misaka310/local-finance-dashboard#12).
 * 3. Origin check — browser mutations must be same-origin or explicitly
 *    trusted. Non-browser clients (curl, tests) send no Origin and pass.
 */
export interface SecurityOptions {
  /** Exact origins (scheme://host:port) allowed to mutate. */
  trustedOrigins: string[];
  /** Hostnames allowed in the Host header; empty = check disabled. */
  trustedHosts: string[];
  /** In development, loopback origins on any port are allowed (Vite proxy). */
  isDevelopment: boolean;
}

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function securityChecks(options: SecurityOptions) {
  const trustedOrigins = new Set(options.trustedOrigins);
  const trustedHosts = new Set(options.trustedHosts.map((h) => h.toLowerCase()));

  return (req: Request, _res: Response, next: NextFunction): void => {
    const hostHeader = (req.headers.host ?? '').toLowerCase();
    const hostname = hostHeader.replace(/:\d+$/, '');

    // (1) DNS-rebinding defense: reject foreign Host headers when configured.
    if (trustedHosts.size > 0 && !trustedHosts.has(hostname)) {
      next(new ForbiddenError('Host is not allowed'));
      return;
    }

    if (MUTATING_METHODS.has(req.method)) {
      // (2) Mutations with a body must be JSON. This forces a CORS preflight
      //     for cross-origin browser requests, which we never grant.
      const hasBody =
        Number(req.headers['content-length'] ?? 0) > 0 ||
        req.headers['transfer-encoding'] !== undefined;
      if (hasBody && !req.is('application/json')) {
        next(new UnsupportedMediaTypeError('Mutating requests must use application/json'));
        return;
      }

      // (3) Origin check for browser clients.
      const origin = req.headers.origin;
      if (origin !== undefined) {
        let originHost: string;
        let originHostname: string;
        try {
          const url = new URL(origin);
          originHost = url.host.toLowerCase();
          originHostname = url.hostname.toLowerCase();
        } catch {
          next(new ForbiddenError('Invalid Origin header'));
          return;
        }
        const sameOrigin = originHost === hostHeader;
        const explicitlyTrusted = trustedOrigins.has(origin);
        const devLoopback = options.isDevelopment && LOOPBACK_HOSTNAMES.has(originHostname);
        if (!sameOrigin && !explicitlyTrusted && !devLoopback) {
          next(new ForbiddenError('Origin is not allowed'));
          return;
        }
      }
    }

    next();
  };
}

/** Cheap, universally safe response headers. */
export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
}
