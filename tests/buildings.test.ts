import { describe, expect, it } from 'vitest';
import { Game } from '../src/domain/game.js';
import { DEFAULT_CONFIG, type GameConfig } from '../src/domain/config.js';
import {
  BUILDING_CATALOG,
  getBuildingDef,
  isKnownBuildingId,
  sanitizeBuildingState,
  totalWallDefenseFromBuildings,
  totalWatchBonusFromBuildings,
  totalWaterPerDawnFromBuildings,
  type BuildingState,
} from '../src/domain/buildings.js';

/** Construit une config de partie en surchargeant la config par défaut. */
function makeConfig(overrides: Partial<GameConfig>): GameConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

/** Config sans horde : isole les mécaniques (défense, eau) des décès. */
const NO_HORDE = makeConfig({ hordeBaseAttack: 0, hordeGrowthPerDay: 0 });

describe('Catalogue de bâtiments — invariants statiques', () => {
  it('chaque entrée a un id unique, un coût et un plafond positifs', () => {
    const ids = new Set<string>();
    for (const def of BUILDING_CATALOG) {
      expect(ids.has(def.id)).toBe(false);
      ids.add(def.id);
      expect(def.cost.wood).toBeGreaterThanOrEqual(0);
      expect(def.cost.metal).toBeGreaterThanOrEqual(0);
      expect(def.actionPointCost).toBeGreaterThan(0);
      expect(def.maxCount).toBeGreaterThanOrEqual(1);
    }
  });

  it('getBuildingDef / isKnownBuildingId reconnaissent les ids du catalogue', () => {
    expect(isKnownBuildingId('watchtower')).toBe(true);
    expect(isKnownBuildingId('workshop')).toBe(true);
    expect(isKnownBuildingId('well')).toBe(true);
    expect(isKnownBuildingId('barricades')).toBe(true);
    expect(isKnownBuildingId('teleporter')).toBe(false);
    expect(getBuildingDef('watchtower')?.name).toBe('Tour de guet');
    expect(getBuildingDef('inconnu')).toBeUndefined();
  });

  it('totalWall/Watch/Water agrègent les effets sur un état multi-bâtiments', () => {
    const state: BuildingState = { workshop: 1, barricades: 3, watchtower: 2, well: 2 };
    // workshop +10 mur, barricades 3×4 = 12 → 22
    expect(totalWallDefenseFromBuildings(state)).toBe(22);
    // 2 tours de guet × 2 = 4
    expect(totalWatchBonusFromBuildings(state)).toBe(4);
    // 2 puits × 2 = 4
    expect(totalWaterPerDawnFromBuildings(state)).toBe(4);
  });

  it('sanitizeBuildingState plafonne, tronque et purge les entrées invalides', () => {
    const cleaned = sanitizeBuildingState({
      barricades: 25, // au-dessus du plafond (20)
      watchtower: 2.9, // tronqué à 2
      workshop: 0, // dropé (compteur nul)
      well: -3, // dropé (négatif)
      teleporter: 99, // dropé (id inconnu)
    });
    expect(cleaned).toEqual({ barricades: 20, watchtower: 2 });
  });

  it('sanitizeBuildingState renvoie un objet vide sur entrée non-objet', () => {
    expect(sanitizeBuildingState(null)).toEqual({});
    expect(sanitizeBuildingState('nope')).toEqual({});
    expect(sanitizeBuildingState(42)).toEqual({});
  });
});

