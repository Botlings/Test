/**
 * Routes publiques du profil joueur (Jalon 6 — produit public).
 *
 *   GET /achievements/catalog  — catalogue des hauts faits (badges).
 *   GET /players/:id           — profil public d'un compte : identité
 *                                anonymisée, stats globales, badges et
 *                                historique des parties.
 *
 * Ces endpoints sont PUBLICS (aucune authentification) et consommés en
 * cross-origin par la page profil statique : on expose donc un en-tête CORS
 * permissif, comme `GET /leaderboard`. Aucune donnée sensible (email, hash)
 * n'est jamais divulguée — seul un `displayName` dérivé est renvoyé.
 */
import type { FastifyInstance } from 'fastify';
import { ACHIEVEMENT_CATALOG } from '../../domain/achievements.js';
import type { Store } from '../../persistence/store.js';
import type { Id } from '../../persistence/types.js';
import { buildPublicProfile } from '../profile.js';

interface PlayersDeps {
  readonly store: Store;
}

/** Format UUID v4 attendu pour un identifiant de compte. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function registerPlayerRoutes(app: FastifyInstance, deps: PlayersDeps): void {
  const { store } = deps;

  /* ----------------------- GET /achievements/catalog ---------------------- */
  app.get('/achievements/catalog', async (_request, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Cache-Control', 'public, max-age=300');
    return reply.code(200).send({
      achievements: ACHIEVEMENT_CATALOG.map((a) => ({
        id: a.id,
        name: a.name,
        description: a.description,
        hint: a.hint,
        icon: a.icon,
      })),
    });
  });

  /* --------------------------- GET /players/:id --------------------------- */
  app.get('/players/:id', async (request, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
    const params = request.params as { id?: string };
    const id = params.id;
    if (!id || !UUID_RE.test(id)) {
      return reply.code(400).send({
        error: { code: 'player-id-invalid', message: 'Identifiant de joueur invalide' },
      });
    }
    const account = await store.getAccount(id as Id);
    if (!account) {
      return reply.code(404).send({
        error: { code: 'player-not-found', message: 'Joueur introuvable' },
      });
    }
    reply.header('Cache-Control', 'public, max-age=30');
    const profile = await buildPublicProfile(store, account);
    return reply.code(200).send(profile);
  });
}
