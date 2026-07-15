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
  canSpendBank,
  roleFor,
  type BankPolicy,
  type Difficulty,
  type Store,
  type TownRecord,
} from '../../persistence/store.js';
import type { Id } from '../../persistence/types.js';
import type { RealtimeHub } from '../../realtime/hub.js';
import type { PresenceRegistry } from '../../realtime/presence.js';
import type { NightScheduler } from '../night-scheduler.js';
import { publishActivity } from '../activity.js';
import { buildEndgameCard } from '../../domain/endgame-card.js';

interface TownsDeps {
  readonly store: Store;
  readonly jwtSecret: string;
  readonly hub: RealtimeHub;
  readonly scheduler?: NightScheduler;
  readonly presence: PresenceRegistry;
}

const DIFFICULTIES: ReadonlySet<Difficulty> = new Set(['normal', 'hard', 'hardcore']);

function summarizeTown(town: TownRecord, presence: PresenceRegistry) {
  const status = town.game.status();
  return {
    id: town.id,
    name: town.name,
    difficulty: town.difficulty,
    day: status.day,
    phase: status.phase,
    citizens: town.membership.size,
    capacity: MAX_CITIZENS_PER_TOWN,
    full: town.membership.size >= MAX_CITIZENS_PER_TOWN,
    aliveCitizens: status.aliveCount,
    online: presence.onlineCount(town.id),
    queued: town.queue.length,
    townDefense: status.townDefense,
    gameOver: status.gameOver,
    outcome: status.outcome,
    survivalDays: status.survivalDays,
    closed: town.closed,
  };
}

/** Liste des gestionnaires de banque sous forme exploitable côté UI. */
function bankManagersView(town: TownRecord) {
  const out: Array<{ accountId: Id; citizenId: string | null; citizenName: string | null }> = [];
  const citizens = town.game.status().citizens;
  for (const accountId of town.bankManagers) {
    const citizenId = town.membership.get(accountId) ?? null;
    const citizenName = citizenId
      ? citizens.find((c) => c.id === citizenId)?.name ?? null
      : null;
    out.push({ accountId, citizenId, citizenName });
  }
  return out;
}

function fullTownState(
  town: TownRecord,
  accountId: Id,
  presence: PresenceRegistry,
  scheduler?: NightScheduler,
) {
  const status = town.game.status();
  const yourCitizenId = town.membership.get(accountId);
  const scheduledAt = scheduler?.getScheduledFor(town.id) ?? null;
  const onlineAccounts = new Set(presence.online(town.id));
  const queueIndex = town.queue.indexOf(accountId);
  return {
    id: town.id,
    name: town.name,
    difficulty: town.difficulty,
    day: status.day,
    phase: status.phase,
    townDefense: status.townDefense,
    hordePowerTonight: status.hordePowerTonight,
    bank: status.bank,
    bankPolicy: town.bankPolicy,
    canSpendBank: canSpendBank(town, accountId),
    citizens: status.citizens.map((c) => {
      // Retrouve le compte propriétaire pour exposer présence + droits.
      let ownerAccountId: Id | null = null;
      for (const [acc, cid] of town.membership.entries()) {
        if (cid === c.id) {
          ownerAccountId = acc;
          break;
        }
      }
      return {
        id: c.id,
        name: c.name,
        alive: c.alive,
        location: c.location,
        actionPoints: c.actionPoints,
        consecutiveThirstDays: c.consecutiveThirstDays,
        position: c.position ?? null,
        waterCanteen: c.waterCanteen,
        causeOfDeath: c.causeOfDeath ?? null,
        online: ownerAccountId ? onlineAccounts.has(ownerAccountId) : false,
        role: ownerAccountId ? roleFor(town, ownerAccountId) : 'citizen',
      };
    }),
    yourCitizenId: yourCitizenId ?? null,
    yourRole: roleFor(town, accountId),
    bankManagers: bankManagersView(town),
    capacity: MAX_CITIZENS_PER_TOWN,
    full: town.membership.size >= MAX_CITIZENS_PER_TOWN,
    onlineCount: presence.onlineCount(town.id),
    queueSize: town.queue.length,
    yourQueuePosition: queueIndex === -1 ? null : queueIndex + 1,
    closed: town.closed,
    gameOver: status.gameOver,
    outcome: status.outcome,
    survivalDays: status.survivalDays,
    nextNightAt: scheduledAt ? new Date(scheduledAt).toISOString() : null,
    buildings: status.buildings,
    items: status.items,
    threatsTonight: status.threatsTonight,
    desert: status.desert,
  };
}

