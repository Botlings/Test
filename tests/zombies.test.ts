/**
 * Tests des zombies spéciaux de l'assaut nocturne (Contenu — Jalon 3) :
 *   - composition déterministe de la horde selon le jour ;
 *   - Colosse (`brute`)   : perfore la défense des murs ;
 *   - Hurleur (`screamer`): amplifie la puissance de la horde ;
 *   - Sournois (`sapper`) : pille la banque et sabote durablement la défense ;
 *   - bâtiments de riposte : pièges (déterrence) et infirmerie (victimes).
 *
 * Les zombies spéciaux n'apparaissent jamais avant le jour 3 : on démarre donc
 * les scénarios au bon jour via un snapshot dont on force le champ `day`.
 */
import { describe, expect, it } from 'vitest';
import { Game, type GameSnapshot } from '../src/domain/game.js';
import { DEFAULT_CONFIG, type GameConfig } from '../src/domain/config.js';
import {
  computeNightThreats,
  bruteWallPierce,
  prowlerWatchNegation,
  screamerHordeBonus,
  DEFAULT_ZOMBIE_CONFIG,
} from '../src/domain/zombies.js';
import type { ItemStock } from '../src/domain/items.js';

function makeConfig(overrides: Partial<GameConfig>): GameConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

/**
 * Prépare une partie positionnée au jour `day`, avec `citizens` citoyens en
 * ville et un stock d'objets optionnel. Passe par un snapshot pour éviter de
 * dérouler plusieurs nuits.
 */
function gameAtDay(
  config: GameConfig,
  day: number,
  citizens: number,
  items: ItemStock = {},
): Game {
  const seed = new Game(config, 999);
  for (let i = 0; i < citizens; i++) seed.addCitizen(`C${i}`);
  const snap: GameSnapshot = { ...seed.snapshot(), day, items };
  return Game.fromSnapshot(config, snap);
}

describe('computeNightThreats — composition déterministe', () => {
  it('aucune menace spéciale avant le jour 3', () => {
    expect(computeNightThreats(1, DEFAULT_ZOMBIE_CONFIG)).toEqual({ brute: 0, prowler: 0, sapper: 0, screamer: 0 });
    expect(computeNightThreats(2, DEFAULT_ZOMBIE_CONFIG)).toEqual({ brute: 0, prowler: 0, sapper: 0, screamer: 0 });
  });

  it('escalade attendue aux jours 3 à 7', () => {
    expect(computeNightThreats(3, DEFAULT_ZOMBIE_CONFIG)).toEqual({ brute: 1, prowler: 0, sapper: 0, screamer: 0 });
    expect(computeNightThreats(4, DEFAULT_ZOMBIE_CONFIG)).toEqual({ brute: 1, prowler: 0, sapper: 1, screamer: 0 });
    expect(computeNightThreats(5, DEFAULT_ZOMBIE_CONFIG)).toEqual({ brute: 1, prowler: 1, sapper: 1, screamer: 1 });
    expect(computeNightThreats(6, DEFAULT_ZOMBIE_CONFIG)).toEqual({ brute: 2, prowler: 1, sapper: 1, screamer: 1 });
    expect(computeNightThreats(7, DEFAULT_ZOMBIE_CONFIG)).toEqual({ brute: 2, prowler: 1, sapper: 2, screamer: 1 });
  });
});

