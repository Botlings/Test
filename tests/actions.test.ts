import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { bearer, makeTestApp, register } from './helpers/app.js';

interface DashResponse {
  id: string;
  day: number;
  phase: string;
  townDefense: number;
  bank: { wood: number; metal: number; water: number };
  citizens: Array<{
    id: string;
    name: string;
    alive: boolean;
    location: 'town' | 'desert';
    actionPoints: number;
  }>;
  yourCitizenId: string;
  closed: boolean;
}

async function bootstrapTown(difficulty: 'normal' | 'hard' | 'hardcore' = 'normal') {
  const built = await makeTestApp();
  const reg = await register(built.app, 'alia@hordes.test', 'password!1');
  const accessToken = reg.body.accessToken!;
  const created = await built.app.inject({
    method: 'POST',
    url: '/towns',
    headers: bearer(accessToken),
    payload: { name: 'Aldebaran', difficulty },
  });
  const town = created.json() as DashResponse;
  return { ...built, accessToken, townId: town.id, citizenId: town.yourCitizenId };
}

describe('POST /towns/:townId/citizens/:citizenId/action', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('move : déplace en désert puis rentre en ville', async () => {
    const ctx = await bootstrapTown();
    app = ctx.app;
    const moveOut = await ctx.app.inject({
      method: 'POST',
      url: `/towns/${ctx.townId}/citizens/${ctx.citizenId}/action`,
      headers: bearer(ctx.accessToken),
      payload: { type: 'move', to: 'desert' },
    });
    expect(moveOut.statusCode).toBe(200);
    expect((moveOut.json() as { citizen: { location: string } }).citizen.location).toBe('desert');

    const moveBack = await ctx.app.inject({
      method: 'POST',
      url: `/towns/${ctx.townId}/citizens/${ctx.citizenId}/action`,
      headers: bearer(ctx.accessToken),
      payload: { type: 'move', to: 'town' },
    });
    expect(moveBack.statusCode).toBe(200);
    expect((moveBack.json() as { citizen: { location: string } }).citizen.location).toBe('town');
  });

  it('scavenge : ajoute des ressources à la banque et consomme des PA', async () => {
    const ctx = await bootstrapTown();
    app = ctx.app;
    await ctx.app.inject({
      method: 'POST',
      url: `/towns/${ctx.townId}/citizens/${ctx.citizenId}/action`,
      headers: bearer(ctx.accessToken),
      payload: { type: 'move', to: 'desert' },
    });
    const before = ctx.store.getTown(ctx.townId as unknown as never)!.game.status();
    const scavenge = await ctx.app.inject({
      method: 'POST',
      url: `/towns/${ctx.townId}/citizens/${ctx.citizenId}/action`,
      headers: bearer(ctx.accessToken),
      payload: { type: 'scavenge' },
    });
    expect(scavenge.statusCode).toBe(200);
    const body = scavenge.json() as { bank: { wood: number } };
    expect(body.bank.wood).toBeGreaterThan(before.bank.wood);
  });

  it('build : augmente la défense, dépense ressources', async () => {
    const ctx = await bootstrapTown();
    app = ctx.app;
    const before = ctx.store.getTown(ctx.townId as unknown as never)!.game.status();
    const build = await ctx.app.inject({
      method: 'POST',
      url: `/towns/${ctx.townId}/citizens/${ctx.citizenId}/action`,
      headers: bearer(ctx.accessToken),
      payload: { type: 'build' },
    });
    expect(build.statusCode).toBe(200);
    const body = build.json() as { townDefense: number; bank: { wood: number } };
    expect(body.townDefense).toBeGreaterThan(before.townDefense);
    expect(body.bank.wood).toBeLessThan(before.bank.wood);
  });

  it('rejette une action sur le citoyen d\'un autre joueur', async () => {
    const ctx = await bootstrapTown();
    app = ctx.app;
    const intruder = await register(ctx.app, 'mallory@hordes.test', 'password!1');
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/towns/${ctx.townId}/citizens/${ctx.citizenId}/action`,
      headers: bearer(intruder.body.accessToken!),
      payload: { type: 'build' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejette une action invalide (build depuis le désert)', async () => {
    const ctx = await bootstrapTown();
    app = ctx.app;
    await ctx.app.inject({
      method: 'POST',
      url: `/towns/${ctx.townId}/citizens/${ctx.citizenId}/action`,
      headers: bearer(ctx.accessToken),
      payload: { type: 'move', to: 'desert' },
    });
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/towns/${ctx.townId}/citizens/${ctx.citizenId}/action`,
      headers: bearer(ctx.accessToken),
      payload: { type: 'build' },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe('rule-violation');
  });
});

