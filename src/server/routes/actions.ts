/**
 * Routes des actions de jeu (Jour 1 et au-delà) :
 *   POST /towns/:townId/citizens/:citizenId/action
 *   POST /towns/:townId/night
 *
 * Le corps d'une action discrimine sur `type` :
 *   { type: 'move',     to: 'town' | 'desert' }
 *   { type: 'scavenge' }
 *   { type: 'build'    }
 *
 * Toute mutation publie un événement sur le hub temps réel ; la résolution
 * de nuit est protégée par `store.nightLock` (sémantique NX-EX).
 */
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth-guard.js';
import { GameRuleError } from '../../domain/game.js';
import type { Location } from '../../domain/types.js';
import { StoreError, type Store, type TownRecord } from '../../persistence/store.js';
import type { Id } from '../../persistence/types.js';
import type { RealtimeHub } from '../../realtime/hub.js';

interface ActionsDeps {
  readonly store: Store;
  readonly jwtSecret: string;
  readonly hub: RealtimeHub;
}

const LOCATIONS: ReadonlySet<Location> = new Set(['town', 'desert']);

function publishTownSnapshot(hub: RealtimeHub, town: TownRecord): void {
  const status = town.game.status();
  hub.publish(town.id, {
    type: 'town.snapshot',
    day: status.day,
    phase: status.phase,
    resources: { ...status.bank },
    citizens: status.citizens.map((c) => ({
      id: c.id,
      name: c.name,
      location: c.location,
      alive: c.alive,
    })),
  });
}

export function registerActionRoutes(app: FastifyInstance, deps: ActionsDeps): void {
  const { store, jwtSecret, hub } = deps;

  /* ----------- POST /towns/:townId/citizens/:citizenId/action -------------- */
  app.post('/towns/:townId/citizens/:citizenId/action', async (request, reply) => {
    const accountId = requireAuth(request, reply, { jwtSecret });
    if (!accountId) return;
    const params = request.params as { townId?: string; citizenId?: string };
    const townId = params.townId as Id | undefined;
    const citizenId = params.citizenId;
    if (!townId || !citizenId) {
      return reply.code(400).send({
        error: { code: 'params-missing', message: 'townId et citizenId requis' },
      });
    }
    const town = await store.getTown(townId);
    if (!town) {
      return reply.code(404).send({
        error: { code: 'town-not-found', message: 'Ville introuvable' },
      });
    }
    if (town.closed) {
      return reply.code(409).send({
        error: { code: 'town-closed', message: 'Cette ville est terminée' },
      });
    }
    const ownerCitizenId = town.membership.get(accountId);
    if (!ownerCitizenId || ownerCitizenId !== citizenId) {
      return reply.code(403).send({
        error: { code: 'not-your-citizen', message: 'Vous ne pouvez agir que pour votre citoyen' },
      });
    }

    const body = request.body as { type?: unknown; to?: unknown } | undefined;
    const actionType = typeof body?.type === 'string' ? body.type : '';
    try {
      switch (actionType) {
        case 'move': {
          const to = body?.to;
          if (typeof to !== 'string' || !LOCATIONS.has(to as Location)) {
            return reply.code(400).send({
              error: { code: 'location-invalid', message: 'Destination invalide (town | desert)' },
            });
          }
          town.game.setLocation(citizenId, to as Location);
          await store.saveTown(town);
          hub.publish(townId, { type: 'citizen.moved', citizenId, to: to as Location });
          break;
        }
        case 'scavenge': {
          town.game.scavenge(citizenId);
          await store.saveTown(town);
          publishTownSnapshot(hub, town);
          break;
        }
        case 'build': {
          town.game.build(citizenId);
          await store.saveTown(town);
          publishTownSnapshot(hub, town);
          hub.publish(townId, {
            type: 'build.completed',
            structureId: `${townId}-build-${Date.now()}`,
            defense: town.game.status().townDefense,
          });
          break;
        }
        default:
          return reply.code(400).send({
            error: {
              code: 'action-unknown',
              message: 'Type d\'action inconnu (move, scavenge, build)',
            },
          });
      }
    } catch (err) {
      if (err instanceof GameRuleError) {
        return reply.code(409).send({
          error: { code: 'rule-violation', message: err.message },
        });
      }
      throw err;
    }

    const status = town.game.status();
    return reply.code(200).send({
      ok: true,
      citizen: status.citizens.find((c) => c.id === citizenId),
      bank: status.bank,
      townDefense: status.townDefense,
      day: status.day,
      phase: status.phase,
    });
  });

  /* ------------------------- POST /towns/:townId/night --------------------- */
  app.post('/towns/:townId/night', async (request, reply) => {
    const accountId = requireAuth(request, reply, { jwtSecret });
    if (!accountId) return;
    const params = request.params as { townId?: string };
    const townId = params.townId as Id | undefined;
    if (!townId) {
      return reply.code(400).send({
        error: { code: 'town-id-missing', message: 'Identifiant de ville manquant' },
      });
    }
    const town = await store.getTown(townId);
    if (!town) {
      return reply.code(404).send({
        error: { code: 'town-not-found', message: 'Ville introuvable' },
      });
    }
    if (!town.membership.has(accountId)) {
      return reply.code(403).send({
        error: { code: 'not-a-citizen', message: 'Vous devez être citoyen de cette ville' },
      });
    }
    try {
      const report = await store.nightLock(townId, async () => {
        const current = await store.getTown(townId);
        if (!current) {
          throw new StoreError('town-not-found', 'Ville introuvable');
        }
        if (current.closed) {
          throw new StoreError('town-closed', 'Cette ville est terminée');
        }
        if (current.game.status().phase !== 'day') {
          throw new StoreError('night-already-running', 'La nuit est déjà en cours');
        }
        hub.publish(townId, { type: 'night.start', day: current.game.day });
        const out = current.game.endDay();
        if (out.gameOver) {
          current.closed = true;
        }
        await store.saveTown(current);
        await store.recordNightEvent(townId, {
          day: out.day,
          attackers: out.hordePower,
          defense: out.townDefense,
          breached: out.breached,
          deaths: out.deaths.length,
        });
        hub.publish(townId, { type: 'night.report', day: out.day, report: out });
        publishTownSnapshot(hub, current);
        return out;
      });
      return reply.code(200).send({ report });
    } catch (err) {
      if (err instanceof StoreError) {
        const code = err.code === 'town-not-found' ? 404 : 409;
        return reply.code(code).send({ error: { code: err.code, message: err.message } });
      }
      if (err instanceof GameRuleError) {
        return reply.code(409).send({
          error: { code: 'rule-violation', message: err.message },
        });
      }
      throw err;
    }
  });
}
