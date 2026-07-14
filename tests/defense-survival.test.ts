import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Id } from '../src/persistence/types.js';
import { bearer, makeTestApp, register } from './helpers/app.js';

/**
 * Jalon 3 — livrable « une ville test survit grâce à ses défenses ».
 *
 * Preuve de bout en bout à travers la pile réelle (API HTTP Fastify → store
 * en mémoire → résolveur de nuit), et non plus au seul niveau du moteur isolé.
 * Le scénario oppose deux villes identiques en difficulté `hard` :
 *
 *   • une ville TÉMOIN, sans aucune construction, tombe dès la première nuit ;
 *   • une ville FORTIFIÉE, qui érige un atelier de fortification + une
 *     barricade via l'API, repousse la même horde — et la nuit suivante, plus
 *     puissante — puis conserve ses défenses d'un jour à l'autre.
 *
 * Arithmétique (config `hard` = DEFAULT_CONFIG + hordeBaseAttack 12→16,
 * hordeGrowthPerDay 8→10) :
 *   - horde nuit 1 = 16 ; horde nuit 2 = 26 ;
 *   - défense de base = 10 murs + 1 guetteur × 2 = 12  → percée nuit 1 ;
 *   - atelier (+10 murs) + 1 barricade (+4 murs) = 24 murs + 2 guetteur = 26
 *     → absorbe 16 (nuit 1) puis 26 (nuit 2) sans déborder.
 */

interface DashResponse {
  id: string;
  day: number;
  phase: string;
  townDefense: number;
  bank: { wood: number; metal: number; water: number };
  yourCitizenId: string;
  closed: boolean;
}

interface NightResponse {
  report: {
    day: number;
    hordePower: number;
    survivors: number;
    breached: boolean;
    gameOver: boolean;
    outcome: 'ongoing' | 'victory' | 'defeat';
    defense: {
      walls: number;
      watchers: number;
      watcherCount: number;
      buildingsWallBonus: number;
      total: number;
    };
    deaths: Array<{ source: string }>;
  };
}

async function bootstrapTown(email: string, difficulty: 'normal' | 'hard' | 'hardcore') {
  const built = await makeTestApp();
  const reg = await register(built.app, email, 'password!1');
  const accessToken = reg.body.accessToken!;
  const created = await built.app.inject({
    method: 'POST',
    url: '/towns',
    headers: bearer(accessToken),
    payload: { name: 'Fort-Espoir', difficulty },
  });
  const town = created.json() as DashResponse;
  return { ...built, accessToken, townId: town.id, citizenId: town.yourCitizenId };
}

type Ctx = Awaited<ReturnType<typeof bootstrapTown>>;

function construct(ctx: Ctx, buildingId: string) {
  return ctx.app.inject({
    method: 'POST',
    url: `/towns/${ctx.townId}/citizens/${ctx.citizenId}/action`,
    headers: bearer(ctx.accessToken),
    payload: { type: 'construct', buildingId },
  });
}

function resolveNight(ctx: Ctx) {
  return ctx.app.inject({
    method: 'POST',
    url: `/towns/${ctx.townId}/night`,
    headers: bearer(ctx.accessToken),
  });
}

function dashboard(ctx: Ctx) {
  return ctx.app.inject({
    method: 'GET',
    url: `/towns/${ctx.townId}`,
    headers: bearer(ctx.accessToken),
  });
}