describe('POST /towns/:townId/night', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('résout la nuit, broadcast night.start + night.report, fait passer au jour 2', async () => {
    const ctx = await bootstrapTown();
    app = ctx.app;
    // On construit pour faire passer la défense au-dessus de la horde
    // (12 par défaut au jour 1) afin que le citoyen survive à la nuit.
    await ctx.app.inject({
      method: 'POST',
      url: `/towns/${ctx.townId}/citizens/${ctx.citizenId}/action`,
      headers: bearer(ctx.accessToken),
      payload: { type: 'build' },
    });
    const events: Array<{ type: string }> = [];
    ctx.hub.subscribe(ctx.townId, (m) => events.push(m as { type: string }));

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/towns/${ctx.townId}/night`,
      headers: bearer(ctx.accessToken),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { report: { day: number; survivors: number; breached: boolean } };
    expect(body.report.day).toBe(1);
    expect(body.report.breached).toBe(false);
    expect(events.some((e) => e.type === 'night.start')).toBe(true);
    expect(events.some((e) => e.type === 'night.report')).toBe(true);
    expect(events.some((e) => e.type === 'town.snapshot')).toBe(true);

    const dash = await ctx.app.inject({
      method: 'GET',
      url: `/towns/${ctx.townId}`,
      headers: bearer(ctx.accessToken),
    });
    expect((dash.json() as { day: number }).day).toBe(2);
  });

  it('lock : deux résolutions simultanées → la seconde lève "night-already-running"', async () => {
    const ctx = await bootstrapTown();
    app = ctx.app;
    const [a, b] = await Promise.all([
      ctx.app.inject({
        method: 'POST',
        url: `/towns/${ctx.townId}/night`,
        headers: bearer(ctx.accessToken),
      }),
      ctx.app.inject({
        method: 'POST',
        url: `/towns/${ctx.townId}/night`,
        headers: bearer(ctx.accessToken),
      }),
    ]);
    const statuses = [a.statusCode, b.statusCode].sort();
    expect(statuses).toEqual([200, 409]);
    const losing = a.statusCode === 200 ? b : a;
    expect((losing.json() as { error: { code: string } }).error.code).toBe('night-already-running');
  });

  it('refuse un joueur non-membre de la ville', async () => {
    const ctx = await bootstrapTown();
    app = ctx.app;
    const outsider = await register(ctx.app, 'outsider@hordes.test', 'password!1');
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/towns/${ctx.townId}/night`,
      headers: bearer(outsider.body.accessToken!),
    });
    expect(res.statusCode).toBe(403);
  });

  it('survit ou meurt sur 7 jours : la fin de partie ferme la ville', async () => {
    // En difficulté hardcore + sans construire ni fouiller, la ville finit
    // par tomber avant le jour 7.
    const ctx = await bootstrapTown('hardcore');
    app = ctx.app;
    let dayJustEnded = 0;
    let closedAt: number | null = null;
    while (dayJustEnded < 10) {
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/towns/${ctx.townId}/night`,
        headers: bearer(ctx.accessToken),
      });
      if (res.statusCode !== 200) break;
      const body = res.json() as { report: { day: number; gameOver: boolean } };
      dayJustEnded = body.report.day;
      if (body.report.gameOver) {
        closedAt = dayJustEnded;
        break;
      }
    }
    expect(closedAt).not.toBeNull();
    // Une fois fermée, on ne peut plus relancer la nuit.
    const retry = await ctx.app.inject({
      method: 'POST',
      url: `/towns/${ctx.townId}/night`,
      headers: bearer(ctx.accessToken),
    });
    expect(retry.statusCode).toBe(409);
  });
});
