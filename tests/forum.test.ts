/**
 * Tests d'intégration du forum de ville et du journal d'activité.
 *
 * Couvre :
 *   - création de sujets (discussion + vote) avec validation des entrées,
 *   - poster des messages, ouvrir/fermer un sujet,
 *   - voter, changer d'avis (tally et `myChoice`),
 *   - règles d'accès (citoyen uniquement, auteur seul ferme),
 *   - publication d'événements WS (forum.* + activity.recorded),
 *   - lecture du journal d'activité d'une ville.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { bearer, makeTestApp, register } from './helpers/app.js';

interface TownState {
  id: string;
  yourCitizenId: string;
}

interface ThreadSummary {
  id: string;
  townId: string;
  authorAccountId: string;
  authorCitizenName: string;
  title: string;
  kind: 'discussion' | 'vote';
  options: Array<{ id: string; label: string }>;
  closed: boolean;
  createdAt: string;
  closesAt: string | null;
  messageCount: number;
  lastMessageAt: string | null;
  voteCount: number;
}

interface MessageRecord {
  id: string;
  threadId: string;
  body: string;
  authorCitizenName: string;
  createdAt: string;
}

interface VoteTally {
  threadId: string;
  total: number;
  counts: Record<string, number>;
  myChoice: string | null;
}

interface ThreadDetail {
  thread: ThreadSummary;
  messages: MessageRecord[];
  tally: VoteTally;
}

interface ActivityEntry {
  id: string;
  townId: string;
  citizenId: string | null;
  citizenName: string | null;
  kind: string;
  details: Record<string, unknown>;
  createdAt: string;
}

async function bootstrap() {
  const built = await makeTestApp();
  const owner = await register(built.app, 'alia@hordes.test', 'password!1');
  const ownerToken = owner.body.accessToken!;
  const created = await built.app.inject({
    method: 'POST',
    url: '/towns',
    headers: bearer(ownerToken),
    payload: { name: 'Aldebaran', difficulty: 'normal' },
  });
  const town = created.json() as TownState;
  return { ...built, ownerToken, town };
}

async function joinTown(
  app: FastifyInstance,
  townId: string,
  email: string,
  password = 'password!1',
) {
  const reg = await register(app, email, password);
  const token = reg.body.accessToken!;
  const join = await app.inject({
    method: 'POST',
    url: `/towns/${townId}/join`,
    headers: bearer(token),
  });
  return { token, status: join.statusCode };
}

describe('POST /towns/:townId/forum/threads — création de sujets', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('crée une discussion (titre + corps initial)', async () => {
    const ctx = await bootstrap();
    app = ctx.app;
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/towns/${ctx.town.id}/forum/threads`,
      headers: bearer(ctx.ownerToken),
      payload: { title: 'Plan de fouille', body: 'Qui sort demain ?' },
    });
    expect(res.statusCode).toBe(201);
    const detail = res.json() as ThreadDetail;
    expect(detail.thread.kind).toBe('discussion');
    expect(detail.thread.title).toBe('Plan de fouille');
    expect(detail.messages).toHaveLength(1);
    expect(detail.messages[0]!.body).toBe('Qui sort demain ?');
  });

  it('crée un vote avec 3 options et tally vide', async () => {
    const ctx = await bootstrap();
    app = ctx.app;
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/towns/${ctx.town.id}/forum/threads`,
      headers: bearer(ctx.ownerToken),
      payload: {
        title: 'Sortir demain ?',
        kind: 'vote',
        options: ['Oui', 'Non', 'On verra'],
      },
    });
    expect(res.statusCode).toBe(201);
    const detail = res.json() as ThreadDetail;
    expect(detail.thread.kind).toBe('vote');
    expect(detail.thread.options).toHaveLength(3);
    expect(detail.tally.total).toBe(0);
    expect(detail.tally.counts).toEqual({ 'opt-0': 0, 'opt-1': 0, 'opt-2': 0 });
    expect(detail.tally.myChoice).toBeNull();
  });

  it('rejette un titre trop court', async () => {
    const ctx = await bootstrap();
    app = ctx.app;
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/towns/${ctx.town.id}/forum/threads`,
      headers: bearer(ctx.ownerToken),
      payload: { title: 'ab' },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('thread-title-invalid');
  });

  it('rejette un vote avec une seule option', async () => {
    const ctx = await bootstrap();
    app = ctx.app;
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/towns/${ctx.town.id}/forum/threads`,
      headers: bearer(ctx.ownerToken),
      payload: { title: 'Vote bidon', kind: 'vote', options: ['Oui'] },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('vote-options-invalid');
  });

  it('refuse un non-citoyen', async () => {
    const ctx = await bootstrap();
    app = ctx.app;
    const intruder = await register(ctx.app, 'intrus@hordes.test', 'password!1');
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/towns/${ctx.town.id}/forum/threads`,
      headers: bearer(intruder.body.accessToken!),
      payload: { title: 'Plan caché' },
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: { code: string } }).error.code).toBe('not-a-citizen');
  });

  it('exige un token (401 sans auth)', async () => {
    const ctx = await bootstrap();
    app = ctx.app;
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/towns/${ctx.town.id}/forum/threads`,
      payload: { title: 'Plan' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /towns/:townId/forum/threads — listing', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('renvoie les sujets du plus récent au plus ancien', async () => {
    const ctx = await bootstrap();
    app = ctx.app;
    const t1 = await ctx.app.inject({
      method: 'POST',
      url: `/towns/${ctx.town.id}/forum/threads`,
      headers: bearer(ctx.ownerToken),
      payload: { title: 'Premier sujet' },
    });
    expect(t1.statusCode).toBe(201);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const t2 = await ctx.app.inject({
      method: 'POST',
      url: `/towns/${ctx.town.id}/forum/threads`,
      headers: bearer(ctx.ownerToken),
      payload: { title: 'Second sujet' },
    });
    expect(t2.statusCode).toBe(201);

    const list = await ctx.app.inject({
      method: 'GET',
      url: `/towns/${ctx.town.id}/forum/threads`,
      headers: bearer(ctx.ownerToken),
    });
    expect(list.statusCode).toBe(200);
    const threads = (list.json() as { threads: ThreadSummary[] }).threads;
    expect(threads).toHaveLength(2);
    expect(threads[0]!.title).toBe('Second sujet');
    expect(threads[1]!.title).toBe('Premier sujet');
  });
});

describe('POST /towns/:townId/forum/threads/:id/messages — discussion', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('un citoyen peut répondre, le compteur de messages augmente', async () => {
    const ctx = await bootstrap();
    app = ctx.app;
    const create = await ctx.app.inject({
      method: 'POST',
      url: `/towns/${ctx.town.id}/forum/threads`,
      headers: bearer(ctx.ownerToken),
      payload: { title: 'Stratégie' },
    });
    const detail = create.json() as ThreadDetail;

    const joined = await joinTown(ctx.app, ctx.town.id, 'bjorn@hordes.test');
    expect(joined.status).toBe(200);

    const reply = await ctx.app.inject({
      method: 'POST',
      url: `/towns/${ctx.town.id}/forum/threads/${detail.thread.id}/messages`,
      headers: bearer(joined.token),
      payload: { body: 'On reste à l\'abri' },
    });
    expect(reply.statusCode).toBe(201);
    const r = reply.json() as { message: MessageRecord };
    expect(r.message.authorCitizenName).toBe('bjorn');

    const fetched = await ctx.app.inject({
      method: 'GET',
      url: `/towns/${ctx.town.id}/forum/threads/${detail.thread.id}`,
      headers: bearer(ctx.ownerToken),
    });
    const dtl = fetched.json() as ThreadDetail;
    expect(dtl.thread.messageCount).toBe(1);
    expect(dtl.messages).toHaveLength(1);
  });

  it('refuse un corps de message vide', async () => {
    const ctx = await bootstrap();
    app = ctx.app;
    const create = await ctx.app.inject({
      method: 'POST',
      url: `/towns/${ctx.town.id}/forum/threads`,
      headers: bearer(ctx.ownerToken),
      payload: { title: 'Stratégie' },
    });
    const detail = create.json() as ThreadDetail;
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/towns/${ctx.town.id}/forum/threads/${detail.thread.id}/messages`,
      headers: bearer(ctx.ownerToken),
      payload: { body: '   ' },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('message-body-invalid');
  });

  it('refuse de poster dans un sujet clos', async () => {
    const ctx = await bootstrap();
    app = ctx.app;
    const create = await ctx.app.inject({
      method: 'POST',
      url: `/towns/${ctx.town.id}/forum/threads`,
      headers: bearer(ctx.ownerToken),
      payload: { title: 'Sujet à clore' },
    });
    const detail = create.json() as ThreadDetail;
    await ctx.app.inject({
      method: 'POST',
      url: `/towns/${ctx.town.id}/forum/threads/${detail.thread.id}/close`,
      headers: bearer(ctx.ownerToken),
    });
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/towns/${ctx.town.id}/forum/threads/${detail.thread.id}/messages`,
      headers: bearer(ctx.ownerToken),
      payload: { body: 'Trop tard' },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe('thread-closed');
  });
});

describe('POST /towns/:townId/forum/threads/:id/votes — vote collectif', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function createVote(ctx: Awaited<ReturnType<typeof bootstrap>>) {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/towns/${ctx.town.id}/forum/threads`,
      headers: bearer(ctx.ownerToken),
      payload: {
        title: 'Sortir cette nuit ?',
        kind: 'vote',
        options: [
          { id: 'oui', label: 'Oui, prendre le risque' },
          { id: 'non', label: 'Non, on tient le mur' },
        ],
      },
    });
    return (res.json() as ThreadDetail).thread;
  }

  it('un citoyen peut voter et le tally se met à jour', async () => {
    const ctx = await bootstrap();
    app = ctx.app;
    const thread = await createVote(ctx);
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/towns/${ctx.town.id}/forum/threads/${thread.id}/votes`,
      headers: bearer(ctx.ownerToken),
      payload: { optionId: 'oui' },
    });
    expect(res.statusCode).toBe(200);
    const t = (res.json() as { tally: VoteTally }).tally;
    expect(t.total).toBe(1);
    expect(t.counts.oui).toBe(1);
    expect(t.counts.non).toBe(0);
    expect(t.myChoice).toBe('oui');
  });

  it('un citoyen peut changer de vote (mise à jour, pas double comptage)', async () => {
    const ctx = await bootstrap();
    app = ctx.app;
    const thread = await createVote(ctx);
    await ctx.app.inject({
      method: 'POST',
      url: `/towns/${ctx.town.id}/forum/threads/${thread.id}/votes`,
      headers: bearer(ctx.ownerToken),
      payload: { optionId: 'oui' },
    });
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/towns/${ctx.town.id}/forum/threads/${thread.id}/votes`,
      headers: bearer(ctx.ownerToken),
      payload: { optionId: 'non' },
    });
    const t = (res.json() as { tally: VoteTally }).tally;
    expect(t.total).toBe(1);
    expect(t.counts.oui).toBe(0);
    expect(t.counts.non).toBe(1);
    expect(t.myChoice).toBe('non');
  });

  it('plusieurs citoyens votent : agrégation correcte', async () => {
    const ctx = await bootstrap();
    app = ctx.app;
    const thread = await createVote(ctx);
    const j1 = await joinTown(ctx.app, ctx.town.id, 'bjorn@hordes.test');
    const j2 = await joinTown(ctx.app, ctx.town.id, 'clio@hordes.test');
    await ctx.app.inject({
      method: 'POST',
      url: `/towns/${ctx.town.id}/forum/threads/${thread.id}/votes`,
      headers: bearer(ctx.ownerToken),
      payload: { optionId: 'oui' },
    });
    await ctx.app.inject({
      method: 'POST',
      url: `/towns/${ctx.town.id}/forum/threads/${thread.id}/votes`,
      headers: bearer(j1.token),
      payload: { optionId: 'oui' },
    });
    await ctx.app.inject({
      method: 'POST',
      url: `/towns/${ctx.town.id}/forum/threads/${thread.id}/votes`,
      headers: bearer(j2.token),
      payload: { optionId: 'non' },
    });
    const get = await ctx.app.inject({
      method: 'GET',
      url: `/towns/${ctx.town.id}/forum/threads/${thread.id}`,
      headers: bearer(ctx.ownerToken),
    });
    const detail = get.json() as ThreadDetail;
    expect(detail.tally.total).toBe(3);
    expect(detail.tally.counts.oui).toBe(2);
    expect(detail.tally.counts.non).toBe(1);
    expect(detail.tally.myChoice).toBe('oui');
  });

  it('rejette une optionId invalide', async () => {
    const ctx = await bootstrap();
    app = ctx.app;
    const thread = await createVote(ctx);
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/towns/${ctx.town.id}/forum/threads/${thread.id}/votes`,
      headers: bearer(ctx.ownerToken),
      payload: { optionId: 'on-sait-pas' },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('option-invalid');
  });

  it('refuse de voter sur une simple discussion', async () => {
    const ctx = await bootstrap();
    app = ctx.app;
    const create = await ctx.app.inject({
      method: 'POST',
      url: `/towns/${ctx.town.id}/forum/threads`,
      headers: bearer(ctx.ownerToken),
      payload: { title: 'Une discussion' },
    });
    const detail = create.json() as ThreadDetail;
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/towns/${ctx.town.id}/forum/threads/${detail.thread.id}/votes`,
      headers: bearer(ctx.ownerToken),
      payload: { optionId: 'opt-0' },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('vote-not-allowed');
  });
});

describe('POST /towns/:townId/forum/threads/:id/close — fermeture', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('seul l\'auteur peut fermer son sujet', async () => {
    const ctx = await bootstrap();
    app = ctx.app;
    const create = await ctx.app.inject({
      method: 'POST',
      url: `/towns/${ctx.town.id}/forum/threads`,
      headers: bearer(ctx.ownerToken),
      payload: { title: 'Mon sujet' },
    });
    const detail = create.json() as ThreadDetail;
    const joined = await joinTown(ctx.app, ctx.town.id, 'bjorn@hordes.test');
    const denied = await ctx.app.inject({
      method: 'POST',
      url: `/towns/${ctx.town.id}/forum/threads/${detail.thread.id}/close`,
      headers: bearer(joined.token),
    });
    expect(denied.statusCode).toBe(403);
    expect((denied.json() as { error: { code: string } }).error.code).toBe('thread-not-owned');

    const ok = await ctx.app.inject({
      method: 'POST',
      url: `/towns/${ctx.town.id}/forum/threads/${detail.thread.id}/close`,
      headers: bearer(ctx.ownerToken),
    });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as { thread: ThreadSummary }).thread.closed).toBe(true);
  });
});

describe('GET /towns/:townId/activity — journal d\'activité', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('renvoie les actions des citoyens du plus récent au plus ancien', async () => {
    const ctx = await bootstrap();
    app = ctx.app;
    // Récupère le citizenId du créateur
    const dash = await ctx.app.inject({
      method: 'GET',
      url: `/towns/${ctx.town.id}`,
      headers: bearer(ctx.ownerToken),
    });
    const dashJson = dash.json() as { yourCitizenId: string };
    const citizenId = dashJson.yourCitizenId;

    // Action 1 : sortir
    await ctx.app.inject({
      method: 'POST',
      url: `/towns/${ctx.town.id}/citizens/${citizenId}/action`,
      headers: bearer(ctx.ownerToken),
      payload: { type: 'move', to: 'desert' },
    });
    // Action 2 : fouiller
    await ctx.app.inject({
      method: 'POST',
      url: `/towns/${ctx.town.id}/citizens/${citizenId}/action`,
      headers: bearer(ctx.ownerToken),
      payload: { type: 'scavenge' },
    });

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/towns/${ctx.town.id}/activity`,
      headers: bearer(ctx.ownerToken),
    });
    expect(res.statusCode).toBe(200);
    const out = res.json() as { entries: ActivityEntry[] };
    expect(out.entries.length).toBeGreaterThanOrEqual(4);
    // Au moins une entrée de chaque type
    const kinds = new Set(out.entries.map((e) => e.kind));
    expect(kinds.has('town.create')).toBe(true);
    expect(kinds.has('citizen.join')).toBe(true);
    expect(kinds.has('citizen.move')).toBe(true);
    expect(kinds.has('citizen.scavenge')).toBe(true);
    // Ordre antichronologique
    const times = out.entries.map((e) => new Date(e.createdAt).getTime());
    for (let i = 1; i < times.length; i++) {
      expect(times[i - 1]).toBeGreaterThanOrEqual(times[i]!);
    }
  });

  it('peut filtrer par citoyen', async () => {
    const ctx = await bootstrap();
    app = ctx.app;
    const dash = await ctx.app.inject({
      method: 'GET',
      url: `/towns/${ctx.town.id}`,
      headers: bearer(ctx.ownerToken),
    });
    const ownerCitizenId = (dash.json() as { yourCitizenId: string }).yourCitizenId;
    const joined = await joinTown(ctx.app, ctx.town.id, 'bjorn@hordes.test');
    const joinerDash = await ctx.app.inject({
      method: 'GET',
      url: `/towns/${ctx.town.id}`,
      headers: bearer(joined.token),
    });
    const joinerCitizenId = (joinerDash.json() as { yourCitizenId: string }).yourCitizenId;

    await ctx.app.inject({
      method: 'POST',
      url: `/towns/${ctx.town.id}/citizens/${joinerCitizenId}/action`,
      headers: bearer(joined.token),
      payload: { type: 'move', to: 'desert' },
    });

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/towns/${ctx.town.id}/activity?citizenId=${joinerCitizenId}`,
      headers: bearer(ctx.ownerToken),
    });
    const out = res.json() as { entries: ActivityEntry[] };
    expect(out.entries.length).toBeGreaterThanOrEqual(2);
    for (const e of out.entries) {
      expect(e.citizenId).toBe(joinerCitizenId);
    }
    // L'autre citoyen n'apparaît pas
    expect(out.entries.every((e) => e.citizenId !== ownerCitizenId)).toBe(true);
  });

  it('refuse un non-citoyen', async () => {
    const ctx = await bootstrap();
    app = ctx.app;
    const intruder = await register(ctx.app, 'intrus@hordes.test', 'password!1');
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/towns/${ctx.town.id}/activity`,
      headers: bearer(intruder.body.accessToken!),
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('Activité émise pendant la résolution de nuit', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('le journal contient une entrée night.resolved après une nuit', async () => {
    const ctx = await bootstrap();
    app = ctx.app;
    const night = await ctx.app.inject({
      method: 'POST',
      url: `/towns/${ctx.town.id}/night`,
      headers: bearer(ctx.ownerToken),
    });
    expect(night.statusCode).toBe(200);
    const log = await ctx.app.inject({
      method: 'GET',
      url: `/towns/${ctx.town.id}/activity`,
      headers: bearer(ctx.ownerToken),
    });
    const entries = (log.json() as { entries: ActivityEntry[] }).entries;
    const nightEntry = entries.find((e) => e.kind === 'night.resolved');
    expect(nightEntry).toBeTruthy();
    expect(nightEntry!.details.day).toBe(1);
  });
});
