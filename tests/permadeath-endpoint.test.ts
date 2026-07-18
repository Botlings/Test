/**
 * Mode fantôme (permadeath) de bout en bout, à travers la pile réelle
 * (API HTTP Fastify → store en mémoire → résolveur de nuit).
 *
 * Scénario : deux survivants dans une même ville en difficulté `normal`.
 * L'éclaireur part au désert et s'y fait dévorer pendant l'assaut ; le garde
 * resté dans les murs tient (défense 10 + 1 guetteur × 2 = 12 ≥ horde 12). La
 * ville continue. On vérifie alors que le compte de l'éclaireur :
 *   • bascule en « mode fantôme » (youAreGhost, yourCitizenAlive=false) et
 *     reçoit son épitaphe dans l'état de ville ;
 *   • ne peut plus agir (toute action est rejetée) mais observe encore la ville ;
 *   • porte une épitaphe dans son historique de profil.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { bearer, makeTestApp, register } from './helpers/app.js';

interface TownState {
  id: string;
  yourCitizenId: string;
  youAreGhost: boolean;
  yourCitizenAlive: boolean | null;
  yourEpitaph: string | null;
  gameOver: boolean;
  closed: boolean;
  citizens: Array<{ id: string; name: string; alive: boolean; location: string }>;
}

describe('Permadeath — mode fantôme via l\'API', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('bascule un mort en fantôme observateur incapable d\'agir, avec épitaphe', async () => {
    const built = await makeTestApp();
    app = built.app;

    // Le garde crée la ville (difficulté normal).
    const guard = await register(app, 'guard@example.com', 'password!1');
    const guardToken = guard.body.accessToken!;
    const created = await app.inject({
      method: 'POST',
      url: '/towns',
      headers: bearer(guardToken),
      payload: { name: 'Bastion', difficulty: 'normal' },
    });
    const town = created.json() as TownState;
    const townId = town.id;

    // L'éclaireur rejoint la même ville.
    const scout = await register(app, 'scout@example.com', 'password!1');
    const scoutToken = scout.body.accessToken!;
    const joined = await app.inject({
      method: 'POST',
      url: `/towns/${townId}/join`,
      headers: bearer(scoutToken),
    });
    const scoutState = joined.json() as TownState;
    const scoutCitizenId = scoutState.yourCitizenId;

    // L'éclaireur sort dans le désert (il y passera la nuit → mort certaine).
    const moved = await app.inject({
      method: 'POST',
      url: `/towns/${townId}/citizens/${scoutCitizenId}/action`,
      headers: bearer(scoutToken),
      payload: { type: 'move', to: 'desert' },
    });
    expect(moved.statusCode).toBe(200);

    // Le garde déclenche la nuit.
    const night = await app.inject({
      method: 'POST',
      url: `/towns/${townId}/night`,
      headers: bearer(guardToken),
    });
    expect(night.statusCode).toBe(200);
    const report = (night.json() as { report: { gameOver: boolean; salvagedWater: number; deathsBySource: { desert: number } } }).report;
    // La ville tient : la partie continue (le garde a survécu).
    expect(report.gameOver).toBe(false);
    expect(report.deathsBySource.desert).toBe(1);
    // Corps abandonné au désert → aucun legs d'eau à la banque.
    expect(report.salvagedWater).toBe(0);

    // L'éclaireur observe la ville : il est passé fantôme.
    const ghostView = await app.inject({
      method: 'GET',
      url: `/towns/${townId}`,
      headers: bearer(scoutToken),
    });
    expect(ghostView.statusCode).toBe(200);
    const ghost = ghostView.json() as TownState;
    expect(ghost.youAreGhost).toBe(true);
    expect(ghost.yourCitizenAlive).toBe(false);
    expect(ghost.yourEpitaph).toBeTruthy();
    expect(ghost.yourEpitaph).toContain('Ci-gît');
    // Il voit toujours l'état de la ville et son garde vivant.
    expect(ghost.citizens.some((c) => c.alive)).toBe(true);

    // Toute action du fantôme est refusée (observation sans interaction).
    const act = await app.inject({
      method: 'POST',
      url: `/towns/${townId}/citizens/${scoutCitizenId}/action`,
      headers: bearer(scoutToken),
      payload: { type: 'move', to: 'town' },
    });
    expect(act.statusCode).toBe(409);
    expect((act.json() as { error: { code: string } }).error.code).toBe('rule-violation');

    // Le garde vivant, lui, n'est pas fantôme.
    const guardView = await app.inject({
      method: 'GET',
      url: `/towns/${townId}`,
      headers: bearer(guardToken),
    });
    const guardState = guardView.json() as TownState;
    expect(guardState.youAreGhost).toBe(false);
    expect(guardState.yourCitizenAlive).toBe(true);
    expect(guardState.yourEpitaph).toBeNull();

    // L'historique de profil de l'éclaireur porte l'épitaphe.
    const history = await app.inject({
      method: 'GET',
      url: '/auth/me/history',
      headers: bearer(scoutToken),
    });
    expect(history.statusCode).toBe(200);
    const entries = (history.json() as { history: Array<{ townId: string; epitaph: string | null; citizen: { alive: boolean } }> }).history;
    const entry = entries.find((e) => e.townId === townId)!;
    expect(entry.citizen.alive).toBe(false);
    expect(entry.epitaph).toBeTruthy();
    expect(entry.epitaph).toContain('Ci-gît');
  });
});
