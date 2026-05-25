import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { bearer, makeTestApp, register } from './helpers/app.js';

interface TownState {
  id: string;
  name: string;
  difficulty: string;
  day: number;
  phase: string;
  townDefense: number;
  bank: Record<string, number>;
  citizens: Array<{ id: string; name: string; alive: boolean; location: string }>;
  yourCitizenId: string | null;
}

describe('GET /towns', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('exige un token d\'accès', async () => {
    const built = await makeTestApp();
    app = built.app;
    const res = await built.app.inject({ method: 'GET', url: '/towns' });
    expect(res.statusCode).toBe(401);
  });

  it('renvoie une liste vide initialement', async () => {
    const built = await makeTestApp();
    app = built.app;
    const reg = await register(built.app, 'a@b.com', 'password!1');
    const res = await built.app.inject({
      method: 'GET',
      url: '/towns',
      headers: bearer(reg.body.accessToken!),
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { towns: unknown[] }).towns).toEqual([]);
  });
});

describe('POST /towns', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('crée une ville et inscrit le créateur comme premier citoyen', async () => {
    const built = await makeTestApp();
    app = built.app;
    const reg = await register(built.app, 'alia@hordes.test', 'password!1');
    const res = await built.app.inject({
      method: 'POST',
      url: '/towns',
      headers: bearer(reg.body.accessToken!),
      payload: { name: 'Aldebaran', difficulty: 'normal' },
    });
    expect(res.statusCode).toBe(201);
    const town = res.json() as TownState;
    expect(town.name).toBe('Aldebaran');
    expect(town.difficulty).toBe('normal');
    expect(town.day).toBe(1);
    expect(town.phase).toBe('day');
    expect(town.citizens).toHaveLength(1);
    expect(town.yourCitizenId).toBe(town.citizens[0]!.id);
  });

  it('rejette un nom de ville trop court', async () => {
    const built = await makeTestApp();
    app = built.app;
    const reg = await register(built.app, 'a@b.com', 'password!1');
    const res = await built.app.inject({
      method: 'POST',
      url: '/towns',
      headers: bearer(reg.body.accessToken!),
      payload: { name: 'ab', difficulty: 'normal' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejette une difficulté inconnue', async () => {
    const built = await makeTestApp();
    app = built.app;
    const reg = await register(built.app, 'a@b.com', 'password!1');
    const res = await built.app.inject({
      method: 'POST',
      url: '/towns',
      headers: bearer(reg.body.accessToken!),
      payload: { name: 'Aldebaran', difficulty: 'pas-une-difficulte' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /towns/:id/join', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('permet à un autre joueur de rejoindre une ville', async () => {
    const built = await makeTestApp();
    app = built.app;
    const creator = await register(built.app, 'alia@hordes.test', 'password!1');
    const created = await built.app.inject({
      method: 'POST',
      url: '/towns',
      headers: bearer(creator.body.accessToken!),
      payload: { name: 'Aldebaran', difficulty: 'normal' },
    });
    const townId = (created.json() as TownState).id;

    const joiner = await register(built.app, 'bjorn@hordes.test', 'password!1');
    const res = await built.app.inject({
      method: 'POST',
      url: `/towns/${townId}/join`,
      headers: bearer(joiner.body.accessToken!),
    });
    expect(res.statusCode).toBe(200);
    const town = res.json() as TownState;
    expect(town.citizens).toHaveLength(2);
    expect(town.yourCitizenId).toBeTruthy();
    expect(town.yourCitizenId).not.toBe(creator.body.userId);
  });

  it('refuse de rejoindre deux fois la même ville', async () => {
    const built = await makeTestApp();
    app = built.app;
    const reg = await register(built.app, 'alia@hordes.test', 'password!1');
    const created = await built.app.inject({
      method: 'POST',
      url: '/towns',
      headers: bearer(reg.body.accessToken!),
      payload: { name: 'Aldebaran', difficulty: 'normal' },
    });
    const townId = (created.json() as TownState).id;
    const res = await built.app.inject({
      method: 'POST',
      url: `/towns/${townId}/join`,
      headers: bearer(reg.body.accessToken!),
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe('already-joined');
  });

  it('refuse au-delà de la capacité maximale (10 joueurs)', async () => {
    const built = await makeTestApp();
    app = built.app;
    const reg = await register(built.app, 'alia@hordes.test', 'password!1');
    const created = await built.app.inject({
      method: 'POST',
      url: '/towns',
      headers: bearer(reg.body.accessToken!),
      payload: { name: 'Aldebaran', difficulty: 'normal' },
    });
    const townId = (created.json() as TownState).id;
    for (let i = 1; i <= 9; i++) {
      const joiner = await register(built.app, `j${i}@hordes.test`, 'password!1');
      const res = await built.app.inject({
        method: 'POST',
        url: `/towns/${townId}/join`,
        headers: bearer(joiner.body.accessToken!),
      });
      expect(res.statusCode).toBe(200);
    }
    // 11ème joueur : refusé.
    const eleventh = await register(built.app, 'late@hordes.test', 'password!1');
    const tooLate = await built.app.inject({
      method: 'POST',
      url: `/towns/${townId}/join`,
      headers: bearer(eleventh.body.accessToken!),
    });
    expect(tooLate.statusCode).toBe(409);
    expect((tooLate.json() as { error: { code: string } }).error.code).toBe('town-full');
  });

  it('renvoie 404 sur ville inconnue', async () => {
    const built = await makeTestApp();
    app = built.app;
    const reg = await register(built.app, 'a@b.com', 'password!1');
    const res = await built.app.inject({
      method: 'POST',
      url: '/towns/00000000-0000-0000-0000-000000000000/join',
      headers: bearer(reg.body.accessToken!),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /towns/:id', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('renvoie le tableau de bord complet', async () => {
    const built = await makeTestApp();
    app = built.app;
    const reg = await register(built.app, 'a@b.com', 'password!1');
    const created = await built.app.inject({
      method: 'POST',
      url: '/towns',
      headers: bearer(reg.body.accessToken!),
      payload: { name: 'Aldebaran', difficulty: 'normal' },
    });
    const townId = (created.json() as TownState).id;
    const res = await built.app.inject({
      method: 'GET',
      url: `/towns/${townId}`,
      headers: bearer(reg.body.accessToken!),
    });
    expect(res.statusCode).toBe(200);
    const dash = res.json() as TownState & { bank: { water: number } };
    expect(dash.bank.water).toBeGreaterThan(0);
    expect(dash.citizens).toHaveLength(1);
  });
});
