/**
 * Routes des villes : lister les parties ouvertes, en créer, en rejoindre.
 *
 * Le tableau de bord d'une ville (état complet) est servi par
 * `GET /towns/:id`. Les actions de jeu se trouvent dans `actions.ts`.
 */
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth-guard.js';
import {
  MAX_CITIZENS_PER_TOWN,
  StoreError,
  type Difficulty,
  type Store,
  type TownRecord,
} from '../../persistence/store.js';
import type { Id } from '../../persistence/types.js';
import type { RealtimeHub } from '../../realtime/hub.js';
import type { NightScheduler } from '../night-scheduler.js';

interface TownsDeps {
  readonly store: Store;
  readonly jwtSecret: string;
  readonly hub: RealtimeHub;
  readonly scheduler?: NightScheduler;
}

const DIFFICULTIES: ReadonlySet<Difficulty> = new Set(['normal', 'hard', 'hardcore']);

function summarizeTown(town: TownRecord) {
  const status = town.game.status();
  return {
    id: town.id,
    name: town.name,
    difficulty: town.difficulty,
    day: status.day,
    phase: status.phase,
    citizens: town.membership.size,
    capacity: MAX_CITIZENS_PER_TOWN,
    aliveCitizens: status.aliveCount,
    townDefense: status.townDefense,
    gameOver: status.gameOver,
    closed: town.closed,
  };
}

function fullTownState(
  town: TownRecord,
  accountId: Id,
  scheduler?: NightScheduler,
) {
  const status = town.game.status();
  const yourCitizenId = town.membership.get(accountId);
  const scheduledAt = scheduler?.getScheduledFor(town.id) ?? null;
  return {
    id: town.id,
    name: town.name,
    difficulty: town.difficulty,
    day: status.day,
    phase: status.phase,
    townDefense: status.townDefense,
    hordePowerTonight: status.hordePowerTonight,
    bank: status.bank,
    citizens: status.citizens.map((c) => ({
      id: c.id,
      name: c.name,
      alive: c.alive,
      location: c.location,
      actionPoints: c.actionPoints,
      consecutiveThirstDays: c.consecutiveThirstDays,
      causeOfDeath: c.causeOfDeath ?? null,
    })),
    yourCitizenId: yourCitizenId ?? null,
    closed: town.closed,
    gameOver: status.gameOver,
    nextNightAt: scheduledAt ? new Date(scheduledAt).toISOString() : null,
  };
}

export function registerTownRoutes(app: FastifyInstance, deps: TownsDeps): void {
  const { store, jwtSecret, hub, scheduler } = deps;

  /* ------------------------------ GET /towns ------------------------------ */
  app.get('/towns', async (request, reply) => {
    if (!requireAuth(request, reply, { jwtSecret })) return;
    const towns = await store.listOpenTowns();
    return reply.code(200).send({ towns: towns.map(summarizeTown) });
  });

  /* ------------------------------ POST /towns ----------------------------- */
  app.post('/towns', async (request, reply) => {
    const accountId = requireAuth(request, reply, { jwtSecret });
    if (!accountId) return;
    const body = request.body as { name?: unknown; difficulty?: unknown } | undefined;
    const name = typeof body?.name === 'string' ? body.name : '';
    const difficulty = body?.difficulty;
    if (typeof difficulty !== 'string' || !DIFFICULTIES.has(difficulty as Difficulty)) {
      return reply.code(400).send({
        error: { code: 'difficulty-invalid', message: 'Difficulté invalide (normal, hard, hardcore)' },
      });
    }
    try {
      const town = await store.createTown(name, difficulty as Difficulty);
      const account = (await store.getAccount(accountId))!;
      const citizenName = account.email.split('@')[0]!;
      await store.joinTown(town.id, accountId, citizenName);
      await store.saveTown(town);
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
      scheduler?.scheduleTown(town.id, { day: town.game.day });
      return reply.code(201).send(fullTownState(town, accountId, scheduler));
    } catch (err) {
      if (err instanceof StoreError) {
        const code = err.code === 'town-name-invalid' ? 400 : 409;
        return reply.code(code).send({ error: { code: err.code, message: err.message } });
      }
      throw err;
    }
  });

  /* --------------------------- POST /towns/:id/join ----------------------- */
  app.post('/towns/:townId/join', async (request, reply) => {
    const accountId = requireAuth(request, reply, { jwtSecret });
    if (!accountId) return;
    const params = request.params as { townId?: string };
    const townId = params.townId as Id | undefined;
    if (!townId) {
      return reply.code(400).send({
        error: { code: 'town-id-missing', message: 'Identifiant de ville manquant' },
      });
    }
    try {
      const account = await store.getAccount(accountId);
      if (!account) {
        return reply.code(401).send({
          error: { code: 'account-not-found', message: 'Compte introuvable' },
        });
      }
      const citizenName = account.email.split('@')[0]!;
      await store.joinTown(townId, accountId, citizenName);
      const town = (await store.getTown(townId))!;
      await store.saveTown(town);
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
      return reply.code(200).send(fullTownState(town, accountId, scheduler));
    } catch (err) {
      if (err instanceof StoreError) {
        const code =
          err.code === 'town-not-found' ? 404
            : err.code === 'town-closed' || err.code === 'town-full' ? 409
              : err.code === 'already-joined' ? 409
                : 400;
        return reply.code(code).send({ error: { code: err.code, message: err.message } });
      }
      throw err;
    }
  });

  /* ------------------------------ GET /towns/:id -------------------------- */
  app.get('/towns/:townId', async (request, reply) => {
    const accountId = requireAuth(request, reply, { jwtSecret });
    if (!accountId) return;
    const params = request.params as { townId?: string };
    const town = params.townId ? await store.getTown(params.townId as Id) : undefined;
    if (!town) {
      return reply.code(404).send({
        error: { code: 'town-not-found', message: 'Ville introuvable' },
      });
    }
    return reply.code(200).send(fullTownState(town, accountId, scheduler));
  });

  /* -------------------- GET /towns/:id/night-reports --------------------- */
  app.get('/towns/:townId/night-reports', async (request, reply) => {
    const accountId = requireAuth(request, reply, { jwtSecret });
    if (!accountId) return;
    const params = request.params as { townId?: string };
    const query = request.query as { limit?: string } | undefined;
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
    let limit = 20;
    if (typeof query?.limit === 'string') {
      const parsed = Number.parseInt(query.limit, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        limit = Math.min(100, parsed);
      }
    }
    const reports = await store.listNightReports(townId, limit);
    return reply.code(200).send({
      townId,
      count: reports.length,
      reports: reports.map((r) => ({
        trigger: r.trigger,
        storedAt: r.storedAt.toISOString(),
        report: r.report,
      })),
    });
  });
}
