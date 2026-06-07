/**
 * Routes du forum in-game et du journal d'activité d'une ville.
 *
 *   GET    /towns/:townId/forum/threads                 — liste
 *   POST   /towns/:townId/forum/threads                 — créer (discussion | vote)
 *   GET    /towns/:townId/forum/threads/:threadId       — détail + messages + tally
 *   POST   /towns/:townId/forum/threads/:threadId/messages   — poster
 *   POST   /towns/:townId/forum/threads/:threadId/votes      — voter
 *   POST   /towns/:townId/forum/threads/:threadId/close      — fermer (auteur uniquement)
 *   GET    /towns/:townId/activity                            — journal d'activité
 *
 * Toutes les routes exigent que l'appelant soit citoyen de la ville. Les
 * mutations publient le message WS correspondant + une entrée d'activité.
 */
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth-guard.js';
import {
  StoreError,
  type ForumThreadKind,
  type ForumVoteOption,
  type Store,
  type TownRecord,
} from '../../persistence/store.js';
import type { Id } from '../../persistence/types.js';
import type { RealtimeHub } from '../../realtime/hub.js';
import { publishActivity } from '../activity.js';

interface ForumDeps {
  readonly store: Store;
  readonly jwtSecret: string;
  readonly hub: RealtimeHub;
}

const VALID_KINDS: ReadonlySet<ForumThreadKind> = new Set(['discussion', 'vote']);

function citizenNameOf(town: TownRecord, accountId: Id): string | null {
  const citizenId = town.membership.get(accountId);
  if (!citizenId) return null;
  const citizen = town.game.status().citizens.find((c) => c.id === citizenId);
  return citizen?.name ?? null;
}

/** Code HTTP standard pour une `StoreError` du forum. */
function statusForStoreCode(code: string): number {
  switch (code) {
    case 'town-not-found':
    case 'thread-not-found':
      return 404;
    case 'thread-closed':
    case 'vote-closed':
      return 409;
    case 'thread-title-invalid':
    case 'message-body-invalid':
    case 'vote-options-invalid':
    case 'option-invalid':
    case 'vote-not-allowed':
      return 400;
    default:
      return 400;
  }
}