describe('Fonctions d\'effet — bornes', () => {
  it('la perforation des colosses ne dépasse jamais la défense de mur', () => {
    expect(bruteWallPierce({ brute: 1, prowler: 0, sapper: 0, screamer: 0 }, DEFAULT_ZOMBIE_CONFIG, 100)).toBe(8);
    expect(bruteWallPierce({ brute: 5, prowler: 0, sapper: 0, screamer: 0 }, DEFAULT_ZOMBIE_CONFIG, 10)).toBe(10);
    expect(bruteWallPierce({ brute: 0, prowler: 0, sapper: 0, screamer: 0 }, DEFAULT_ZOMBIE_CONFIG, 10)).toBe(0);
  });

  it('l\'annulation de garde des rôdeurs ne dépasse jamais la défense de guetteurs', () => {
    // watchNegationPerZombie = 4.
    expect(prowlerWatchNegation({ brute: 0, prowler: 1, sapper: 0, screamer: 0 }, DEFAULT_ZOMBIE_CONFIG, 100)).toBe(4);
    expect(prowlerWatchNegation({ brute: 0, prowler: 5, sapper: 0, screamer: 0 }, DEFAULT_ZOMBIE_CONFIG, 6)).toBe(6);
    // Sans guetteur, aucun effet : les scénarios sans garde restent inchangés.
    expect(prowlerWatchNegation({ brute: 0, prowler: 3, sapper: 0, screamer: 0 }, DEFAULT_ZOMBIE_CONFIG, 0)).toBe(0);
  });

  it('l\'amplification des hurleurs est nulle quand la horde de base est nulle', () => {
    expect(screamerHordeBonus(0, { brute: 0, prowler: 0, sapper: 0, screamer: 3 }, DEFAULT_ZOMBIE_CONFIG)).toBe(0);
    // 100 × 0.2 × 2 = 40
    expect(screamerHordeBonus(100, { brute: 0, prowler: 0, sapper: 0, screamer: 2 }, DEFAULT_ZOMBIE_CONFIG)).toBe(40);
  });
});

describe('Colosse (brute) — perfore les murs la nuit', () => {
  it('une horde absorbée sans colosse perce dès que le colosse rogne la défense', () => {
    // Murs 10, horde 10 : sans colosse → aucun débordement.
    const config = makeConfig({
      baseDefense: 10,
      watchDefensePerCitizen: 0,
      hordeBaseAttack: 10,
      hordeGrowthPerDay: 0,
    });
    // Jour 3 : exactement 1 colosse (perce 8 → murs effectifs 2).
    const game = gameAtDay(config, 3, 1);
    const report = game.endDay();
    expect(report.threats.brute).toBe(1);
    expect(report.defense.walls).toBe(10);
    expect(report.defense.wallsPenetrated).toBe(8);
    expect(report.defense.total).toBe(2);
    expect(report.breached).toBe(true);
  });
});

describe('Rôdeur rapide (prowler) — annule une part de la garde', () => {
  it('rogne la défense des guetteurs et fait percer une horde autrement absorbée', () => {
    // Murs 0, chaque guetteur vaut 6 de défense, 2 guetteurs → 12. Horde 10 :
    // sans rôdeur, 12 ≥ 10 → aucune percée. Au jour 5, 1 rôdeur annule 4 de
    // garde → défense effective 8 < 10 → percée.
    const config = makeConfig({
      baseDefense: 0,
      watchDefensePerCitizen: 6,
      hordeBaseAttack: 10,
      hordeGrowthPerDay: 0,
      startingBank: { wood: 0, metal: 0, water: 0 },
    });
    const game = gameAtDay(config, 5, 2);
    const report = game.endDay();
    expect(report.threats.prowler).toBe(1);
    expect(report.defense.watchers).toBe(12);
    expect(report.defense.watchersNegated).toBe(4);
    expect(report.defense.total).toBe(8);
    expect(report.breached).toBe(true);
  });

  it('sans guetteur en faction, le rôdeur n\'a aucun effet', () => {
    const config = makeConfig({
      baseDefense: 5,
      watchDefensePerCitizen: 0,
      hordeBaseAttack: 0,
      hordeGrowthPerDay: 0,
      startingBank: { wood: 0, metal: 0, water: 0 },
    });
    const game = gameAtDay(config, 5, 1);
    const report = game.endDay();
    expect(report.threats.prowler).toBe(1);
    expect(report.defense.watchersNegated).toBe(0);
  });
});

