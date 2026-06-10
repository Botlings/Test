/**
 * Tests de la condition de fin de partie (Jalon 5) :
 *   - victoire : la ville survit `survivalDays` nuits.
 *   - défaite  : tous les citoyens meurent (horde ou déshydratation à l'aube).
 *   - `outcome` exposé dans `status()` et chaque `NightReport`.
 *   - sérialisation : `outcome` survit au snapshot, rétro-compat déduite.
 */
import { describe, expect, it } from 'vitest';
import { Game, GameRuleError, type GameSnapshot } from '../src/domain/game.js';
import { DEFAULT_CONFIG, type GameConfig } from '../src/domain/config.js';

function makeConfig(overrides: Partial<GameConfig>): GameConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

/** Config paisible : aucune horde, eau abondante (isole la fin de partie). */
function peaceful(survivalDays: number): GameConfig {
  return makeConfig({
    hordeBaseAttack: 0,
    hordeGrowthPerDay: 0,
    startingBank: { wood: 0, metal: 0, water: 50 },
    survivalDays,
  });
}

describe('Fin de partie — état initial et statut', () => {
  it('démarre avec outcome "ongoing" et expose survivalDays', () => {
    const game = new Game();
    const s = game.status();
    expect(s.outcome).toBe('ongoing');
    expect(s.survivalDays).toBe(DEFAULT_CONFIG.survivalDays);
    expect(game.outcome).toBe('ongoing');
  });
});

describe('Fin de partie — victoire', () => {
  it('déclare la victoire après avoir survécu au nombre de nuits requis', () => {
    const game = new Game(peaceful(3));
    game.addCitizen('Alia');

    const r1 = game.endDay();
    expect(r1.outcome).toBe('ongoing');
    expect(r1.gameOver).toBe(false);

    const r2 = game.endDay();
    expect(r2.outcome).toBe('ongoing');

    const r3 = game.endDay();
    expect(r3.outcome).toBe('victory');
    expect(r3.gameOver).toBe(true);
    expect(r3.day).toBe(3);
    expect(r3.survivors).toBeGreaterThan(0);
    expect(game.outcome).toBe('victory');
    expect(game.gameOver).toBe(true);
  });

  it('gagne dès la première nuit si survivalDays vaut 1', () => {
    const game = new Game(peaceful(1));
    game.addCitizen('Alia');
    const r = game.endDay();
    expect(r.outcome).toBe('victory');
    expect(r.day).toBe(1);
  });

  it('interdit toute action après la fin de partie', () => {
    const game = new Game(peaceful(1));
    const c = game.addCitizen('Alia');
    game.endDay();
    expect(() => game.endDay()).toThrow(GameRuleError);
    expect(() => game.build(c.id)).toThrow(GameRuleError);
  });
});

describe('Fin de partie — défaite', () => {
  it('déclare la défaite quand la horde anéantit la ville', () => {
    const game = new Game(
      makeConfig({
        hordeBaseAttack: 1000,
        hordeGrowthPerDay: 0,
        baseDefense: 0,
        watchDefensePerCitizen: 0,
        survivalDays: 5,
      }),
    );
    game.addCitizen('Alia');
    const r = game.endDay();
    expect(r.outcome).toBe('defeat');
    expect(r.gameOver).toBe(true);
    expect(r.survivors).toBe(0);
    expect(game.outcome).toBe('defeat');
  });

  it('déclare la défaite si l\'aube tue le dernier survivant (soif)', () => {
    const game = new Game(
      makeConfig({
        hordeBaseAttack: 0,
        hordeGrowthPerDay: 0,
        startingBank: { wood: 0, metal: 0, water: 0 },
        survivalDays: 10,
      }),
    );
    game.addCitizen('Alia');
    // Nuit 1 : pas de horde, l'aube laisse le citoyen assoiffé (1er jour).
    const r1 = game.endDay();
    expect(r1.outcome).toBe('ongoing');
    // Nuit 2 : second jour de soif → mort à l'aube → ville éteinte.
    const r2 = game.endDay();
    expect(r2.outcome).toBe('defeat');
    expect(r2.gameOver).toBe(true);
    expect(r2.survivors).toBe(0);
    expect(r2.deathsBySource.dehydration).toBeGreaterThan(0);
  });
});

describe('Fin de partie — sérialisation', () => {
  it('préserve outcome au travers d\'un snapshot', () => {
    const game = new Game(peaceful(1));
    game.addCitizen('Alia');
    game.endDay();
    expect(game.outcome).toBe('victory');

    const snap = game.snapshot();
    expect(snap.outcome).toBe('victory');

    const restored = Game.fromSnapshot(peaceful(1), snap);
    expect(restored.outcome).toBe('victory');
    expect(restored.gameOver).toBe(true);
  });

  it('déduit l\'issue d\'un snapshot ancien sans champ outcome', () => {
    const game = new Game(peaceful(1));
    game.addCitizen('Alia');
    game.endDay();
    const snap = game.snapshot();

    // Simule un snapshot écrit avant l'introduction de la victoire.
    const legacy: GameSnapshot = { ...snap };
    delete (legacy as { outcome?: unknown }).outcome;

    const restored = Game.fromSnapshot(peaceful(1), legacy);
    // gameOver=true + survivants → victoire déduite.
    expect(restored.outcome).toBe('victory');
  });
});
