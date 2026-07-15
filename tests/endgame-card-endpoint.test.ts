/**
 * Endpoint GET /towns/:id/card — carte de fin de partie partageable.
 *
 * Preuve à travers la pile réelle (API HTTP → MemoryStore → moteur) : auth
 * requise, membership requise, et la synthèse expose bien titre, rôle, jours
 * survécus et texte de partage.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { bearer, makeTestApp, register } from './helpers/app.js';

interface CardResponse {
  townId: string;
  card: {
    townName: string;
    difficulty: string;
    difficultyLabel: string;
    outcome: string;
    daysSurvived: number;
    survivalDays: number;
    role: string;
    roleLabel: string;
    title: string;
    subtitle: string;
    shareText: string;
    totalItems: number;
    items: Array<{ id: string; name: string; count: number }>;
    totalBuildings: number;
    buildings: Array<{ id: string; count: number }>;
  };
}

async function createTown(app: FastifyInstance, token: string, name: string, difficulty = 'normal') {
  const res = await app.inject({
    method: 'POST',
    url: '/towns',
    headers: bearer(token),
    payload: { name, difficulty },
  });
  return res.json() as { id: string };
}

describe('GET /towns/:id/card', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('exige un token d\'accès', async () => {
    const built = await makeTestApp();
    app = built.app;
    const res = await built.app.inject({ method: 'GET', url: '/towns/whatever/card' });
    expect(res.statusCode).toBe(401);
  });

  it('renvoie 404 pour une ville inconnue', async () => {
    const built = await makeTestApp();
    app = built.app;
    const reg = await register(built.app, 'a@b.com', 'password!1');
    const res = await built.app.inject({
      method: 'GET',
      url: '/towns/ghost-town/card',
      headers: bearer(reg.body.accessToken!),
    });
    expect(res.statusCode).toBe(404);
  });

  it('refuse un non-citoyen (403)', async () => {
    const built = await makeTestApp();
    app = built.app;
    const owner = await register(built.app, 'owner@hordes.test', 'password!1');
    const town = await createTown(built.app, owner.body.accessToken!, 'Fort Aride');
    const stranger = await register(built.app, 'stranger@hordes.test', 'password!1');
    const res = await built.app.inject({
      method: 'GET',
      url: `/towns/${town.id}/card`,
      headers: bearer(stranger.body.accessToken!),
    });
    expect(res.statusCode).toBe(403);
  });

  it('produit la carte du fondateur avec titre et texte de partage', async () => {
    const built = await makeTestApp();
    app = built.app;
    const owner = await register(built.app, 'alia@hordes.test', 'password!1');
    const town = await createTown(built.app, owner.body.accessToken!, 'Fort Aride', 'hard');
    const res = await built.app.inject({
      method: 'GET',
      url: `/towns/${town.id}/card`,
      headers: bearer(owner.body.accessToken!),
    });
    expect(res.statusCode).toBe(200);
    const { card } = res.json() as CardResponse;
    expect(card.townName).toBe('Fort Aride');
    expect(card.difficulty).toBe('hard');
    expect(card.difficultyLabel).toBe('Difficile');
    expect(card.outcome).toBe('ongoing');
    expect(card.role).toBe('founder');
    expect(card.roleLabel).toBe('Fondateur');
    expect(card.daysSurvived).toBe(1);
    expect(card.title.length).toBeGreaterThan(0);
    expect(card.shareText).toContain('Fort Aride');
    expect(card.shareText).toContain('#HordesRevival');
    expect(card.totalItems).toBe(0);
    expect(card.totalBuildings).toBe(0);
  });
});
