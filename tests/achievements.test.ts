/**
 * Système de hauts faits (achievements) et profil public (Jalon 6) :
 *   - évaluateurs purs du domaine (`domain/achievements.ts`),
 *   - persistance idempotente (`MemoryStore`),
 *   - endpoints : catalogue public, profil authentifié, profil public,
 *   - intégration : déblocage réel via les actions de jeu.
 */
import { describe, expect, it } from 'vitest';
import {
  ACHIEVEMENT_CATALOG,
  buildAchievements,
  getAchievementDef,
  isKnownAchievementId,
  nightAchievements,
  scavengeAchievements,
} from '../src/domain/achievements.js';
import { MemoryStore } from '../src/persistence/memory.js';
import type { Id } from '../src/persistence/types.js';
import type { NightReport } from '../src/domain/types.js';
import { awardNightAchievements } from '../src/server/achievements.js';
import { bearer, makeTestApp, register } from './helpers/app.js';

/* --------------------------- Domaine (pur) ------------------------------- */

describe('domain/achievements — catalogue', () => {
  it('expose les 5 badges attendus avec des ids stables', () => {
    expect(ACHIEVEMENT_CATALOG.map((a) => a.id)).toEqual([
      'first-builder',
      'explorer',
      'night-hero',
      'survivor-7',
      'victor',
    ]);
  });

  it('getAchievementDef et isKnownAchievementId reconnaissent le catalogue', () => {
    expect(getAchievementDef('night-hero')?.name).toBe('Héros Nocturne');
    expect(getAchievementDef('inconnu')).toBeUndefined();
    expect(isKnownAchievementId('survivor-7')).toBe(true);
    expect(isKnownAchievementId('nope')).toBe(false);
  });
});

describe('domain/achievements — évaluateurs', () => {
  it('buildAchievements débloque toujours Premier Bâtisseur', () => {
    expect(buildAchievements()).toEqual(['first-builder']);
  });

  it('scavengeAchievements débloque Pilleur du Désert dès un gain', () => {
    expect(scavengeAchievements({ resource: true })).toEqual(['explorer']);
    expect(scavengeAchievements({ item: true })).toEqual(['explorer']);
    expect(scavengeAchievements({ event: true })).toEqual(['explorer']);
    expect(scavengeAchievements({})).toEqual([]);
  });

  it('nightAchievements : Héros Nocturne si assaut repoussé et citoyen vivant', () => {
    expect(
      nightAchievements({
        nightDay: 1,
        hordePower: 12,
        breached: false,
        outcome: 'ongoing',
        citizenAlive: true,
      }),
    ).toEqual(['night-hero']);
  });

  it('nightAchievements : rien si le citoyen est mort', () => {
    expect(
      nightAchievements({
        nightDay: 9,
        hordePower: 30,
        breached: false,
        outcome: 'victory',
        citizenAlive: false,
      }),
    ).toEqual([]);
  });

  it('nightAchievements : pas de Héros Nocturne si les murs cèdent', () => {
    expect(
      nightAchievements({
        nightDay: 2,
        hordePower: 40,
        breached: true,
        outcome: 'ongoing',
        citizenAlive: true,
      }),
    ).toEqual([]);
  });

  it('nightAchievements : Survivant 7 jours et Sauveur à la nuit de victoire', () => {
    expect(
      nightAchievements({
        nightDay: 7,
        hordePower: 60,
        breached: false,
        outcome: 'victory',
        citizenAlive: true,
      }),
    ).toEqual(['night-hero', 'survivor-7', 'victor']);
  });

  it('nightAchievements : pas de Héros Nocturne si la horde n\'a pas frappé', () => {
    expect(
      nightAchievements({
        nightDay: 7,
        hordePower: 0,
        breached: false,
        outcome: 'victory',
        citizenAlive: true,
      }),
    ).toEqual(['survivor-7', 'victor']);
  });
});

/* --------------------------- MemoryStore --------------------------------- */

describe('MemoryStore — hauts faits', () => {
  it('débloque une seule fois (idempotent) et liste par ordre de déblocage', async () => {
    const store = new MemoryStore();
    const acc = await store.createAccount('a@hordes.test', 'hash');
    expect(await store.unlockAchievement(acc.id, 'first-builder')).toBe(true);
    expect(await store.unlockAchievement(acc.id, 'first-builder')).toBe(false);
    expect(await store.unlockAchievement(acc.id, 'night-hero')).toBe(true);
    const list = await store.listAccountAchievements(acc.id);
    expect(list.map((u) => u.achievementId)).toEqual(['first-builder', 'night-hero']);
    expect(list[0]!.unlockedAt).toBeInstanceOf(Date);
  });

  it('isole les badges entre comptes', async () => {
    const store = new MemoryStore();
    const a = await store.createAccount('a@hordes.test', 'hash');
    const b = await store.createAccount('b@hordes.test', 'hash');
    await store.unlockAchievement(a.id, 'victor');
    expect(await store.listAccountAchievements(b.id)).toEqual([]);
    expect((await store.listAccountAchievements(a.id)).map((u) => u.achievementId)).toEqual([
      'victor',
    ]);
  });
});

/* ----------------------- Endpoints publics ------------------------------- */

