/**
 * Routes de gouvernance sociale d'une ville (mécaniques Hordes authentiques).
 *
 *   GET  /towns/:townId/governance                     — état complet (perso)
 *   POST /towns/:townId/governance/election            — ouvrir un scrutin
 *   POST /towns/:townId/governance/election/vote       — voter pour un candidat
 *   POST /towns/:townId/governance/election/close      — clôturer le scrutin
 *   POST /towns/:townId/governance/curfew              — décréter un couvre-feu (maire)
 *   POST /towns/:townId/governance/bank                — fermer/ouvrir la banque (maire)
 *   POST /towns/:townId/governance/exile               — ouvrir une motion d'exil
 *   POST /towns/:townId/governance/exile/vote          — voter pour/contre l'exil
 *
 * Toutes les routes exigent que l'appelant soit citoyen VIVANT de la ville.
 * L'orchestration des effets de bord (retrait d'un exilé via `leaveTown`,
 * fermeture de banque via `setBankPolicy`) réutilise les primitives du store ;
 * l'état de gouvernance lui-même vit sur `town.governance` (persisté en JSONB).
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireAuth } from '../auth-guard.js';
import {
  type BankPolicy,
  type Store,
  type TownRecord,
} from '../../persistence/store.js';
import type { Id } from '../../persistence/types.js';
import type { RealtimeHub } from '../../realtime/hub.js';
import type { PresenceRegistry } from '../../realtime/presence.js';
import { publishActivity } from '../activity.js';
import type { GovernanceUpdatedMessage } from '../../realtime/protocol.js';
import {
  ELECTION_INTERVAL_DAYS,
  canOpenElection,
  openElection,
  castMayorVote,
  mayorTally,
  closeElection,
  isMayor,
  curfewActive,
  decreeCurfew,
  pruneMayor,
  openMotionAgainst,
  openExileMotion,
  exileTally,
  castExileVote,
  dropMotion,
} from '../../domain/governance.js';

interface GovernanceDeps {
  readonly store: Store;
  readonly jwtSecret: string;
  readonly hub: RealtimeHub;
  readonly presence: PresenceRegistry;
}

/** Le citoyen contrôlé par un compte, ou `null`. */
function citizenOf(town: TownRecord, accountId: Id) {
  const citizenId = town.membership.get(accountId);
  if (!citizenId) return null;
  return town.game.status().citizens.find((c) => c.id === citizenId) ?? null;
}

/** Compte propriétaire d'un citoyen donné (recherche inverse). */
function accountOfCitizen(town: TownRecord, citizenId: string): Id | null {
  for (const [acc, cid] of town.membership.entries()) {
    if (cid === citizenId) return acc;
  }
  return null;
}

/** Vue personnalisée de la gouvernance pour l'appelant. */
function governanceView(town: TownRecord, accountId: Id) {
  const status = town.game.status();
  const g = town.governance;
  const yourCitizenId = town.membership.get(accountId) ?? null;
  const alive = status.citizens.filter((c) => c.alive);
  const aliveIds = alive.map((c) => c.id);
  const nameOf = (id: string) => status.citizens.find((c) => c.id === id)?.name ?? id;

  const election = g.election
    ? {
        id: g.election.id,
        openedDay: g.election.openedDay,
        openedByName: g.election.openedByName,
        totalVotes: Object.keys(g.election.votes).length,
        myVote: g.election.votes[accountId] ?? null,
        tally: mayorTally(g.election, aliveIds).map((l) => ({
          candidateCitizenId: l.candidateCitizenId,
          name: nameOf(l.candidateCitizenId),
          votes: l.votes,
        })),
      }
    : null;

  const exileMotions = g.exileMotions
    .filter((m) => m.status === 'open')
    .map((m) => {
      const t = exileTally(m);
      return {
        id: m.id,
        targetCitizenId: m.targetCitizenId,
        targetName: m.targetName,
        openedByName: m.openedByName,
        openedDay: m.openedDay,
        for: t.for,
        against: t.against,
        myVote: m.votes[accountId] ?? null,
        isSelf: m.targetCitizenId === yourCitizenId,
      };
    });

  return {
    day: status.day,
    electionIntervalDays: ELECTION_INTERVAL_DAYS,
    yourCitizenId,
    isMayor: isMayor(g, yourCitizenId),
    canOpenElection: canOpenElection(g, status.day),
    mayor: g.mayor,
    election,
    curfew: {
      active: curfewActive(g, status.day),
      decreedDay: g.curfew?.decreedDay ?? null,
      by: g.curfew?.by ?? null,
    },
    exileMotions,
    candidates: alive.map((c) => ({ citizenId: c.id, name: c.name })),
  };
}

