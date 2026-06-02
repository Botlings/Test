/**
 * Point d'entrée du serveur Hordes Revival.
 *
 * Usage : `npm run start` (après build) ou `npx tsx src/server/main.ts`.
 *
 * Variables d'environnement :
 *   - JWT_SECRET   (requis, ≥ 32 caractères)
 *   - PORT         (défaut 3000)
 *   - HOST         (défaut 127.0.0.1)
 *   - NODE_ENV     (`production` → cookies `Secure`)
 *   - DATABASE_URL (optionnel : si défini, le backend Postgres est utilisé
 *                   et le schéma est appliqué ; sinon `MemoryStore`).
 */
import { buildApp } from './app.js';
import { MemoryStore } from '../persistence/memory.js';
import { PgStore } from '../persistence/postgres.js';
import type { Store } from '../persistence/store.js';
import { RealtimeHub } from '../realtime/hub.js';

async function main(): Promise<void> {
  const jwtSecret = process.env['JWT_SECRET'];
  if (!jwtSecret || jwtSecret.length < 32) {
    console.error('JWT_SECRET manquant ou trop court (≥ 32 caractères requis).');
    process.exit(1);
  }
  const port = Number.parseInt(process.env['PORT'] ?? '3000', 10);
  const host = process.env['HOST'] ?? '127.0.0.1';
  const secureCookies = (process.env['NODE_ENV'] ?? '') === 'production';
  const databaseUrl = process.env['DATABASE_URL'];

  let store: Store;
  if (databaseUrl) {
    const pg = new PgStore(databaseUrl);
    await pg.init();
    store = pg;
    console.log('Hordes Revival : backend PostgreSQL initialisé (schéma appliqué).');
  } else {
    store = new MemoryStore();
    console.log('Hordes Revival : DATABASE_URL absent, backend in-memory utilisé.');
  }

  const hub = new RealtimeHub();
  const { app } = await buildApp({ store, hub, jwtSecret, secureCookies, logger: true });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'Arrêt en cours');
    try {
      await app.close();
    } finally {
      await store.close();
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  try {
    await app.listen({ port, host });
    console.log(`Hordes Revival écoute sur http://${host}:${port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void main();