export function registerForumRoutes(app: FastifyInstance, deps: ForumDeps): void {
  const { store, jwtSecret, hub } = deps;

  /* ----------------------- GET /towns/:townId/forum/threads ----------------------- */
  app.get('/towns/:townId/forum/threads', async (request, reply) => {
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
    if (!town.membership.has(accountId)) {
      return reply.code(403).send({
        error: { code: 'not-a-citizen', message: 'Vous devez être citoyen de cette ville' },
      });
    }
    const threads = await store.listForumThreads(townId, accountId);
    return reply.code(200).send({ townId, threads });
  });

  /* ----------------------- POST /towns/:townId/forum/threads ---------------------- */
  app.post('/towns/:townId/forum/threads', async (request, reply) => {
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
    const citizenName = citizenNameOf(town, accountId);
    if (!citizenName) {
      return reply.code(403).send({
        error: { code: 'not-a-citizen', message: 'Vous devez être citoyen de cette ville' },
      });
    }
    const body = request.body as {
      title?: unknown;
      kind?: unknown;
      options?: unknown;
      closesAt?: unknown;
      body?: unknown;
    } | undefined;
    const title = typeof body?.title === 'string' ? body.title : '';
    const kindRaw = typeof body?.kind === 'string' ? (body.kind as ForumThreadKind) : 'discussion';
    if (!VALID_KINDS.has(kindRaw)) {
      return reply.code(400).send({
        error: { code: 'thread-kind-invalid', message: 'Type de sujet invalide (discussion | vote)' },
      });
    }
    let options: ForumVoteOption[] | undefined;
    if (kindRaw === 'vote') {
      if (!Array.isArray(body?.options)) {
        return reply.code(400).send({
          error: { code: 'vote-options-invalid', message: 'Options du vote manquantes' },
        });
      }
      options = (body!.options as unknown[]).map((raw, idx) => {
        if (typeof raw === 'string') return { id: `opt-${idx}`, label: raw };
        const obj = raw as { id?: unknown; label?: unknown };
        return {
          id: typeof obj?.id === 'string' ? obj.id : `opt-${idx}`,
          label: typeof obj?.label === 'string' ? obj.label : '',
        };
      });
    }
    let closesAt: Date | null = null;
    if (typeof body?.closesAt === 'string') {
      const parsed = new Date(body.closesAt);
      if (Number.isNaN(parsed.getTime())) {
        return reply.code(400).send({
          error: { code: 'closes-at-invalid', message: 'Date de clôture invalide' },
        });
      }
      closesAt = parsed;
    }
    try {
      const detail = await store.createForumThread({
        townId,
        authorAccountId: accountId,
        authorCitizenName: citizenName,
        title,
        kind: kindRaw,
        ...(options ? { options } : {}),
        closesAt,
        ...(typeof body?.body === 'string' ? { body: body.body } : {}),
      });
      hub.publish(townId, { type: 'forum.thread.created', thread: detail.thread });
      const activityKind = kindRaw === 'vote' ? 'forum.vote.created' : 'forum.thread.created';
      await publishActivity(store, hub, townId, {
        accountId,
        citizenId: town.membership.get(accountId) ?? null,
        citizenName,
        kind: activityKind,
        details: { title: detail.thread.title, threadId: detail.thread.id },
      });
      return reply.code(201).send(detail);
    } catch (err) {
      if (err instanceof StoreError) {
        return reply.code(statusForStoreCode(err.code)).send({
          error: { code: err.code, message: err.message },
        });
      }
      throw err;
    }
  });

  /* ----------------- GET /towns/:townId/forum/threads/:threadId ------------------- */
  app.get('/towns/:townId/forum/threads/:threadId', async (request, reply) => {
    const accountId = requireAuth(request, reply, { jwtSecret });
    if (!accountId) return;
    const params = request.params as { townId?: string; threadId?: string };
    const townId = params.townId as Id | undefined;
    const threadId = params.threadId as Id | undefined;
    if (!townId || !threadId) {
      return reply.code(400).send({
        error: { code: 'params-missing', message: 'townId et threadId requis' },
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
    const detail = await store.getForumThread(townId, threadId, accountId);
    if (!detail) {
      return reply.code(404).send({
        error: { code: 'thread-not-found', message: 'Sujet introuvable' },
      });
    }
    return reply.code(200).send(detail);
  });

  /* ------- POST /towns/:townId/forum/threads/:threadId/messages ------- */
  app.post(
    '/towns/:townId/forum/threads/:threadId/messages',
    async (request, reply) => {
      const accountId = requireAuth(request, reply, { jwtSecret });
      if (!accountId) return;
      const params = request.params as { townId?: string; threadId?: string };
      const townId = params.townId as Id | undefined;
      const threadId = params.threadId as Id | undefined;
      if (!townId || !threadId) {
        return reply.code(400).send({
          error: { code: 'params-missing', message: 'townId et threadId requis' },
        });
      }
      const town = await store.getTown(townId);
      if (!town) {
        return reply.code(404).send({
          error: { code: 'town-not-found', message: 'Ville introuvable' },
        });
      }
      const citizenName = citizenNameOf(town, accountId);
      if (!citizenName) {
        return reply.code(403).send({
          error: { code: 'not-a-citizen', message: 'Vous devez être citoyen de cette ville' },
        });
      }
      const body = (request.body as { body?: unknown } | undefined)?.body;
      if (typeof body !== 'string') {
        return reply.code(400).send({
          error: { code: 'message-body-invalid', message: 'Le corps du message est requis' },
        });
      }
      try {
        const message = await store.postForumMessage({
          townId,
          threadId,
          authorAccountId: accountId,
          authorCitizenName: citizenName,
          body,
        });
        hub.publish(townId, { type: 'forum.message.posted', threadId, message });
        await publishActivity(store, hub, townId, {
          accountId,
          citizenId: town.membership.get(accountId) ?? null,
          citizenName,
          kind: 'forum.message.posted',
          details: { threadId },
        });
        return reply.code(201).send({ message });
      } catch (err) {
        if (err instanceof StoreError) {
          return reply.code(statusForStoreCode(err.code)).send({
            error: { code: err.code, message: err.message },
          });
        }
        throw err;
      }
    },
  );

  /* -------- POST /towns/:townId/forum/threads/:threadId/votes -------- */
  app.post(
    '/towns/:townId/forum/threads/:threadId/votes',
    async (request, reply) => {
      const accountId = requireAuth(request, reply, { jwtSecret });
      if (!accountId) return;
      const params = request.params as { townId?: string; threadId?: string };
      const townId = params.townId as Id | undefined;
      const threadId = params.threadId as Id | undefined;
      if (!townId || !threadId) {
        return reply.code(400).send({
          error: { code: 'params-missing', message: 'townId et threadId requis' },
        });
      }
      const town = await store.getTown(townId);
      if (!town) {
        return reply.code(404).send({
          error: { code: 'town-not-found', message: 'Ville introuvable' },
        });
      }
      const citizenName = citizenNameOf(town, accountId);
      if (!citizenName) {
        return reply.code(403).send({
          error: { code: 'not-a-citizen', message: 'Vous devez être citoyen de cette ville' },
        });
      }
      const optionId = (request.body as { optionId?: unknown } | undefined)?.optionId;
      if (typeof optionId !== 'string') {
        return reply.code(400).send({
          error: { code: 'option-invalid', message: 'optionId requis' },
        });
      }
      try {
        const tally = await store.castForumVote({
          townId,
          threadId,
          accountId,
          citizenName,
          optionId,
        });
        hub.publish(townId, { type: 'forum.vote.cast', threadId, tally });
        await publishActivity(store, hub, townId, {
          accountId,
          citizenId: town.membership.get(accountId) ?? null,
          citizenName,
          kind: 'forum.vote.cast',
          details: { threadId, optionId },
        });
        return reply.code(200).send({ tally });
      } catch (err) {
        if (err instanceof StoreError) {
          return reply.code(statusForStoreCode(err.code)).send({
            error: { code: err.code, message: err.message },
          });
        }
        throw err;
      }
    },
  );

  /* -------- POST /towns/:townId/forum/threads/:threadId/close -------- */
  app.post(
    '/towns/:townId/forum/threads/:threadId/close',
    async (request, reply) => {
      const accountId = requireAuth(request, reply, { jwtSecret });
      if (!accountId) return;
      const params = request.params as { townId?: string; threadId?: string };
      const townId = params.townId as Id | undefined;
      const threadId = params.threadId as Id | undefined;
      if (!townId || !threadId) {
        return reply.code(400).send({
          error: { code: 'params-missing', message: 'townId et threadId requis' },
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
      const existing = await store.getForumThread(townId, threadId, accountId);
      if (!existing) {
        return reply.code(404).send({
          error: { code: 'thread-not-found', message: 'Sujet introuvable' },
        });
      }
      if (existing.thread.authorAccountId !== accountId) {
        return reply.code(403).send({
          error: { code: 'thread-not-owned', message: 'Seul l\'auteur peut clore ce sujet' },
        });
      }
      try {
        const summary = await store.closeForumThread(townId, threadId);
        hub.publish(townId, { type: 'forum.thread.closed', threadId });
        return reply.code(200).send({ thread: summary });
      } catch (err) {
        if (err instanceof StoreError) {
          return reply.code(statusForStoreCode(err.code)).send({
            error: { code: err.code, message: err.message },
          });
        }
        throw err;
      }
    },
  );

  /* ------------------------ GET /towns/:townId/activity ------------------------ */
  app.get('/towns/:townId/activity', async (request, reply) => {
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
    if (!town.membership.has(accountId)) {
      return reply.code(403).send({
        error: { code: 'not-a-citizen', message: 'Vous devez être citoyen de cette ville' },
      });
    }
    const query = request.query as { limit?: string; citizenId?: string } | undefined;
    let limit = 50;
    if (typeof query?.limit === 'string') {
      const parsed = Number.parseInt(query.limit, 10);
      if (Number.isFinite(parsed) && parsed > 0) limit = Math.min(500, parsed);
    }
    let entries = await store.listActivity(townId, limit);
    if (query?.citizenId) {
      entries = entries.filter((e) => e.citizenId === query.citizenId);
    }
    return reply.code(200).send({ townId, count: entries.length, entries });
  });
}
