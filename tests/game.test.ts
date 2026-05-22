import { describe, expect, it } from 'vitest';
import { Game, GameRuleError } from '../src/domain/game.js';
import { DEFAULT_CONFIG, type GameConfig } from '../src/domain/config.js';

/** Construit une config de partie en surchargeant la config par défaut. */
function makeConfig(overrides: Partial<GameConfig>): GameConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

/** Config sans horde : utile pour isoler des mécaniques (soif, ressources). */
const NO_HORDE = makeConfig({ hordeBaseAttack: 0, hordeGrowthPerDay: 0 });

describe('Game — état initial', () => {
  it('démarre au jour 1, phase jour, avec la défense et la banque de départ', () => {
    const game = new Game();
    const s = game.status();
    expect(s.day).toBe(1);
    expect(s.phase).toBe('day');
    expect(s.townDefense).toBe(DEFAULT_CONFIG.baseDefense);
    expect(s.bank).toEqual(DEFAULT_CONFIG.startingBank);
    expect(s.aliveCount).toBe(0);
    expect(s.gameOver).toBe(false);
  });

  it('crée un citoyen vivant, en ville, avec ses points d\'action', () => {
    const game = new Game();
    const c = game.addCitizen('Alia');
    expect(c.alive).toBe(true);
    expect(c.location).toBe('town');
    expect(c.actionPoints).toBe(DEFAULT_CONFIG.startingActionPoints);
    expect(game.aliveCount).toBe(1);
  });

  it('refuse un nom de citoyen vide', () => {
    const game = new Game();
    expect(() => game.addCitizen('   ')).toThrow(GameRuleError);
  });
});

