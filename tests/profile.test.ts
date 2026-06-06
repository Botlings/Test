/**
 * Tests d'intégration du profil joueur : `/auth/me` (identité + statistiques)
 * et `/auth/me/history` (historique des villes auxquelles le compte a
 * participé).
 *
 * Ces routes sont la couche back de l'écran « Mon profil » du client.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { bearer, makeTestApp, register } from './helpers/app.js';

interface TownPayload {
  readonly id: string;
}

interface HistoryEntry {
  readonly townId: string;
  readonly townName: string;
  readonly difficulty: string;
  readonly joinedAt: string;
  readonly currentDay: number;
  readonly phase: string;
  readonly gameOver: boolean;
  readonly closed: boolean;
  readonly citizen: {
    readonly id: string;
    readonly name: string;
    readonly alive: boolean;
    readonly causeOfDeath: string | null;
  };
}

interface MePayload {
  readonly userId: string;
  readonly email: string;
  readonly createdAt: string;
  readonly stats: {
    readonly totalGames: number;
    readonly aliveGames: number;
    readonly deathsCount: number;
    readonly bestDay: number;
  };
}

describe('GET /auth/me', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('renvoie 401 sans token', async () => {
    const built = await makeTestApp();
    app = built.app;
    const res = await built.app.inject({ method: 'GET', url: '/auth/me' });
    expect(res.statusCode).toBe(401);
  });

  it('renvoie 401 si le token est mal formé', async () => {
    const built = await makeTestApp();
    app = built.app;
    const res = await built.app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: 'Bearer abc.def.ghi' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('renvoie l\'identité du compte authentifié et des stats vides au démarrage', async () => {
    const built = await makeTestApp();
    app = built.app;
    const reg = await register(built.app, 'profile@hordes.test', 'password!1');
    const res = await built.app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: bearer(reg.body.accessToken!),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as MePayload;
    expect(body.userId).toBe(reg.body.userId);
    expect(body.email).toBe('profile@hordes.test');
    expect(body.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(body.stats).toEqual({
      totalGames: 0,
      aliveGames: 0,
      deathsCount: 0,
      bestDay: 0,
    });
  });
});

describe('GET /auth/me/history', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('renvoie 401 sans token', async () => {
    const built = await makeTestApp();
    app = built.app;
    const res = await built.app.inject({ method: 'GET', url: '/auth/me/history' });
    expect(res.statusCode).toBe(401);
  });

  it('renvoie un historique vide pour un compte fraîchement créé', async () => {
    const built = await makeTestApp();
    app = built.app;
    const reg = await register(built.app, 'profile@hordes.test', 'password!1');
    const res = await built.app.inject({
      method: 'GET',
      url: '/auth/me/history',
      headers: bearer(reg.body.accessToken!),
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { history: HistoryEntry[] }).history).toEqual([]);
  });

  it('liste les villes fondées par le compte, avec leur citoyen actif', async () => {
    const built = await makeTestApp();
    app = built.app;
    const reg = await register(built.app, 'profile@hordes.test', 'password!1');
    const token = reg.body.accessToken!;

    const create = await built.app.inject({
      method: 'POST',
      url: '/towns',
      headers: bearer(token),
      payload: { name: 'Refuge-Sec', difficulty: 'normal' },
    });
    expect(create.statusCode).toBe(201);
    const town = create.json() as TownPayload;

    const res = await built.app.inject({
      method: 'GET',
      url: '/auth/me/history',
      headers: bearer(token),
    });
    expect(res.statusCode).toBe(200);
    const history = (res.json() as { history: HistoryEntry[] }).history;
    expect(history).toHaveLength(1);
    const entry = history[0]!;
    expect(entry.townId).toBe(town.id);
    expect(entry.townName).toBe('Refuge-Sec');
    expect(entry.difficulty).toBe('normal');
    expect(entry.currentDay).toBe(1);
    expect(entry.phase).toBe('day');
    expect(entry.gameOver).toBe(false);
    expect(entry.closed).toBe(false);
    expect(entry.citizen.alive).toBe(true);
    expect(entry.citizen.name).toBe('profile');
    expect(entry.citizen.causeOfDeath).toBeNull();
    expect(entry.joinedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // Le profil reflète immédiatement la nouvelle ville dans les stats.
    const me = await built.app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: bearer(token),
    });
    const meBody = me.json() as MePayload;
    expect(meBody.stats.totalGames).toBe(1);
    expect(meBody.stats.aliveGames).toBe(1);
    expect(meBody.stats.bestDay).toBe(1);
  });

  it('marque le citoyen comme disparu après une nuit fatale et expose la cause', async () => {
    const built = await makeTestApp();
    app = built.app;
    const reg = await register(built.app, 'doomed@hordes.test', 'password!1');
    const token = reg.body.accessToken!;

    // Difficulté hardcore : la horde nocturne dépasse largement la défense
    // initiale, le citoyen seul de la ville sera tué dès la première nuit.
    const create = await built.app.inject({
      method: 'POST',
      url: '/towns',
      headers: bearer(token),
      payload: { name: 'Cendre-Faubourg', difficulty: 'hardcore' },
    });
    expect(create.statusCode).toBe(201);
    const town = create.json() as TownPayload;

    const night = await built.app.inject({
      method: 'POST',
      url: `/towns/${town.id}/night`,
      headers: bearer(token),
    });
    expect(night.statusCode).toBe(200);

    const res = await built.app.inject({
      method: 'GET',
      url: '/auth/me/history',
      headers: bearer(token),
    });
    expect(res.statusCode).toBe(200);
    const entry = (res.json() as { history: HistoryEntry[] }).history[0]!;
    expect(entry.citizen.alive).toBe(false);
    expect(entry.citizen.causeOfDeath).not.toBeNull();
    expect(entry.gameOver).toBe(true);
    expect(entry.closed).toBe(true);

    const me = await built.app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: bearer(token),
    });
    const meBody = me.json() as MePayload;
    expect(meBody.stats.totalGames).toBe(1);
    expect(meBody.stats.aliveGames).toBe(0);
    expect(meBody.stats.deathsCount).toBe(1);
  });

  it('trie les villes de la plus récente à la plus ancienne', async () => {
    const built = await makeTestApp();
    app = built.app;
    const reg = await register(built.app, 'serial@hordes.test', 'password!1');
    const token = reg.body.accessToken!;

    const c1 = await built.app.inject({
      method: 'POST',
      url: '/towns',
      headers: bearer(token),
      payload: { name: 'Premier-Refuge', difficulty: 'normal' },
    });
    // Petit délai pour garantir un ordre temporel strict entre les deux entrées.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const c2 = await built.app.inject({
      method: 'POST',
      url: '/towns',
      headers: bearer(token),
      payload: { name: 'Second-Refuge', difficulty: 'hard' },
    });
    expect(c1.statusCode).toBe(201);
    expect(c2.statusCode).toBe(201);

    const res = await built.app.inject({
      method: 'GET',
      url: '/auth/me/history',
      headers: bearer(token),
    });
    const history = (res.json() as { history: HistoryEntry[] }).history;
    expect(history).toHaveLength(2);
    expect(history[0]!.townName).toBe('Second-Refuge');
    expect(history[1]!.townName).toBe('Premier-Refuge');
  });

  it('isole l\'historique entre comptes distincts', async () => {
    const built = await makeTestApp();
    app = built.app;
    const a = await register(built.app, 'a@hordes.test', 'password!1');
    const b = await register(built.app, 'b@hordes.test', 'password!1');

    await built.app.inject({
      method: 'POST',
      url: '/towns',
      headers: bearer(a.body.accessToken!),
      payload: { name: 'Alpha-Refuge', difficulty: 'normal' },
    });

    const resB = await built.app.inject({
      method: 'GET',
      url: '/auth/me/history',
      headers: bearer(b.body.accessToken!),
    });
    expect(resB.statusCode).toBe(200);
    expect((resB.json() as { history: HistoryEntry[] }).history).toEqual([]);

    const resA = await built.app.inject({
      method: 'GET',
      url: '/auth/me/history',
      headers: bearer(a.body.accessToken!),
    });
    const aHistory = (resA.json() as { history: HistoryEntry[] }).history;
    expect(aHistory).toHaveLength(1);
    expect(aHistory[0]!.townName).toBe('Alpha-Refuge');
  });
});
