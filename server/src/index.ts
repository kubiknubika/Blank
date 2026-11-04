import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb } from './db.js';
import { createApp } from './app.js';
import { ApplicationRepository } from './repository.js';
import { seedDatabase } from './seed.js';

const PORT = Number(process.env.PORT ?? 3000);
const DB_PATH =
  process.env.DB_PATH ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data/offerflow.db');

const db = createDb(DB_PATH);
const repo = new ApplicationRepository(db);

if (repo.count() === 0 && process.env.SEED_ON_EMPTY !== 'false') {
  seedDatabase(repo);
  console.log(`Seeded demo data: ${repo.count()} applications`);
}

const app = createApp(db);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`OfferFlow API listening on http://0.0.0.0:${PORT}`);
  console.log(`SQLite database: ${DB_PATH}`);
});