describe('Game — construction', () => {
  it('dépense PA et ressources et renforce la défense', () => {
    const game = new Game();
    const c = game.addCitizen('Alia');
    game.build(c.id);
    const s = game.status();
    expect(s.townDefense).toBe(DEFAULT_CONFIG.baseDefense + DEFAULT_CONFIG.defensePerBuildAction);
    expect(s.bank.wood).toBe(DEFAULT_CONFIG.startingBank.wood - DEFAULT_CONFIG.buildResourceCost.wood);
    expect(s.bank.metal).toBe(
      DEFAULT_CONFIG.startingBank.metal - DEFAULT_CONFIG.buildResourceCost.metal,
    );
    expect(s.citizens[0]!.actionPoints).toBe(
      DEFAULT_CONFIG.startingActionPoints - DEFAULT_CONFIG.buildActionPointCost,
    );
  });

  it('refuse de construire sans ressources suffisantes', () => {
    const game = new Game(makeConfig({ startingBank: { wood: 1, metal: 0, water: 5 } }));
    const c = game.addCitizen('Alia');
    expect(() => game.build(c.id)).toThrow(/Ressources insuffisantes/);
  });

  it('refuse de construire depuis le désert', () => {
    const game = new Game();
    const c = game.addCitizen('Alia');
    game.setLocation(c.id, 'desert');
    expect(() => game.build(c.id)).toThrow(/présent en ville/);
  });

  it('refuse de construire sans points d\'action', () => {
    const game = new Game(makeConfig({ startingActionPoints: 2 }));
    const c = game.addCitizen('Alia');
    game.build(c.id);
    game.build(c.id);
    expect(() => game.build(c.id)).toThrow(/points d'action/);
  });
});

describe('Game — fouille du désert', () => {
  it('rapporte des ressources et dépense des PA', () => {
    const game = new Game();
    const c = game.addCitizen('Cyrus');
    game.setLocation(c.id, 'desert');
    game.scavenge(c.id);
    const s = game.status();
    expect(s.bank.wood).toBe(DEFAULT_CONFIG.startingBank.wood + DEFAULT_CONFIG.scavengeYield.wood);
    expect(s.bank.metal).toBe(
      DEFAULT_CONFIG.startingBank.metal + DEFAULT_CONFIG.scavengeYield.metal,
    );
    expect(s.bank.water).toBe(
      DEFAULT_CONFIG.startingBank.water + DEFAULT_CONFIG.scavengeYield.water,
    );
    expect(s.citizens[0]!.actionPoints).toBe(
      DEFAULT_CONFIG.startingActionPoints - DEFAULT_CONFIG.scavengeActionPointCost,
    );
  });

  it('refuse de fouiller depuis la ville', () => {
    const game = new Game();
    const c = game.addCitizen('Cyrus');
    expect(() => game.scavenge(c.id)).toThrow(/désert/);
  });
});

describe('Game — résolution de la nuit', () => {
  it('tue les citoyens restés dans le désert', () => {
    const game = new Game(NO_HORDE);
    const safe = game.addCitizen('Alia');
    const exposed = game.addCitizen('Cyrus');
    game.setLocation(exposed.id, 'desert');
    const report = game.endDay();
    expect(report.deaths).toHaveLength(1);
    expect(report.deaths[0]!.citizenId).toBe(exposed.id);
    expect(report.deaths[0]!.cause).toMatch(/désert/);
    expect(report.survivors).toBe(1);
    expect(game.status().citizens.find((c) => c.id === safe.id)!.alive).toBe(true);
  });

  it('ne perce pas la ville quand la défense dépasse la horde', () => {
    const game = new Game(makeConfig({ baseDefense: 100, hordeBaseAttack: 12 }));
    game.addCitizen('Alia');
    const report = game.endDay();
    expect(report.breached).toBe(false);
    expect(report.deaths).toHaveLength(0);
  });

  it('tue des citoyens abrités proportionnellement au débordement de la horde', () => {
    // horde 40 vs défense 10 → débordement 30 → ceil(30/15) = 2 victimes.
    const game = new Game(
      makeConfig({ baseDefense: 10, hordeBaseAttack: 40, killThreshold: 15 }),
    );
    game.addCitizen('Alia');
    game.addCitizen('Bjorn');
    game.addCitizen('Cyrus');
    const report = game.endDay();
    expect(report.breached).toBe(true);
    expect(report.deaths).toHaveLength(2);
    expect(report.survivors).toBe(1);
  });

  it('la puissance de la horde croît chaque jour', () => {
    const game = new Game(makeConfig({ hordeBaseAttack: 12, hordeGrowthPerDay: 8 }));
    expect(game.hordePower(1)).toBe(12);
    expect(game.hordePower(3)).toBe(12 + 8 * 2);
  });

  it('fait lever le jour suivant et recharge les points d\'action', () => {
    const game = new Game(NO_HORDE);
    const c = game.addCitizen('Alia');
    game.build(c.id);
    expect(game.status().citizens[0]!.actionPoints).toBeLessThan(
      DEFAULT_CONFIG.startingActionPoints,
    );
    game.endDay();
    expect(game.day).toBe(2);
    expect(game.phase).toBe('day');
    expect(game.status().citizens[0]!.actionPoints).toBe(DEFAULT_CONFIG.startingActionPoints);
  });
});

describe('Game — soif et déshydratation', () => {
  it('réduit les PA d\'un citoyen assoiffé puis le tue après deux jours sans eau', () => {
    const game = new Game(
      makeConfig({ ...NO_HORDE, startingBank: { wood: 0, metal: 0, water: 0 } }),
    );
    const c = game.addCitizen('Alia');

    game.endDay(); // nuit 1 -> aube du jour 2 : première journée de soif
    let live = game.status().citizens[0]!;
    expect(live.alive).toBe(true);
    expect(live.consecutiveThirstDays).toBe(1);
    expect(live.actionPoints).toBe(Math.floor(DEFAULT_CONFIG.startingActionPoints / 2));

    const report = game.endDay(); // nuit 2 -> aube du jour 3 : déshydratation fatale
    expect(report.deaths.some((d) => d.citizenId === c.id && /déshydratation/.test(d.cause))).toBe(
      true,
    );
    expect(report.gameOver).toBe(true);
  });

  it('consomme une eau par citoyen à l\'aube quand la banque en contient', () => {
    const game = new Game(makeConfig({ ...NO_HORDE, startingBank: { wood: 0, metal: 0, water: 5 } }));
    game.addCitizen('Alia');
    game.addCitizen('Bjorn');
    game.endDay();
    expect(game.status().bank.water).toBe(3);
  });
});

describe('Game — fin de partie', () => {
  it('termine la partie quand tous les citoyens sont morts', () => {
    const game = new Game(NO_HORDE);
    const c = game.addCitizen('Alia');
    game.setLocation(c.id, 'desert');
    const report = game.endDay();
    expect(report.gameOver).toBe(true);
    expect(game.gameOver).toBe(true);
  });

  it('refuse toute action une fois la partie terminée', () => {
    const game = new Game(NO_HORDE);
    const c = game.addCitizen('Alia');
    game.setLocation(c.id, 'desert');
    game.endDay();
    expect(() => game.build(c.id)).toThrow(/terminée/);
    expect(() => game.endDay()).toThrow(/terminée/);
  });
});

describe('Game — garde-fous sur les citoyens', () => {
  it('refuse d\'agir pour un citoyen introuvable', () => {
    const game = new Game();
    expect(() => game.build('inconnu')).toThrow(/introuvable/);
  });

  it('refuse d\'agir pour un citoyen mort', () => {
    const game = new Game(makeConfig({ baseDefense: 100 }));
    const dead = game.addCitizen('Alia');
    game.addCitizen('Bjorn'); // garde la partie en vie
    game.setLocation(dead.id, 'desert');
    game.endDay();
    expect(() => game.setLocation(dead.id, 'town')).toThrow(/mort/);
  });
});
