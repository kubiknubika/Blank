import { defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Security note: never set `allowedHosts: true`.
 * With host 0.0.0.0 it disables Vite's Host-header check and exposes the dev
 * server (and your source code) to DNS-rebinding attacks — GHSA-vg6x-rcgg-rjx6.
 * localhost, *.localhost and IP addresses are always allowed by Vite itself;
 * tunnel/preview domains must be opted in explicitly via VITE_ALLOWED_HOSTS
 * (comma-separated, e.g. ".e2b.app" for container previews).
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  const allowedHosts = (env.VITE_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);

  return {
    plugins: [react()],
    server: {
      host: '0.0.0.0',
      port: 5173,
      allowedHosts,
      proxy: {
        '/api': {
          target: 'http://localhost:3000',
          changeOrigin: true,
        },
      },
    },
    test: {
      environment: 'node',
      include: ['src/**/*.test.{ts,tsx}'],
    },
  };
});
