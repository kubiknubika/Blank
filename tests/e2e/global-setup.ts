import { rmSync } from 'node:fs';

/**
 * Every E2E run starts from an empty database so SEED_ON_EMPTY produces
 * the canonical demo dataset. WAL sidecars must go too, or SQLite would
 * happily replay them onto a "fresh" file.
 */
export default function globalSetup(): void {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    rmSync(`server/data/e2e.db${suffix}`, { force: true });
  }
}
