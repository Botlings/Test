/**
 * Crafting à l'établi de bout en bout, à travers la pile réelle
 * (API HTTP Fastify → store en mémoire).
 *
 * Vérifie :
 *   - le catalogue public `GET /crafting/catalog` (15 recettes, forge requise) ;
 *   - le garde-fou « forge d'abord » : fabriquer sans atelier renvoie 409 ;
 *   - le cycle nominal : ériger l'atelier (forge) puis fabriquer une corde,
 *     avec débit effectif de la banque et du stock côté serveur ;
 *   - le rejet d'une recette inconnue (400).
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { bearer, makeTestApp, register } from './helpers/app.js';

interface DashResponse {
  id: string;
  yourCitizenId: string;
  bank: { wood: number; metal: number; water: number };
  citizens: Array<{ id: string; actionPoints: number }>;
}

interface ActionResponse {
  ok: boolean;
  bank: { wood: number; metal: number; water: number };
  items: Record<string, number>;
  citizen: { actionPoints: number };
}

async function bootstrap() {
  const built = await makeTestApp();
  const reg = await register(built.app, 'forgeron@hordes.test', 'password!1');
  const token = reg.body.accessToken!;
  const created = await built.app.inject({
    method: 'POST',
    url: '/towns',
    headers: bearer(token),
    payload: { name: 'Forgeville', difficulty: 'normal' },
  });
  const town = created.json() as DashResponse;
  return { app: built.app, token, townId: town.id, citizenId: town.yourCitizenId };
}

describe('Crafting — établi de la forge via l\'API', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('expose 15 recettes adossées à la forge sur /crafting/catalog', async () => {
    const built = await makeTestApp();
    app = built.app;
    const res = await app.inject({ method: 'GET', url: '/crafting/catalog' });
    expect(res.statusCode).toBe(200);
    const recipes = (res.json() as {
      recipes: Array<{ id: string; requiresBuilding: string; outputs: { items: Record<string, number> } }>;
    }).recipes;
    expect(recipes).toHaveLength(15);
    expect(recipes.every((r) => r.requiresBuilding === 'workshop')).toBe(true);
    const steel = recipes.find((r) => r.id === 'craft-steel-beam')!;
    expect(steel.outputs.items['steel-beam']).toBe(1);
  });

  it('refuse de fabriquer tant que la forge n\'est pas érigée (409)', async () => {
    const ctx = await bootstrap();
    app = ctx.app;
    const res = await app.inject({
      method: 'POST',
      url: `/towns/${ctx.townId}/citizens/${ctx.citizenId}/action`,
      headers: bearer(ctx.token),
      payload: { type: 'craft', recipeId: 'craft-rope' },
    });
    expect(res.statusCode).toBe(409);
    const err = (res.json() as { error: { code: string; message: string } }).error;
    expect(err.code).toBe('rule-violation');
    expect(err.message).toMatch(/forge/i);
  });

  it('érige la forge puis fabrique une corde : banque et stock débités côté serveur', async () => {
    const ctx = await bootstrap();
    app = ctx.app;
    const actionUrl = `/towns/${ctx.townId}/citizens/${ctx.citizenId}/action`;

    // Érige l'atelier (forge) : coûte 12 bois / 8 métal / 3 PA.
    const build = await app.inject({
      method: 'POST',
      url: actionUrl,
      headers: bearer(ctx.token),
      payload: { type: 'construct', buildingId: 'workshop' },
    });
    expect(build.statusCode).toBe(200);
    const afterBuild = build.json() as ActionResponse;
    expect(afterBuild.bank.wood).toBe(20 - 12);
    expect(afterBuild.bank.metal).toBe(10 - 8);

    // Fabrique une corde : 4 bois → 1 corde, 1 PA.
    const craft = await app.inject({
      method: 'POST',
      url: actionUrl,
      headers: bearer(ctx.token),
      payload: { type: 'craft', recipeId: 'craft-rope' },
    });
    expect(craft.statusCode).toBe(200);
    const after = craft.json() as ActionResponse;
    expect(after.items.rope).toBe(1);
    expect(after.bank.wood).toBe(8 - 4);
    // 6 PA de départ − 3 (atelier) − 1 (corde) = 2.
    expect(after.citizen.actionPoints).toBe(6 - 3 - 1);
  });

  it('rejette une recette inconnue avec 400', async () => {
    const ctx = await bootstrap();
    app = ctx.app;
    const res = await app.inject({
      method: 'POST',
      url: `/towns/${ctx.townId}/citizens/${ctx.citizenId}/action`,
      headers: bearer(ctx.token),
      payload: { type: 'craft', recipeId: 'craft-teleporter' },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('recipe-unknown');
  });
});