describe('Hurleur (screamer) — amplifie la horde', () => {
  it('gonfle la puissance effective d\'un pourcentage de la horde de base', () => {
    // Défense nulle pour isoler l'effet sur la puissance ; banque vide (rien à
    // piller par le Sournois du jour 5).
    const config = makeConfig({
      baseDefense: 0,
      watchDefensePerCitizen: 0,
      hordeBaseAttack: 100,
      hordeGrowthPerDay: 0,
      startingBank: { wood: 0, metal: 0, water: 0 },
    });
    // Jour 5 : 1 hurleur → +20 (100 × 0.2).
    const game = gameAtDay(config, 5, 1);
    const report = game.endDay();
    expect(report.threats.screamer).toBe(1);
    expect(report.baseHordePower).toBe(100);
    expect(report.hordePower).toBe(120);
    const sum = report.waves.reduce((a, w) => a + w.attack, 0);
    expect(sum).toBe(report.hordePower);
  });
});

describe('Sournois (sapper) — pille et sabote', () => {
  it('dérobe des ressources et détruit durablement de la défense', () => {
    const config = makeConfig({
      baseDefense: 30,
      watchDefensePerCitizen: 0,
      hordeBaseAttack: 0, // isole le sabotage des décès de horde
      hordeGrowthPerDay: 0,
      startingBank: { wood: 5, metal: 10, water: 5 },
    });
    // Jour 4 : 1 Sournois (pille 3, sabote 3).
    const game = gameAtDay(config, 4, 1);
    const defenseBefore = game.status().townDefense;
    const report = game.endDay();
    expect(report.threats.sapper).toBe(1);
    expect(report.sabotage).not.toBeNull();
    expect(report.sabotage!.defenseLost).toBe(3);
    // Pillage prioritaire sur le métal.
    expect(report.sabotage!.looted.metal).toBe(3);
    // La défense a durablement chuté (visible dès l'aube du jour suivant).
    expect(game.status().townDefense).toBe(defenseBefore - 3);
    expect(game.status().bank.metal).toBe(7);
  });
});

describe('Bâtiments de riposte — pièges et infirmerie', () => {
  it('le champ de pièges retranche de la puissance de horde avant l\'assaut', () => {
    const config = makeConfig({
      startingActionPoints: 20,
      startingBank: { wood: 100, metal: 100, water: 8 },
      hordeBaseAttack: 20,
      hordeGrowthPerDay: 0,
      baseDefense: 0,
      watchDefensePerCitizen: 0,
    });
    // Jour 1 (aucune menace spéciale) + 1 champ de pièges (déterrence 6).
    const base = new Game(config);
    base.addCitizen('Alia');
    const snap: GameSnapshot = { ...base.snapshot(), items: { rope: 1, 'duct-tape': 1 } };
    const game = Game.fromSnapshot(config, snap);
    game.constructBuilding(game.status().citizens[0]!.id, 'trap-field');
    const report = game.endDay();
    expect(report.hordeDeterrence).toBe(6);
    expect(report.baseHordePower).toBe(20);
    expect(report.hordePower).toBe(14); // 20 − 6
  });

  it('l\'infirmerie épargne une victime lors d\'une percée', () => {
    const config = makeConfig({
      startingActionPoints: 20,
      startingBank: { wood: 100, metal: 100, water: 8 },
      baseDefense: 10,
      watchDefensePerCitizen: 0,
      hordeBaseAttack: 40, // overflow 30 → ceil(30/15) = 2 victimes brutes
      hordeGrowthPerDay: 0,
      killThreshold: 15,
    });
    // Sans infirmerie : 2 morts.
    const plain = new Game(config);
    plain.addCitizen('A');
    plain.addCitizen('B');
    plain.addCitizen('C');
    expect(plain.endDay().deaths).toHaveLength(2);

    // Avec 1 infirmerie (casualtyReduction 1) : 1 mort de moins.
    const base = new Game(config);
    base.addCitizen('A');
    base.addCitizen('B');
    base.addCitizen('C');
    const snap: GameSnapshot = { ...base.snapshot(), items: { toolbox: 1 } };
    const game = Game.fromSnapshot(config, snap);
    game.constructBuilding(game.status().citizens[0]!.id, 'infirmary');
    const report = game.endDay();
    expect(report.breached).toBe(true);
    expect(report.deaths).toHaveLength(1);
  });
});