describe('GET /achievements/catalog', () => {
  it('est public, renvoie le catalogue et un en-tête CORS', async () => {
    const { app } = await makeTestApp();
    const res = await app.inject({ method: 'GET', url: '/achievements/catalog' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    const body = res.json() as { achievements: Array<{ id: string; name: string; icon: string }> };
    expect(body.achievements).toHaveLength(5);
    expect(body.achievements[0]).toMatchObject({ id: 'first-builder', icon: '🔨' });
    await app.close();
  });
});

describe('GET /players/:id', () => {
  it('renvoie 400 si l\'identifiant n\'est pas un UUID', async () => {
    const { app } = await makeTestApp();
    const res = await app.inject({ method: 'GET', url: '/players/pas-un-uuid' });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('renvoie 404 pour un compte inexistant (UUID bien formé)', async () => {
    const { app } = await makeTestApp();
    const res = await app.inject({
      method: 'GET',
      url: '/players/00000000-0000-4000-8000-000000000000',
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('expose un profil public anonymisé (sans email) avec catalogue complet', async () => {
    const { app } = await makeTestApp();
    const reg = await register(app, 'Alice@Hordes.test', 'password!1');
    const res = await app.inject({
      method: 'GET',
      url: `/players/${reg.body.userId}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    const body = res.json() as {
      userId: string;
      displayName: string;
      email?: string;
      memberSince: string;
      stats: { totalGames: number; victories: number };
      achievements: Array<{ id: string; unlocked: boolean }>;
      history: unknown[];
    };
    expect(body.userId).toBe(reg.body.userId);
    expect(body.displayName).toBe('alice');
    expect(body.email).toBeUndefined();
    expect(body.memberSince).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(body.stats.totalGames).toBe(0);
    expect(body.achievements).toHaveLength(5);
    expect(body.achievements.every((a) => a.unlocked === false)).toBe(true);
    expect(body.history).toEqual([]);
    await app.close();
  });
});

/* ---------------------- Profil authentifié ------------------------------- */

describe('GET /auth/me/achievements', () => {
  it('exige un token', async () => {
    const { app } = await makeTestApp();
    const res = await app.inject({ method: 'GET', url: '/auth/me/achievements' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('renvoie le catalogue verrouillé pour un compte neuf', async () => {
    const { app } = await makeTestApp();
    const reg = await register(app, 'neuf@hordes.test', 'password!1');
    const res = await app.inject({
      method: 'GET',
      url: '/auth/me/achievements',
      headers: bearer(reg.body.accessToken!),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      achievements: Array<{ id: string; unlocked: boolean }>;
      unlockedCount: number;
      total: number;
    };
    expect(body.total).toBe(5);
    expect(body.unlockedCount).toBe(0);
    await app.close();
  });
});

/* --------------------------- Intégration --------------------------------- */

describe('Déblocage via les actions de jeu', () => {
  it('la construction débloque « Premier Bâtisseur » et la survie de la 1re nuit « Héros Nocturne »', async () => {
    const { app, store } = await makeTestApp();
    const reg = await register(app, 'bob@hordes.test', 'password!1');
    const token = reg.body.accessToken!;
    const accountId = reg.body.userId as Id;

    const created = await app.inject({
      method: 'POST',
      url: '/towns',
      headers: bearer(token),
      payload: { name: 'Bastion-Sable', difficulty: 'normal' },
    });
    expect(created.statusCode).toBe(201);
    const town = created.json() as { id: string; yourCitizenId: string };

    // Construction générique : renforce les murs et débloque le premier badge.
    const build = await app.inject({
      method: 'POST',
      url: `/towns/${town.id}/citizens/${town.yourCitizenId}/action`,
      headers: bearer(token),
      payload: { type: 'build' },
    });
    expect(build.statusCode).toBe(200);
    let unlocked = (await store.listAccountAchievements(accountId)).map((u) => u.achievementId);
    expect(unlocked).toContain('first-builder');

    // Le citoyen reste en ville : sur normal, la défense tient la 1re nuit.
    const night = await app.inject({
      method: 'POST',
      url: `/towns/${town.id}/night`,
      headers: bearer(token),
    });
    expect(night.statusCode).toBe(200);
    const report = (night.json() as { report: { breached: boolean; gameOver: boolean } }).report;
    expect(report.breached).toBe(false);
    expect(report.gameOver).toBe(false);

    unlocked = (await store.listAccountAchievements(accountId)).map((u) => u.achievementId);
    expect(unlocked).toContain('night-hero');

    // Le profil authentifié reflète les badges débloqués.
    const me = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: bearer(token),
    });
    const meBody = me.json() as {
      achievementCount: number;
      achievements: Array<{ id: string; unlocked: boolean }>;
    };
    expect(meBody.achievementCount).toBeGreaterThanOrEqual(2);
    const builder = meBody.achievements.find((a) => a.id === 'first-builder');
    expect(builder?.unlocked).toBe(true);
    await app.close();
  });

  it('awardNightAchievements débloque Sauveur/Survivant/Héros pour un survivant d\'une nuit de victoire', async () => {
    const store = new MemoryStore();
    const account = await store.createAccount('championne@hordes.test', 'hash');
    const town = await store.createTown('Citadelle-Or', 'normal');
    await store.joinTown(town.id, account.id, 'championne');

    // Nuit de victoire (jour 7) repoussée sans percée : le citoyen vivant
    // décroche les trois badges de nuit.
    const report = {
      day: 7,
      hordePower: 55,
      breached: false,
      outcome: 'victory',
    } as unknown as NightReport;
    await awardNightAchievements(store, town, report);

    const unlocked = (await store.listAccountAchievements(account.id)).map((u) => u.achievementId);
    expect(unlocked).toContain('victor');
    expect(unlocked).toContain('survivor-7');
    expect(unlocked).toContain('night-hero');
  });
});
