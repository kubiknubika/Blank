import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/**
 * Configuration is parsed once at startup and fails fast on invalid env.
 * Nothing else in the codebase reads process.env directly.
 */
const configSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default('0.0.0.0'),
  DB_PATH: z
    .string()
    .default(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data/offerflow.db')),
  SEED_ON_EMPTY: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(0).default(10_000),
  // node:sqlite defaults busy_timeout to 0 → instant SQLITE_BUSY under any
  // write contention (nodejs/node#57597). Wait instead of failing.
  DB_BUSY_TIMEOUT_MS: z.coerce.number().int().min(0).max(60_000).default(5_000),
  // Exact origins allowed to make state-changing requests (comma-separated).
  TRUSTED_ORIGINS: z
    .string()
    .default('')
    .transform((s) =>
      s
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean),
    ),
  // Per-IP mutation budget (POST/PUT/PATCH/DELETE). 0 disables the limiter.
  RATE_LIMIT_MAX: z.coerce.number().int().min(0).max(100_000).default(120),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(60_000),
  // Per-IP read budget — generous for humans, still a ceiling on
  // analytics/export CPU and egress abuse. 0 disables. Probes are exempt.
  READ_RATE_LIMIT_MAX: z.coerce.number().int().min(0).max(100_000).default(600),
  // Credential endpoints (login/register/demo) get a tighter budget:
  // an online password-guessing brake on top of scrypt's offline cost.
  CREDENTIAL_RATE_LIMIT_MAX: z.coerce.number().int().min(0).max(10_000).default(20),
  METRICS_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  // Reverse-proxy hops to trust for X-Forwarded-For. 0 = trust nothing
  // (correct when directly exposed); set 1 behind a single ingress/LB.
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
  // Host header allowlist (comma-separated). Empty = skip the check, which is
  // required for dynamic preview hostnames; set in real deployments.
  TRUSTED_HOSTS: z
    .string()
    .default('')
    .transform((s) =>
      s
        .split(',')
        .map((x) => x.trim().toLowerCase())
        .filter(Boolean),
    ),
  // CSP frame-ancestors source list ('none', 'self', explicit origins).
  // Empty = directive omitted so the app stays embeddable (hosted preview
  // iframes it). Set 'none' for standalone deployments.
  CSP_FRAME_ANCESTORS: z.string().default(''),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues.map((e) => `  ${e.path.join('.')}: ${e.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return result.data;
}
