/**
 * Tests du classement global (Jalon 5) :
 *   - `MemoryStore.recordGameResult` + `listLeaderboard` : ordre canonique.
 *   - `GET /leaderboard` : endpoint public (sans auth), en-tête CORS, et
 *     apparition d'une partie terminée (défaite) dans le classement.
 */
import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/persistence/memory.js';
import type { Id } from '../src/persistence/types.js';
import { bearer, makeTestApp, register } from './helpers/app.js';

describe('MemoryStore — classement', () => {
  it('classe victoires avant défaites, puis par nuits survécues', async () => {
    const store = new MemoryStore();
    const a = await store.createTown('Victoire Tardive', 'normal');
    const b = await store.createTown('Victoire Précoce', 'hard');
    const c = await store.createTown('Brave Défaite', 'hardcore');
    const d = await store.createTown('Chute Rapide', 'normal');

    await store.recordGameResult(a.id, {
      outcome: 'victory',
      daysSurvived: 7,
      survivors: 3,
      population: 5,
      difficulty: 'normal',
    });
    await store.recordGameResult(b.id, {
      outcome: 'victory',
      daysSurvived: 7,
      survivors: 6,
      population: 8,
      difficulty: 'hard',
    });
    await store.recordGameResult(c.id, {
      outcome: 'defeat',
      daysSurvived: 9,
      survivors: 0,
      population: 4,
      difficulty: 'hardcore',
    });
    await store.recordGameResult(d.id, {
      outcome: 'defeat',
      daysSurvived: 2,
      survivors: 0,
      population: 4,
      difficulty: 'normal',
    });

    const board = await store.listLeaderboard();
    expect(board.map((e) => e.townName)).toEqual([
      'Victoire Précoce', // victoire, 7 nuits, 6 survivants
      'Victoire Tardive', // victoire, 7 nuits, 3 survivants
      'Brave Défaite', // défaite, 9 nuits
      'Chute Rapide', // défaite, 2 nuits
    ]);
    expect(board.map((e) => e.rank)).toEqual([1, 2, 3, 4]);
  });

  it('un second résultat pour la même ville écrase le précédent', async () => {
    const store = new MemoryStore();
    const town = await store.createTown('Aldebaran', 'normal');
    await store.recordGameResult(town.id, {
      outcome: 'defeat',
      daysSurvived: 1,
      survivors: 0,
      population: 1,
      difficulty: 'normal',
    });
    await store.recordGameResult(town.id, {
      outcome: 'victory',
      daysSurvived: 7,
      survivors: 1,
      population: 1,
      difficulty: 'normal',
    });
    const board = await store.listLeaderboard();
    expect(board).toHaveLength(1);
    expect(board[0]!.outcome).toBe('victory');
  });

  it('respecte la limite demandée', async () => {
    const store = new MemoryStore();
    for (let i = 0; i < 5; i++) {
      const t = await store.createTown(`Ville ${i + 1}`, 'normal');
      await store.recordGameResult(t.id, {
        outcome: 'defeat',
        daysSurvived: i,
        survivors: 0,
        population: 1,
        difficulty: 'normal',
      });
    }
    const board = await store.listLeaderboard(2);
    expect(board).toHaveLength(2);
  });
});

describe('GET /leaderboard', () => {
  it('est public (sans auth), renvoie un tableau vide et un en-tête CORS', async () => {
    const { app } = await makeTestApp();
    const res = await app.inject({ method: 'GET', url: '/leaderboard' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.json()).toEqual({ count: 0, entries: [] });
  });

  it('fait apparaître une partie perdue après la résolution de nuit', async () => {
    const { app } = await makeTestApp();
    const reg = await register(app, 'alia@hordes.test', 'password!1');
    const token = reg.body.accessToken!;
    const created = await app.inject({
      method: 'POST',
      url: '/towns',
      headers: bearer(token),
      payload: { name: 'Aldebaran', difficulty: 'normal' },
    });
    const town = created.json() as { id: Id; yourCitizenId: string };

    // Le citoyen s'aventure dans le désert : il y sera dévoré la nuit, et comme
    // il est seul, la ville tombe (défaite dès la nuit 1).
    await app.inject({
      method: 'POST',
      url: `/towns/${town.id}/citizens/${town.yourCitizenId}/action`,
      headers: bearer(token),
      payload: { type: 'move', to: 'desert' },
    });
    const night = await app.inject({
      method: 'POST',
      url: `/towns/${town.id}/night`,
      headers: bearer(token),
    });
    expect(night.statusCode).toBe(200);
    const report = (night.json() as { report: { outcome: string; gameOver: boolean } }).report;
    expect(report.outcome).toBe('defeat');
    expect(report.gameOver).toBe(true);

    const board = await app.inject({ method: 'GET', url: '/leaderboard' });
    const body = board.json() as {
      count: number;
      entries: Array<{ townName: string; outcome: string; survivors: number }>;
    };
    expect(body.count).toBe(1);
    expect(body.entries[0]!.townName).toBe('Aldebaran');
    expect(body.entries[0]!.outcome).toBe('defeat');
    expect(body.entries[0]!.survivors).toBe(0);
  });
});
