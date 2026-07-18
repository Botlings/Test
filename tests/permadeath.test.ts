/**
 * Mécanique de mort et de permadeath (core loop Hordes) :
 *   - la mort est définitive (déjà couverte ailleurs) ;
 *   - les ressources personnelles d'un citoyen tombé À L'ABRI (gourde) sont
 *     reversées à la banque commune ; un corps abandonné au désert emporte
 *     son eau ;
 *   - l'épitaphe résume narrativement une vie de survivant fauchée.
 */
import { describe, expect, it } from 'vitest';
import { Game } from '../src/domain/game.js';
import { DEFAULT_CONFIG, type GameConfig } from '../src/domain/config.js';
import { buildEpitaph } from '../src/domain/epitaph.js';

function makeConfig(overrides: Partial<GameConfig>): GameConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

describe('Permadeath — legs des ressources du défunt', () => {
  it('reverse la gourde d\'un citoyen tombé dans les murs à la banque commune', () => {
    // Ville sans défense face à une horde écrasante : le citoyen abrité tombe.
    const game = new Game(
      makeConfig({
        baseDefense: 0,
        watchDefensePerCitizen: 0,
        hordeBaseAttack: 100,
        startingBank: { wood: 0, metal: 0, water: 0 },
      }),
    );
    const c = game.addCitizen('Alia');
    const canteenBefore = game
      .status()
      .citizens.find((x) => x.id === c.id)!.waterCanteen;
    expect(canteenBefore).toBe(DEFAULT_CONFIG.desert.canteenCapacity);

    const report = game.endDay();

    // Le citoyen est mort à l'abri : sa gourde (pleine) part à la banque.
    expect(report.deaths.some((d) => d.citizenId === c.id)).toBe(true);
    expect(report.salvagedWater).toBe(canteenBefore);
    expect(game.status().bank.water).toBe(canteenBefore);
  });

  it('n\'hérite pas de la gourde d\'un mort abandonné dans le désert', () => {
    // Défense confortable : le citoyen resté en ville survit ; l'autre part au
    // désert et s'y fait dévorer — son eau est perdue avec lui.
    const game = new Game(
      makeConfig({
        baseDefense: 30,
        hordeBaseAttack: 12,
        hordeGrowthPerDay: 0,
        startingBank: { wood: 0, metal: 0, water: 0 },
      }),
    );
    game.addCitizen('Garde');
    const scout = game.addCitizen('Éclaireur');
    game.setLocation(scout.id, 'desert');

    const report = game.endDay();

    expect(report.deathsBySource.desert).toBe(1);
    expect(report.salvagedWater).toBe(0);
    expect(game.status().bank.water).toBe(0);
  });

  it('rapporte un legs nul quand aucun citoyen ne meurt', () => {
    const game = new Game(makeConfig({ baseDefense: 100, hordeBaseAttack: 12 }));
    game.addCitizen('Alia');
    const report = game.endDay();
    expect(report.deaths).toHaveLength(0);
    expect(report.salvagedWater).toBe(0);
  });
});

describe('Permadeath — épitaphe', () => {
  it('ne produit aucune épitaphe pour un survivant', () => {
    expect(
      buildEpitaph({ name: 'Alia', alive: true, causeOfDeath: null, daysSurvived: 4, outcome: 'ongoing' }),
    ).toBeNull();
  });

  it('compose une épitaphe nommée avec cause et nuits de veille', () => {
    const text = buildEpitaph({
      name: 'Bjorn',
      alive: false,
      causeOfDeath: 'tombé en faction sur les remparts',
      daysSurvived: 4,
      outcome: 'defeat',
    });
    expect(text).toContain('Ci-gît Bjorn');
    expect(text).toContain('tombé en faction sur les remparts');
    expect(text).toContain('3 nuits');
  });

  it('gère le tombé dès la première nuit (aucune nuit de veille)', () => {
    const text = buildEpitaph({
      name: 'Recrue',
      alive: false,
      causeOfDeath: 'dévoré dans le désert',
      daysSurvived: 1,
      outcome: 'defeat',
    });
    expect(text).toContain('sans avoir vu tomber la première nuit');
  });

  it('honore le martyr d\'une ville victorieuse', () => {
    const text = buildEpitaph({
      name: 'Héroïne',
      alive: false,
      causeOfDeath: 'tuée lors de la percée de la horde',
      daysSurvived: 7,
      outcome: 'victory',
    });
    expect(text).toContain('Sa ville a survécu.');
  });

  it('retombe sur des valeurs par défaut robustes', () => {
    const text = buildEpitaph({
      name: '   ',
      alive: false,
      causeOfDeath: null,
      daysSurvived: Number.NaN,
      outcome: 'ongoing',
    });
    expect(text).toContain('Un survivant anonyme');
    expect(text).toContain('emporté par la horde');
  });
});