describe('Jalon 3 — une ville survit grâce à ses défenses (bout-en-bout)', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('témoin : sans construction, la horde perce et la ville tombe dès la première nuit', async () => {
    const ctx = await bootstrapTown('temoin@hordes.test', 'hard');
    app = ctx.app;

    const res = await resolveNight(ctx);
    expect(res.statusCode).toBe(200);
    const { report } = res.json() as NightResponse;

    // Horde 16 contre 10 murs + 1 guetteur × 2 = 12 → débordement, percée.
    expect(report.hordePower).toBe(16);
    expect(report.defense.total).toBe(12);
    expect(report.breached).toBe(true);
    expect(report.survivors).toBe(0);
    expect(report.gameOver).toBe(true);
    expect(report.outcome).toBe('defeat');

    // La partie est close : plus aucune nuit ne peut être relancée.
    const dash = dashboard(ctx);
    expect(((await dash).json() as DashResponse).closed).toBe(true);
  });

  it('fortifiée : atelier + barricade repoussent deux nuits d\'affilée et les défenses persistent', async () => {
    const ctx = await bootstrapTown('fort@hordes.test', 'hard');
    app = ctx.app;

    // ── Jour 1 : on érige les défenses depuis la banque commune ──────────────
    // Atelier de fortification : +10 murs (coût 12 bois / 8 métal, 3 PA).
    const workshop = await construct(ctx, 'workshop');
    expect(workshop.statusCode).toBe(200);
    const afterWorkshop = workshop.json() as {
      townDefense: number;
      buildings: Record<string, number>;
    };
    expect(afterWorkshop.buildings.workshop).toBe(1);
    // Murs = base 10 + atelier 10 = 20.
    expect(afterWorkshop.townDefense).toBe(20);

    // Barricade : +4 murs (coût 5 bois, 1 PA). Total murs = 24.
    const barricade = await construct(ctx, 'barricades');
    expect(barricade.statusCode).toBe(200);
    const afterBarricade = barricade.json() as { townDefense: number };
    expect(afterBarricade.townDefense).toBe(24);

    // ── Nuit 1 : horde 16 contre 24 murs + 2 guetteur = 26 → aucune percée ──
    const night1 = await resolveNight(ctx);
    expect(night1.statusCode).toBe(200);
    const r1 = (night1.json() as NightResponse).report;
    expect(r1.day).toBe(1);
    expect(r1.hordePower).toBe(16);
    expect(r1.defense.buildingsWallBonus).toBe(14); // atelier 10 + barricade 4
    expect(r1.defense.walls).toBe(24);
    expect(r1.defense.total).toBe(26);
    expect(r1.breached).toBe(false);
    expect(r1.survivors).toBe(1);
    expect(r1.gameOver).toBe(false);

    // Le jour a bien avancé et la ville n'est pas close.
    const midDash = (await dashboard(ctx)).json() as DashResponse;
    expect(midDash.day).toBe(2);
    expect(midDash.closed).toBe(false);

    // ── Persistance : rechargement du store → défenses toujours en place ────
    const reloaded = (await ctx.store.getTown(ctx.townId as unknown as Id))!;
    expect(reloaded.game.buildings()).toEqual({ workshop: 1, barricades: 1 });
    expect(reloaded.game.totalWallDefense()).toBe(24);

    // ── Nuit 2 : horde montée à 26, exactement absorbée par les mêmes murs ──
    const night2 = await resolveNight(ctx);
    expect(night2.statusCode).toBe(200);
    const r2 = (night2.json() as NightResponse).report;
    expect(r2.day).toBe(2);
    expect(r2.hordePower).toBe(26);
    expect(r2.defense.total).toBe(26);
    expect(r2.breached).toBe(false);
    expect(r2.survivors).toBe(1);
    expect(r2.gameOver).toBe(false);

    // Trois jours plus tard, la ville tient toujours grâce à ses constructions.
    const finalDash = (await dashboard(ctx)).json() as DashResponse;
    expect(finalDash.day).toBe(3);
    expect(finalDash.closed).toBe(false);
  });

  it('les défenses réduisent concrètement les pertes : même horde, une vie sauvée', async () => {
    // Deux villes hard, même première nuit (horde 16). Sans mur renforcé la
    // ville perd son unique habitant ; avec l'atelier, il survit. La preuve
    // que « les constructions réduisent les pertes lors des attaques ».
    const bare = await bootstrapTown('nue@hordes.test', 'hard');
    const fortified = await bootstrapTown('muraille@hordes.test', 'hard');
    app = bare.app; // fermé en afterEach ; on ferme l'autre explicitement.

    try {
      const w = await construct(fortified, 'workshop');
      expect(w.statusCode).toBe(200);

      const bareReport = (await resolveNight(bare)).json() as NightResponse;
      const fortReport = (await resolveNight(fortified)).json() as NightResponse;

      // Horde identique, issues opposées.
      expect(bareReport.report.hordePower).toBe(fortReport.report.hordePower);
      expect(bareReport.report.deaths.length).toBe(1);
      expect(bareReport.report.survivors).toBe(0);
      expect(fortReport.report.deaths.length).toBe(0);
      expect(fortReport.report.survivors).toBe(1);
    } finally {
      await fortified.app.close();
    }
  });
});