describe('Game — construction de bâtiments du catalogue', () => {
  it('érige une barricade : dépense PA + bois et renforce les murs', () => {
    const game = new Game(NO_HORDE);
    const c = game.addCitizen('Alia');
    const res = game.constructBuilding(c.id, 'barricades');
    // barricades : coût wood 5 / metal 0, AP 1, wallDefense +4
    expect(res.count).toBe(1);
    expect(res.townDefense).toBe(DEFAULT_CONFIG.baseDefense + 4);
    const s = game.status();
    expect(s.buildings).toEqual({ barricades: 1 });
    expect(s.townDefense).toBe(DEFAULT_CONFIG.baseDefense + 4);
    expect(s.bank.wood).toBe(DEFAULT_CONFIG.startingBank.wood - 5);
    expect(s.bank.metal).toBe(DEFAULT_CONFIG.startingBank.metal);
    expect(s.citizens[0]!.actionPoints).toBe(DEFAULT_CONFIG.startingActionPoints - 1);
  });

  it('l\'atelier durcit les remparts de +10 et reste unique (maxCount 1)', () => {
    const game = new Game(makeConfig({ startingActionPoints: 20 }));
    const c = game.addCitizen('Alia');
    const res = game.constructBuilding(c.id, 'workshop');
    expect(res.count).toBe(1);
    expect(res.townDefense).toBe(DEFAULT_CONFIG.baseDefense + 10);
    // workshop : coût wood 12 / metal 8
    expect(game.status().bank).toMatchObject({
      wood: DEFAULT_CONFIG.startingBank.wood - 12,
      metal: DEFAULT_CONFIG.startingBank.metal - 8,
    });
    // Deuxième atelier interdit : plafond atteint.
    expect(() => game.constructBuilding(c.id, 'workshop')).toThrow(/Limite atteinte/);
  });

  it('empile les barricades jusqu\'au plafond puis refuse au-delà', () => {
    const game = new Game(makeConfig({
      startingActionPoints: 100,
      startingBank: { wood: 1000, metal: 0, water: 8 },
    }));
    const c = game.addCitizen('Alia');
    for (let i = 1; i <= 20; i++) {
      expect(game.constructBuilding(c.id, 'barricades').count).toBe(i);
    }
    expect(game.buildings().barricades).toBe(20);
    expect(() => game.constructBuilding(c.id, 'barricades')).toThrow(/Limite atteinte/);
  });

  it('refuse un identifiant de bâtiment inconnu', () => {
    const game = new Game(NO_HORDE);
    const c = game.addCitizen('Alia');
    expect(() => game.constructBuilding(c.id, 'teleporter')).toThrow(/inconnu/);
  });

  it('refuse de bâtir depuis le désert', () => {
    const game = new Game(NO_HORDE);
    const c = game.addCitizen('Alia');
    game.setLocation(c.id, 'desert');
    expect(() => game.constructBuilding(c.id, 'barricades')).toThrow(/présent en ville/);
  });

  it('refuse sans ressources suffisantes, sans consommer de PA', () => {
    const game = new Game(makeConfig({ startingBank: { wood: 2, metal: 0, water: 8 } }));
    const c = game.addCitizen('Alia');
    const apBefore = game.status().citizens[0]!.actionPoints;
    expect(() => game.constructBuilding(c.id, 'barricades')).toThrow(/insuffisantes/);
    // Échec atomique : ni PA ni ressources entamés.
    expect(game.status().citizens[0]!.actionPoints).toBe(apBefore);
    expect(game.status().bank.wood).toBe(2);
    expect(game.buildings()).toEqual({});
  });

  it('refuse sans points d\'action suffisants', () => {
    const game = new Game(makeConfig({ startingActionPoints: 2 }));
    const c = game.addCitizen('Alia');
    // workshop coûte 3 PA, le citoyen n'en a que 2.
    expect(() => game.constructBuilding(c.id, 'workshop')).toThrow(/points d'action/);
  });
});

describe('Game — bonus des bâtiments dans la résolution de nuit', () => {
  it('le bonus de mur d\'un atelier absorbe la horde et évite la percée', () => {
    // baseDefense 10 + atelier 10 = 20 ≥ horde 18 → aucun débordement.
    const game = new Game(makeConfig({
      baseDefense: 10,
      watchDefensePerCitizen: 0,
      hordeBaseAttack: 18,
      hordeGrowthPerDay: 0,
    }));
    const c = game.addCitizen('Alia');
    game.constructBuilding(c.id, 'workshop');
    const report = game.endDay();
    expect(report.defense.buildingsWallBonus).toBe(10);
    expect(report.defense.walls).toBe(20);
    expect(report.breached).toBe(false);
    expect(report.survivors).toBe(1);
    expect(game.status().citizens[0]!.alive).toBe(true);
  });

  it('sans le bonus de mur, la même horde perce et tue un habitant', () => {
    const game = new Game(makeConfig({
      baseDefense: 10,
      watchDefensePerCitizen: 0,
      hordeBaseAttack: 18,
      hordeGrowthPerDay: 0,
    }));
    game.addCitizen('Alia');
    const report = game.endDay();
    expect(report.breached).toBe(true);
    expect(report.survivors).toBe(0);
  });

  it('la tour de guet ajoute un bonus de défense par guetteur la nuit', () => {
    const game = new Game(makeConfig({
      watchDefensePerCitizen: 0,
      hordeBaseAttack: 0,
      hordeGrowthPerDay: 0,
    }));
    const a = game.addCitizen('Alia');
    game.addCitizen('Bo');
    game.constructBuilding(a.id, 'watchtower'); // watchBonusPerCitizen +2
    const report = game.endDay();
    expect(report.defense.watcherCount).toBe(2);
    expect(report.defense.buildingsWatchBonus).toBe(2);
    // 2 guetteurs × (0 base + 2 bonus tour) = 4
    expect(report.defense.watchers).toBe(4);
    expect(report.defense.walls).toBe(DEFAULT_CONFIG.baseDefense);
  });
});

describe('Game — production d\'eau passive des puits', () => {
  it('un puits ajoute 2 unités d\'eau à la banque chaque aube, avant la soif', () => {
    const game = new Game(NO_HORDE);
    const c = game.addCitizen('Alia');
    game.constructBuilding(c.id, 'well'); // waterPerDawn +2
    const waterBeforeNight = game.status().bank.water;
    game.endDay();
    // Aube : +2 (puits) puis -1 (le citoyen boit) = +1 net.
    expect(game.status().bank.water).toBe(waterBeforeNight + 2 - 1);
  });

  it('sans puits, la banque perd seulement l\'eau bue à l\'aube', () => {
    const game = new Game(NO_HORDE);
    game.addCitizen('Alia');
    const before = game.status().bank.water;
    game.endDay();
    expect(game.status().bank.water).toBe(before - 1);
  });
});

describe('Game — persistance des bâtiments (snapshot)', () => {
  it('un snapshot rechargé conserve les compteurs et la défense des bâtiments', () => {
    const cfg = makeConfig({ startingActionPoints: 20, startingBank: { wood: 100, metal: 50, water: 8 } });
    const game = new Game(cfg);
    const c = game.addCitizen('Alia');
    game.constructBuilding(c.id, 'workshop');
    game.constructBuilding(c.id, 'barricades');
    game.constructBuilding(c.id, 'barricades');
    const snap = game.snapshot();
    expect(snap.buildings).toEqual({ workshop: 1, barricades: 2 });

    const restored = Game.fromSnapshot(cfg, snap);
    expect(restored.buildings()).toEqual({ workshop: 1, barricades: 2 });
    // murs = base 10 + atelier 10 + 2 barricades × 4 = 28
    expect(restored.totalWallDefense()).toBe(DEFAULT_CONFIG.baseDefense + 10 + 8);
  });

  it('hydrate proprement un snapshot sans champ buildings (rétro-compat)', () => {
    const game = new Game(NO_HORDE);
    game.addCitizen('Alia');
    const snap = { ...game.snapshot() };
    delete (snap as { buildings?: unknown }).buildings;
    const restored = Game.fromSnapshot(NO_HORDE, snap);
    expect(restored.buildings()).toEqual({});
    expect(restored.totalWallDefense()).toBe(DEFAULT_CONFIG.baseDefense);
  });
});