export function registerGovernanceRoutes(app: FastifyInstance, deps: GovernanceDeps): void {
  const { store, jwtSecret, hub, presence } = deps;

  /**
   * Résout le contexte commun d'une action : auth, ville, citoyen vivant.
   * Renvoie `null` (et a déjà répondu) si un contrôle échoue.
   */
  async function resolveActor(
    request: FastifyRequest,
    reply: FastifyReply,
    opts: { requireAlive?: boolean } = {},
  ): Promise<{ accountId: Id; town: TownRecord; citizenId: string; citizenName: string } | null> {
    const accountId = requireAuth(request, reply, { jwtSecret });
    if (!accountId) return null;
    const townId = (request.params as { townId?: string }).townId as Id | undefined;
    if (!townId) {
      reply.code(400).send({ error: { code: 'town-id-missing', message: 'Identifiant de ville manquant' } });
      return null;
    }
    const town = await store.getTown(townId);
    if (!town) {
      reply.code(404).send({ error: { code: 'town-not-found', message: 'Ville introuvable' } });
      return null;
    }
    const citizen = citizenOf(town, accountId);
    if (!citizen) {
      reply.code(403).send({ error: { code: 'not-a-citizen', message: 'Vous devez être citoyen de cette ville' } });
      return null;
    }
    if (town.closed) {
      reply.code(409).send({ error: { code: 'town-closed', message: 'Cette ville est terminée' } });
      return null;
    }
    if (opts.requireAlive !== false && !citizen.alive) {
      reply.code(409).send({ error: { code: 'citizen-dead', message: 'Votre citoyen est mort et ne peut plus agir' } });
      return null;
    }
    return { accountId, town, citizenId: citizen.id, citizenName: citizen.name };
  }

  function broadcastGovernance(town: TownRecord, reason: GovernanceUpdatedMessage['reason']): void {
    hub.publish(town.id, { type: 'governance.updated', reason });
  }

  /* ---------------------------- GET /governance --------------------------- */
  app.get('/towns/:townId/governance', async (request, reply) => {
    const accountId = requireAuth(request, reply, { jwtSecret });
    if (!accountId) return;
    const townId = (request.params as { townId?: string }).townId as Id | undefined;
    if (!townId) {
      return reply.code(400).send({ error: { code: 'town-id-missing', message: 'Identifiant de ville manquant' } });
    }
    const town = await store.getTown(townId);
    if (!town) {
      return reply.code(404).send({ error: { code: 'town-not-found', message: 'Ville introuvable' } });
    }
    if (!town.membership.has(accountId)) {
      return reply.code(403).send({ error: { code: 'not-a-citizen', message: 'Vous devez être citoyen de cette ville' } });
    }
    return reply.code(200).send({ townId, governance: governanceView(town, accountId) });
  });

  /* --------------------- POST /governance/election ----------------------- */
  app.post('/towns/:townId/governance/election', async (request, reply) => {
    const ctx = await resolveActor(request, reply);
    if (!ctx) return;
    const { accountId, town, citizenId, citizenName } = ctx;
    if (!canOpenElection(town.governance, town.game.status().day)) {
      return reply.code(409).send({
        error: {
          code: 'election-not-allowed',
          message: town.governance.election
            ? 'Un scrutin est déjà en cours'
            : `Le mandat en cours n'est pas encore ouvert à réélection (tous les ${ELECTION_INTERVAL_DAYS} jours)`,
        },
      });
    }
    const day = town.game.status().day;
    town.governance = openElection(town.governance, { id: randomUUID(), day, openedByName: citizenName });
    await store.saveTown(town);
    await publishActivity(store, hub, town.id, {
      accountId, citizenId, citizenName, kind: 'election.opened', details: { day },
    });
    broadcastGovernance(town, 'election.opened');
    return reply.code(201).send({ townId: town.id, governance: governanceView(town, accountId) });
  });

  /* ------------------- POST /governance/election/vote -------------------- */
  app.post('/towns/:townId/governance/election/vote', async (request, reply) => {
    const ctx = await resolveActor(request, reply);
    if (!ctx) return;
    const { accountId, town } = ctx;
    if (!town.governance.election) {
      return reply.code(409).send({ error: { code: 'no-election', message: 'Aucun scrutin en cours' } });
    }
    const candidateCitizenId = (request.body as { candidateCitizenId?: unknown } | undefined)?.candidateCitizenId;
    if (typeof candidateCitizenId !== 'string') {
      return reply.code(400).send({ error: { code: 'candidate-invalid', message: 'candidateCitizenId requis' } });
    }
    const alive = town.game.status().citizens.some((c) => c.alive && c.id === candidateCitizenId);
    if (!alive) {
      return reply.code(400).send({ error: { code: 'candidate-invalid', message: 'Le candidat doit être un citoyen vivant' } });
    }
    town.governance = castMayorVote(town.governance, { accountId, candidateCitizenId });
    await store.saveTown(town);
    broadcastGovernance(town, 'vote');
    return reply.code(200).send({ townId: town.id, governance: governanceView(town, accountId) });
  });

  /* ------------------ POST /governance/election/close -------------------- */
  app.post('/towns/:townId/governance/election/close', async (request, reply) => {
    const ctx = await resolveActor(request, reply);
    if (!ctx) return;
    const { accountId, town, citizenId, citizenName } = ctx;
    if (!town.governance.election) {
      return reply.code(409).send({ error: { code: 'no-election', message: 'Aucun scrutin en cours' } });
    }
    const status = town.game.status();
    const alive = status.citizens.filter((c) => c.alive).map((c) => ({ id: c.id, name: c.name }));
    const { state, winner } = closeElection(town.governance, { day: status.day, aliveCitizens: alive });
    town.governance = state;
    await store.saveTown(town);
    if (winner) {
      // Le sujet du journal est le maire élu (pas celui qui a clos le scrutin).
      const winnerAccountId = accountOfCitizen(town, winner.citizenId);
      await publishActivity(store, hub, town.id, {
        accountId: winnerAccountId,
        citizenId: winner.citizenId,
        citizenName: winner.citizenName,
        kind: 'mayor.elected',
        details: { mayorName: winner.citizenName, closedByName: citizenName },
      });
      broadcastGovernance(town, 'mayor.elected');
    } else {
      broadcastGovernance(town, 'vote');
    }
    return reply.code(200).send({
      townId: town.id,
      elected: winner ? { citizenId: winner.citizenId, name: winner.citizenName } : null,
      governance: governanceView(town, accountId),
    });
  });

  /* ------------------------ POST /governance/curfew ---------------------- */
  app.post('/towns/:townId/governance/curfew', async (request, reply) => {
    const ctx = await resolveActor(request, reply);
    if (!ctx) return;
    const { accountId, town, citizenId, citizenName } = ctx;
    if (!isMayor(town.governance, citizenId)) {
      return reply.code(403).send({ error: { code: 'not-the-mayor', message: 'Seul le maire peut décréter un couvre-feu' } });
    }
    const day = town.game.status().day;
    if (curfewActive(town.governance, day)) {
      return reply.code(409).send({ error: { code: 'curfew-active', message: 'Un couvre-feu est déjà en vigueur cette nuit' } });
    }
    town.governance = decreeCurfew(town.governance, { day, by: citizenName });
    await store.saveTown(town);
    await publishActivity(store, hub, town.id, {
      accountId, citizenId, citizenName, kind: 'mayor.curfew', details: { day },
    });
    broadcastGovernance(town, 'curfew');
    return reply.code(200).send({ townId: town.id, governance: governanceView(town, accountId) });
  });

  /* ------------------------- POST /governance/bank ----------------------- */
  // Pouvoir du maire : fermer (restricted) ou rouvrir (open) la banque commune.
  app.post('/towns/:townId/governance/bank', async (request, reply) => {
    const ctx = await resolveActor(request, reply);
    if (!ctx) return;
    const { accountId, town, citizenId, citizenName } = ctx;
    if (!isMayor(town.governance, citizenId)) {
      return reply.code(403).send({ error: { code: 'not-the-mayor', message: 'Seul le maire peut décider du régime de la banque' } });
    }
    const policy = (request.body as { policy?: unknown } | undefined)?.policy;
    if (policy !== 'open' && policy !== 'restricted') {
      return reply.code(400).send({ error: { code: 'policy-invalid', message: 'Régime invalide (open | restricted)' } });
    }
    await store.setBankPolicy(town.id, policy as BankPolicy);
    const updated = (await store.getTown(town.id))!;
    await store.saveTown(updated);
    hub.publish(town.id, { type: 'bank.policy', policy: policy as BankPolicy, by: citizenName });
    await publishActivity(store, hub, town.id, {
      accountId, citizenId, citizenName, kind: 'bank.policy', details: { policy, byMayor: true },
    });
    return reply.code(200).send({ townId: town.id, policy });
  });

  /* ------------------------ POST /governance/exile ----------------------- */
  app.post('/towns/:townId/governance/exile', async (request, reply) => {
    const ctx = await resolveActor(request, reply);
    if (!ctx) return;
    const { accountId, town, citizenId, citizenName } = ctx;
    const day = town.game.status().day;
    if (curfewActive(town.governance, day)) {
      return reply.code(409).send({ error: { code: 'curfew-active', message: 'Aucune motion d\'exil sous couvre-feu' } });
    }
    const targetCitizenId = (request.body as { targetCitizenId?: unknown } | undefined)?.targetCitizenId;
    if (typeof targetCitizenId !== 'string') {
      return reply.code(400).send({ error: { code: 'target-invalid', message: 'targetCitizenId requis' } });
    }
    if (targetCitizenId === citizenId) {
      return reply.code(400).send({ error: { code: 'target-self', message: 'Vous ne pouvez pas demander votre propre exil' } });
    }
    const target = town.game.status().citizens.find((c) => c.alive && c.id === targetCitizenId);
    if (!target) {
      return reply.code(400).send({ error: { code: 'target-invalid', message: 'La cible doit être un citoyen vivant' } });
    }
    if (openMotionAgainst(town.governance, targetCitizenId)) {
      return reply.code(409).send({ error: { code: 'motion-exists', message: 'Une motion d\'exil vise déjà cet habitant' } });
    }
    const motionId = randomUUID();
    town.governance = openExileMotion(town.governance, {
      id: motionId, targetCitizenId, targetName: target.name, openedByName: citizenName, day,
    });
    await store.saveTown(town);
    await publishActivity(store, hub, town.id, {
      accountId, citizenId, citizenName, kind: 'exile.opened',
      details: { targetName: target.name, targetCitizenId, motionId },
    });
    broadcastGovernance(town, 'exile.opened');
    return reply.code(201).send({ townId: town.id, motionId, governance: governanceView(town, accountId) });
  });

  /* --------------------- POST /governance/exile/vote --------------------- */
  app.post('/towns/:townId/governance/exile/vote', async (request, reply) => {
    const ctx = await resolveActor(request, reply);
    if (!ctx) return;
    const { accountId, town, citizenId, citizenName } = ctx;
    const body = request.body as { motionId?: unknown; support?: unknown } | undefined;
    const motionId = typeof body?.motionId === 'string' ? body.motionId : '';
    if (!motionId || typeof body?.support !== 'boolean') {
      return reply.code(400).send({ error: { code: 'vote-invalid', message: 'motionId et support (booléen) requis' } });
    }
    const motion = town.governance.exileMotions.find((m) => m.id === motionId && m.status === 'open');
    if (!motion) {
      return reply.code(404).send({ error: { code: 'motion-not-found', message: 'Motion d\'exil introuvable ou déjà close' } });
    }
    if (motion.targetCitizenId === citizenId) {
      return reply.code(403).send({ error: { code: 'vote-self', message: 'Vous ne pouvez pas voter sur votre propre exil' } });
    }
    const status = town.game.status();
    // Base de la majorité : citoyens vivants hors la cible (qui ne vote pas).
    const aliveCount = status.citizens.filter((c) => c.alive && c.id !== motion.targetCitizenId).length;
    const result = castExileVote(town.governance, { motionId, accountId, support: body.support, aliveCount });
    town.governance = result.state;
    const resolved = result.motion;

    if (resolved && resolved.status === 'passed') {
      // La motion passe : on retire la motion de l'état puis on expulse la cible.
      town.governance = dropMotion(town.governance, motionId);
      await store.saveTown(town);
      const targetAccountId = accountOfCitizen(town, resolved.targetCitizenId);
      if (targetAccountId) {
        const result2 = await store.leaveTown(town.id, targetAccountId);
        const fresh = (await store.getTown(town.id))!;
        // Le maire a peut-être été expulsé : on le destitue si besoin.
        const aliveIds = fresh.game.status().citizens.filter((c) => c.alive).map((c) => c.id);
        fresh.governance = pruneMayor(fresh.governance, aliveIds);
        await store.saveTown(fresh);
        if (presence.isOnline(town.id, targetAccountId) && result2.removedCitizenId) {
          hub.publish(town.id, {
            type: 'presence.update',
            accountId: targetAccountId,
            citizenId: result2.removedCitizenId,
            present: false,
            onlineCount: presence.onlineCount(town.id),
          });
        }
        if (result2.promoted) {
          await publishActivity(store, hub, town.id, {
            accountId: result2.promoted.accountId,
            citizenId: result2.promoted.citizenId,
            citizenName: result2.promoted.citizenName,
            kind: 'citizen.promoted',
            details: { citizen: result2.promoted.citizenName },
          });
        }
      }
      await publishActivity(store, hub, town.id, {
        accountId: null,
        citizenId: resolved.targetCitizenId,
        citizenName: resolved.targetName,
        kind: 'exile.passed',
        details: { targetName: resolved.targetName, byName: citizenName },
      });
      broadcastGovernance(town, 'exile.passed');
      const finalTown = (await store.getTown(town.id))!;
      return reply.code(200).send({
        townId: town.id, motionId, outcome: 'passed',
        governance: governanceView(finalTown, accountId),
      });
    }

    if (resolved && resolved.status === 'rejected') {
      town.governance = dropMotion(town.governance, motionId);
      await store.saveTown(town);
      await publishActivity(store, hub, town.id, {
        accountId: null,
        citizenId: resolved.targetCitizenId,
        citizenName: resolved.targetName,
        kind: 'exile.rejected',
        details: { targetName: resolved.targetName },
      });
      broadcastGovernance(town, 'exile.rejected');
      return reply.code(200).send({
        townId: town.id, motionId, outcome: 'rejected', governance: governanceView(town, accountId),
      });
    }

    await store.saveTown(town);
    broadcastGovernance(town, 'vote');
    return reply.code(200).send({
      townId: town.id, motionId, outcome: 'open', governance: governanceView(town, accountId),
    });
  });
}
