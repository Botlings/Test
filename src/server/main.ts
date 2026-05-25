/**
 * Point d'entrée du serveur Hordes Revival.
 *
 * Usage : `npm run start` (après build) ou `npx tsx src/server/main.ts`.
 * Variables requises : `JWT_SECRET` (≥ 32 chars). Optionnel : `PORT`,
 * `HOST`, `NODE_ENV`. Pour le MVP, le store est en mémoire — pas besoin
 * de Postgres ni Redis.
 */
import { buildApp } from './app.js';
import { MemoryStore } from '../persistence/memory.js';
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

  const store = new MemoryStore();
  const hub = new RealtimeHub();
  const { app } = await buildApp({ store, hub, jwtSecret, secureCookies, logger: true });

  try {
    await app.listen({ port, host });
    console.log(`Hordes Revival écoute sur http://${host}:${port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void main();
