/**
 * Tests dédiés à l'enrichissement de la mécanique de horde :
 *   - décomposition de la défense (murs / faction)
 *   - vagues d'attaque déterministes
 *   - catégorisation des décès par origine
 *   - rapport horodaté et somme des vagues = puissance de la horde
 */
import { describe, expect, it } from 'vitest';
import { Game } from '../src/domain/game.js';
import { DEFAULT_CONFIG, type GameConfig } from '../src/domain/config.js';

function makeConfig(overrides: Partial<GameConfig>): GameConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

describe('NightReport — défense composite', () => {
  it('décompose la défense en murs + faction', () => {
    const game = new Game(makeConfig({ baseDefense: 20, watchDefensePerCitizen: 3 }));
    game.addCitizen('Alia');
    game.addCitizen('Bjorn');
    const report = game.endDay();
    expect(report.defense.walls).toBe(20);
    expect(report.defense.watcherCount).toBe(2);
    expect(report.defense.watchers).toBe(6);
    expect(report.defense.total).toBe(26);
    expect(report.townDefense).toBe(report.defense.total);
  });

  it('ne compte pas les citoyens partis au désert comme guetteurs', () => {
    const game = new Game(makeConfig({ baseDefense: 10, watchDefensePerCitizen: 4 }));
    const a = game.addCitizen('Alia');
    const b = game.addCitizen('Bjorn');
    game.setLocation(b.id, 'desert');
    const report = game.endDay();
    // a (en ville) compte. b (désert) est mort puis ne compte pas.
    expect(report.defense.watcherCount).toBe(1);
    expect(report.defense.watchers).toBe(4);
    expect(report.deathsBySource.desert).toBe(1);
    // a survit (def 10 + 4 = 14 > horde par défaut 12).
    expect(report.deaths.some((d) => d.citizenId === a.id)).toBe(false);
  });
});

describe('NightReport — vagues d\'assaut', () => {
  it('décompose l\'attaque en 3 vagues dont la somme vaut hordePower', () => {
    const game = new Game(
      makeConfig({ hordeBaseAttack: 50, hordeGrowthPerDay: 0, hordeWaveWeights: [0.45, 0.35, 0.2] }),
    );
    game.addCitizen('Alia');
    const report = game.endDay();
    expect(report.waves).toHaveLength(3);
    const sum = report.waves.reduce((acc, w) => acc + w.attack, 0);
    expect(sum).toBe(report.hordePower);
    expect(report.waves[0]!.index).toBe(1);
    expect(report.waves[2]!.index).toBe(3);
  });

  it('marque les vagues qui débordent la défense', () => {
    const game = new Game(
      makeConfig({
        baseDefense: 10,
        hordeBaseAttack: 100,
        watchDefensePerCitizen: 0,
        hordeWaveWeights: [0.5, 0.3, 0.2],
      }),
    );
    game.addCitizen('Alia');
    game.addCitizen('Bjorn');
    game.addCitizen('Cyrus');
    game.addCitizen('Dora');
    game.addCitizen('Elias');
    const report = game.endDay();
    expect(report.breached).toBe(true);
    // Chaque vague (50/30/20) > défense (10) → toutes débordent.
    expect(report.waves.every((w) => w.overflow > 0)).toBe(true);
    expect(report.waves[0]!.absorbed).toBe(10);
  });

  it('aucune vague ne déborde si la défense écrase la horde', () => {
    const game = new Game(makeConfig({ baseDefense: 200, hordeBaseAttack: 12 }));
    game.addCitizen('Alia');
    const report = game.endDay();
    expect(report.breached).toBe(false);
    expect(report.overflow).toBe(0);
    expect(report.waves.every((w) => w.overflow === 0)).toBe(true);
  });
});

describe('NightReport — décès par origine', () => {
  it('classifie correctement désert / faction / percée / déshydratation', () => {
    // baseDefense=10, hordeBase=80, watchDefensePerCitizen=2, 5 en ville.
    // def total = 10 + 5*2 = 20. overflow = 60. victims = ceil(60/15) = 4.
    // maxWatchDeaths = min(5, ceil(4/2)=2) = 2 → 2 watch + 2 breach.
    const game = new Game(
      makeConfig({
        baseDefense: 10,
        hordeBaseAttack: 80,
        hordeGrowthPerDay: 0,
        watchDefensePerCitizen: 2,
        killThreshold: 15,
      }),
    );
    const desert = game.addCitizen('Doras');
    game.setLocation(desert.id, 'desert');
    game.addCitizen('Alia');
    game.addCitizen('Bjorn');
    game.addCitizen('Cyrus');
    game.addCitizen('Dora');
    game.addCitizen('Elias');
    const report = game.endDay();
    expect(report.deathsBySource.desert).toBe(1);
    expect(report.deathsBySource.watch).toBe(2);
    expect(report.deathsBySource.breach).toBe(2);
    expect(report.deathsBySource.dehydration).toBe(0);
    const total =
      report.deathsBySource.desert +
      report.deathsBySource.watch +
      report.deathsBySource.breach +
      report.deathsBySource.dehydration;
    expect(total).toBe(report.deaths.length);
  });

  it('marque source=dehydration pour les morts de soif à l\'aube', () => {
    const game = new Game(
      makeConfig({
        hordeBaseAttack: 0,
        hordeGrowthPerDay: 0,
        startingBank: { wood: 0, metal: 0, water: 0 },
      }),
    );
    game.addCitizen('Alia');
    game.endDay(); // nuit 1 — soif jour 1
    const report = game.endDay(); // nuit 2 — déshydratation fatale à l'aube
    expect(report.deathsBySource.dehydration).toBe(1);
    expect(report.deaths[0]!.source).toBe('dehydration');
    expect(report.gameOver).toBe(true);
  });
});

describe('NightReport — horodatage', () => {
  it('expose resolvedAt en ISO 8601 valide', () => {
    const game = new Game();
    game.addCitizen('Alia');
    const before = Date.now();
    const report = game.endDay();
    const t = Date.parse(report.resolvedAt);
    expect(Number.isFinite(t)).toBe(true);
    // Tolérance large : entre 1s avant le test et 5s après.
    expect(t).toBeGreaterThanOrEqual(before - 1000);
    expect(t).toBeLessThanOrEqual(Date.now() + 5000);
  });
});