export function registerTownRoutes(app: FastifyInstance, deps: TownsDeps): void {
  const { store, jwtSecret, hub, scheduler, presence } = deps;

  /** Diffuse un instantané de ville à tous les abonnés temps réel. */
  function publishSnapshot(town: TownRecord): void {
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

  /* --------------------------- GET /leaderboard --------------------------- */
  // Classement global des parties terminées. Public (pas d'auth) : la landing
  // statique (GitHub Pages) le consomme en cross-origin, d'où l'en-tête CORS
  // permissif (lecture seule, aucune donnée sensible, pas de cookies).
  app.get('/leaderboard', async (request, reply) => {
    const query = request.query as { limit?: string } | undefined;
    let limit = 20;
    if (typeof query?.limit === 'string') {
      const parsed = Number.parseInt(query.limit, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        limit = Math.min(100, parsed);
      }
    }
    const entries = await store.listLeaderboard(limit);
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Cache-Control', 'public, max-age=30');
    return reply.code(200).send({
      count: entries.length,
      entries: entries.map((e) => ({
        rank: e.rank,
        townName: e.townName,
        difficulty: e.difficulty,
        outcome: e.outcome,
        daysSurvived: e.daysSurvived,
        survivors: e.survivors,
        population: e.population,
        endedAt: e.endedAt.toISOString(),
      })),
    });
  });

  /* ------------------------------ GET /towns ------------------------------ */
  app.get('/towns', async (request, reply) => {
    if (!requireAuth(request, reply, { jwtSecret })) return;
    const towns = await store.listOpenTowns();
    return reply.code(200).send({ towns: towns.map((t) => summarizeTown(t, presence)) });
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
      const { citizenId } = await store.joinTown(town.id, accountId, citizenName);
      await store.saveTown(town);
      publishSnapshot(town);
      await publishActivity(store, hub, town.id, {
        accountId,
        citizenId,
        citizenName,
        kind: 'town.create',
        details: { townName: town.name, difficulty: town.difficulty },
      });
      await publishActivity(store, hub, town.id, {
        accountId,
        citizenId,
        citizenName,
        kind: 'citizen.join',
        details: { citizen: citizenName },
      });
      scheduler?.scheduleTown(town.id, { day: town.game.day });
      return reply.code(201).send(fullTownState(town, accountId, presence, scheduler));
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
      const { citizenId } = await store.joinTown(townId, accountId, citizenName);
      const town = (await store.getTown(townId))!;
      await store.saveTown(town);
      publishSnapshot(town);
      await publishActivity(store, hub, town.id, {
        accountId,
        citizenId,
        citizenName,
        kind: 'citizen.join',
        details: { citizen: citizenName },
      });
      return reply.code(200).send(fullTownState(town, accountId, presence, scheduler));
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
    return reply.code(200).send(fullTownState(town, accountId, presence, scheduler));
  });

  /* ------------------------- GET /towns/:id/card ------------------------- */
  // Synthèse partageable de la partie du joueur : jours survécus, rôle, objets,
  // bâtiments, titre obtenu et texte de partage prêt pour X / Reddit. Le rendu
  // PNG est produit côté client (canvas) à partir de ces données.
  app.get('/towns/:townId/card', async (request, reply) => {
    const accountId = requireAuth(request, reply, { jwtSecret });
    if (!accountId) return;
    const townId = (request.params as { townId?: string }).townId as Id | undefined;
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
    const citizenId = town.membership.get(accountId);
    if (!citizenId) {
      return reply.code(403).send({
        error: { code: 'not-a-citizen', message: 'Vous devez être citoyen de cette ville' },
      });
    }
    const status = town.game.status();
    const citizen = status.citizens.find((c) => c.id === citizenId);
    const summary = buildEndgameCard({
      townName: town.name,
      difficulty: town.difficulty,
      outcome: status.outcome,
      gameOver: status.gameOver,
      daysSurvived: status.day,
      survivalDays: status.survivalDays,
      survivors: status.aliveCount,
      population: status.citizens.length,
      role: roleFor(town, accountId),
      citizenName: citizen?.name ?? 'Survivant',
      citizenAlive: citizen?.alive ?? false,
      causeOfDeath: citizen?.causeOfDeath ?? null,
      buildings: status.buildings,
      items: status.items,
    });
    return reply.code(200).send({ townId, card: summary });
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

  /* ---------------------------- POST /towns/:id/leave --------------------- */
  // Un joueur quitte définitivement la ville. Sa place est immédiatement
  // réattribuée à la tête de la file d'attente le cas échéant.
  app.post('/towns/:townId/leave', async (request, reply) => {
    const accountId = requireAuth(request, reply, { jwtSecret });
    if (!accountId) return;
    const townId = (request.params as { townId?: string }).townId as Id | undefined;
    if (!townId) {
      return reply.code(400).send({
        error: { code: 'town-id-missing', message: 'Identifiant de ville manquant' },
      });
    }
    try {
      // Nom du citoyen sortant, capturé avant retrait pour le journal.
      const before = await store.getTown(townId);
      const leavingCitizenId = before?.membership.get(accountId) ?? null;
      const leavingName = leavingCitizenId
        ? before?.game.status().citizens.find((c) => c.id === leavingCitizenId)?.name ?? null
        : null;

      const result = await store.leaveTown(townId, accountId);
      const town = (await store.getTown(townId))!;
      await store.saveTown(town);
      publishSnapshot(town);

      if (result.removedCitizenId && leavingName) {
        // Le compte sortant était présent en temps réel : on notifie son départ.
        if (presence.isOnline(townId, accountId)) {
          hub.publish(townId, {
            type: 'presence.update',
            accountId,
            citizenId: result.removedCitizenId,
            present: false,
            onlineCount: presence.onlineCount(townId),
          });
        }
        await publishActivity(store, hub, townId, {
          accountId,
          citizenId: result.removedCitizenId,
          citizenName: leavingName,
          kind: 'citizen.leave',
          details: { citizen: leavingName },
        });
      }
      if (result.promoted) {
        await publishActivity(store, hub, townId, {
          accountId: result.promoted.accountId,
          citizenId: result.promoted.citizenId,
          citizenName: result.promoted.citizenName,
          kind: 'citizen.promoted',
          details: { citizen: result.promoted.citizenName },
        });
      }
      return reply.code(200).send({
        left: result.removedCitizenId !== null,
        promoted: result.promoted
          ? { accountId: result.promoted.accountId, citizen: result.promoted.citizenName }
          : null,
      });
    } catch (err) {
      if (err instanceof StoreError) {
        const code = err.code === 'town-not-found' ? 404 : 409;
        return reply.code(code).send({ error: { code: err.code, message: err.message } });
      }
      throw err;
    }
  });

  /* --------------------------- GET /towns/:id/queue ----------------------- */
  // File d'attente ordonnée d'une ville pleine, avec pseudos et ta position.
  app.get('/towns/:townId/queue', async (request, reply) => {
    const accountId = requireAuth(request, reply, { jwtSecret });
    if (!accountId) return;
    const townId = (request.params as { townId?: string }).townId as Id | undefined;
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
    const queue = await store.getQueue(townId);
    const entries = await Promise.all(
      queue.map(async (q) => {
        const acc = await store.getAccount(q.accountId);
        return {
          accountId: q.accountId,
          position: q.position,
          name: acc ? acc.email.split('@')[0]! : 'inconnu',
          enqueuedAt: q.enqueuedAt.toISOString(),
        };
      }),
    );
    const yourPosition = entries.find((e) => e.accountId === accountId)?.position ?? null;
    return reply.code(200).send({ townId, size: entries.length, yourPosition, entries });
  });

  /* -------------------------- POST /towns/:id/queue ----------------------- */
  // Rejoindre la file d'attente d'une ville pleine.
  app.post('/towns/:townId/queue', async (request, reply) => {
    const accountId = requireAuth(request, reply, { jwtSecret });
    if (!accountId) return;
    const townId = (request.params as { townId?: string }).townId as Id | undefined;
    if (!townId) {
      return reply.code(400).send({
        error: { code: 'town-id-missing', message: 'Identifiant de ville manquant' },
      });
    }
    try {
      const { position, size } = await store.enqueueForTown(townId, accountId);
      const town = (await store.getTown(townId))!;
      await store.saveTown(town);
      return reply.code(201).send({ townId, position, size });
    } catch (err) {
      if (err instanceof StoreError) {
        const code =
          err.code === 'town-not-found' ? 404
            : err.code === 'town-closed'
              || err.code === 'already-joined'
              || err.code === 'already-queued' ? 409
              : err.code === 'town-not-full' ? 400
                : 400;
        return reply.code(code).send({ error: { code: err.code, message: err.message } });
      }
      throw err;
    }
  });

  /* ------------------------- DELETE /towns/:id/queue ---------------------- */
  // Quitter la file d'attente.
  app.delete('/towns/:townId/queue', async (request, reply) => {
    const accountId = requireAuth(request, reply, { jwtSecret });
    if (!accountId) return;
    const townId = (request.params as { townId?: string }).townId as Id | undefined;
    if (!townId) {
      return reply.code(400).send({
        error: { code: 'town-id-missing', message: 'Identifiant de ville manquant' },
      });
    }
    await store.leaveQueue(townId, accountId);
    const town = await store.getTown(townId);
    if (town) await store.saveTown(town);
    return reply.code(200).send({ townId, left: true });
  });

  /* ----------------------- PUT /towns/:id/bank/policy --------------------- */
  // Change le régime d'accès à la banque commune. Réservé au fondateur et aux
  // gestionnaires désignés.
  app.put('/towns/:townId/bank/policy', async (request, reply) => {
    const accountId = requireAuth(request, reply, { jwtSecret });
    if (!accountId) return;
    const townId = (request.params as { townId?: string }).townId as Id | undefined;
    if (!townId) {
      return reply.code(400).send({
        error: { code: 'town-id-missing', message: 'Identifiant de ville manquant' },
      });
    }
    const body = request.body as { policy?: unknown } | undefined;
    const policy = body?.policy;
    if (policy !== 'open' && policy !== 'restricted') {
      return reply.code(400).send({
        error: { code: 'policy-invalid', message: 'Régime invalide (open | restricted)' },
      });
    }
    const town = await store.getTown(townId);
    if (!town) {
      return reply.code(404).send({
        error: { code: 'town-not-found', message: 'Ville introuvable' },
      });
    }
    const role = roleFor(town, accountId);
    if (role === 'citizen') {
      return reply.code(403).send({
        error: { code: 'not-a-manager', message: 'Seuls le fondateur et les gestionnaires peuvent changer le régime de la banque' },
      });
    }
    await store.setBankPolicy(townId, policy as BankPolicy);
    const updated = (await store.getTown(townId))!;
    await store.saveTown(updated);
    const actorName = town.game.status().citizens
      .find((c) => c.id === town.membership.get(accountId))?.name ?? 'un gestionnaire';
    hub.publish(townId, { type: 'bank.policy', policy: policy as BankPolicy, by: actorName });
    await publishActivity(store, hub, townId, {
      accountId,
      citizenId: town.membership.get(accountId) ?? null,
      citizenName: actorName,
      kind: 'bank.policy',
      details: { policy },
    });
    return reply.code(200).send({ townId, policy });
  });

  /* --------------- PUT /towns/:id/bank/managers/:accountId ---------------- */
  // Accorde ou révoque le rôle de gestionnaire de banque. Réservé au fondateur.
  app.put('/towns/:townId/bank/managers/:targetId', async (request, reply) => {
    const accountId = requireAuth(request, reply, { jwtSecret });
    if (!accountId) return;
    const params = request.params as { townId?: string; targetId?: string };
    const townId = params.townId as Id | undefined;
    const targetId = params.targetId as Id | undefined;
    if (!townId || !targetId) {
      return reply.code(400).send({
        error: { code: 'params-missing', message: 'townId et targetId requis' },
      });
    }
    const body = request.body as { allowed?: unknown } | undefined;
    if (typeof body?.allowed !== 'boolean') {
      return reply.code(400).send({
        error: { code: 'allowed-invalid', message: 'Le champ "allowed" (booléen) est requis' },
      });
    }
    const town = await store.getTown(townId);
    if (!town) {
      return reply.code(404).send({
        error: { code: 'town-not-found', message: 'Ville introuvable' },
      });
    }
    if (roleFor(town, accountId) !== 'founder') {
      return reply.code(403).send({
        error: { code: 'not-the-founder', message: 'Seul le fondateur peut désigner les gestionnaires' },
      });
    }
    try {
      await store.setBankManager(townId, targetId, body.allowed);
      const updated = (await store.getTown(townId))!;
      await store.saveTown(updated);
      const status = updated.game.status();
      const actorName = status.citizens
        .find((c) => c.id === updated.membership.get(accountId))?.name ?? 'le fondateur';
      const targetName = status.citizens
        .find((c) => c.id === updated.membership.get(targetId))?.name ?? 'un citoyen';
      await publishActivity(store, hub, townId, {
        accountId,
        citizenId: updated.membership.get(accountId) ?? null,
        citizenName: actorName,
        kind: 'bank.manager',
        details: { target: targetName, allowed: body.allowed },
      });
      return reply.code(200).send({
        townId,
        accountId: targetId,
        allowed: body.allowed,
        managers: bankManagersView(updated),
      });
    } catch (err) {
      if (err instanceof StoreError) {
        const code = err.code === 'not-a-citizen' ? 400
          : err.code === 'founder-immutable' ? 409 : 404;
        return reply.code(code).send({ error: { code: err.code, message: err.message } });
      }
      throw err;
    }
  });
}
