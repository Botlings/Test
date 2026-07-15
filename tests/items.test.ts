/**
 * Tests du système d'objets récupérables du désert (Contenu — Jalon 3) :
 *   - invariants du catalogue (10 objets, 3 familles) ;
 *   - normalisation d'un stock hydraté (`sanitizeItemStock`) ;
 *   - tirage pondéré par rareté / distance (`pickDroppableItem`) ;
 *   - drop effectif à la fouille et versement au stock de la ville ;
 *   - vivres consommés automatiquement à l'aube pour éviter la soif ;
 *   - objets exigés comme matériel de construction avancée.
 */
import { describe, expect, it } from 'vitest';
import { Game, type GameSnapshot } from '../src/domain/game.js';
import { DEFAULT_CONFIG, type GameConfig } from '../src/domain/config.js';
import {
  ITEM_CATALOG,
  getItemDef,
  isKnownItemId,
  sanitizeItemStock,
  stockCoversCost,
  pickDroppableItem,
  type ItemStock,
} from '../src/domain/items.js';

function makeConfig(overrides: Partial<GameConfig>): GameConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

/** Restaure une partie avec un stock d'objets injecté (helper de test). */
function withItems(config: GameConfig, game: Game, items: ItemStock): Game {
  const snap: GameSnapshot = { ...game.snapshot(), items };
  return Game.fromSnapshot(config, snap);
}

describe('Catalogue d\'objets — invariants statiques', () => {
  it('compte 20 objets aux ids uniques répartis en 3 familles', () => {
    expect(ITEM_CATALOG).toHaveLength(20);
    const ids = new Set<string>();
    const categories = new Set<string>();
    for (const it of ITEM_CATALOG) {
      expect(ids.has(it.id)).toBe(false);
      ids.add(it.id);
      categories.add(it.category);
      expect(it.dropWeight).toBeGreaterThan(0);
      expect(it.minDistance).toBeGreaterThanOrEqual(1);
      expect(it.name.length).toBeGreaterThan(0);
    }
    expect([...categories].sort()).toEqual(['food', 'material', 'tool']);
  });

  it('getItemDef / isKnownItemId reconnaissent les ids du catalogue', () => {
    expect(isKnownItemId('toolbox')).toBe(true);
    expect(isKnownItemId('steel-beam')).toBe(true);
    expect(isKnownItemId('licorne')).toBe(false);
    expect(getItemDef('canned-food')?.category).toBe('food');
    expect(getItemDef('inconnu')).toBeUndefined();
  });

  it('les vivres portent des rations, les non-comestibles n\'en portent pas', () => {
    for (const it of ITEM_CATALOG) {
      if (it.category === 'food') expect(it.rations).toBeGreaterThan(0);
      else expect(it.rations).toBe(0);
    }
  });
});

describe('sanitizeItemStock — normalisation', () => {
  it('tronque, purge les négatifs / nuls et les ids inconnus', () => {
    const cleaned = sanitizeItemStock({
      rope: 3.9, // tronqué à 3
      'steel-beam': 0, // dropé (nul)
      toolbox: -2, // dropé (négatif)
      licorne: 5, // dropé (id inconnu)
      'canned-food': 2,
    });
    expect(cleaned).toEqual({ rope: 3, 'canned-food': 2 });
  });

  it('renvoie un objet vide sur entrée non-objet', () => {
    expect(sanitizeItemStock(null)).toEqual({});
    expect(sanitizeItemStock(42)).toEqual({});
  });
});

describe('stockCoversCost — couverture d\'un coût', () => {
  it('vrai si le stock couvre chaque ligne, faux sinon, vrai si coût vide', () => {
    const stock: ItemStock = { 'steel-beam': 2, rope: 1 };
    expect(stockCoversCost(stock, { 'steel-beam': 2 })).toBe(true);
    expect(stockCoversCost(stock, { 'steel-beam': 3 })).toBe(false);
    expect(stockCoversCost(stock, { toolbox: 1 })).toBe(false);
    expect(stockCoversCost(stock, undefined)).toBe(true);
    expect(stockCoversCost({}, {})).toBe(true);
  });
});

describe('pickDroppableItem — pondération par distance', () => {
  it('n\'offre jamais un matériau rare (minDistance 3) aux abords (distance 1)', () => {
    // Balaie tout l'intervalle [0,1) : aucun objet minDistance>1 ne doit sortir.
    for (let r = 0; r < 1; r += 0.01) {
      const id = pickDroppableItem(1, r);
      const def = id ? getItemDef(id) : undefined;
      expect(def).toBeDefined();
      expect(def!.minDistance).toBeLessThanOrEqual(1);
    }
  });

  it('peut offrir un objet rare au fin fond du désert (distance 3)', () => {
    const seen = new Set<string>();
    for (let r = 0; r < 1; r += 0.005) {
      const id = pickDroppableItem(3, r);
      if (id) seen.add(id);
    }
    expect(seen.has('steel-beam') || seen.has('electronics')).toBe(true);
  });
});

describe('Game — drop d\'objets à la fouille', () => {
  it('verse un objet au stock de la ville quand le tirage réussit', () => {
    // itemDropChance = 1 (plafonné à 0.75) ; seed 1 → drop déterministe en (1,0).
    const game = new Game(makeConfig({ itemDropChance: 1 }), 1);
    const c = game.addCitizen('Alia');
    game.setLocation(c.id, 'desert'); // zone d'entrée (1,0) : distance 1, sans zombie
    const before = Object.values(game.items()).reduce((a, b) => a + b, 0);
    const res = game.scavengeZone(c.id);
    expect(res.foundItem).toBeDefined();
    const after = Object.values(game.items()).reduce((a, b) => a + b, 0);
    expect(after).toBe(before + 1);
    expect(game.items()[res.foundItem!]).toBeGreaterThanOrEqual(1);
  });

  it('ne fait rien tomber quand la chance est nulle', () => {
    const game = new Game(makeConfig({ itemDropChance: 0 }), 1);
    const c = game.addCitizen('Alia');
    game.setLocation(c.id, 'desert');
    const res = game.scavengeZone(c.id);
    expect(res.foundItem).toBeUndefined();
    expect(Object.keys(game.items())).toHaveLength(0);
  });
});

describe('Game — vivres consommés à l\'aube', () => {
  it('une ration remplace l\'eau manquante et évite la soif', () => {
    const config = makeConfig({
      hordeBaseAttack: 0,
      hordeGrowthPerDay: 0,
      startingBank: { wood: 0, metal: 0, water: 0 },
    });
    const base = new Game(config);
    base.addCitizen('Alia');
    // Banque à sec MAIS le garde-manger contient des conserves.
    const game = withItems(config, base, { 'canned-food': 3 });
    const report = game.endDay(); // aube du jour 2
    const c = game.status().citizens[0]!;
    expect(report.deathsBySource.dehydration).toBe(0);
    expect(c.alive).toBe(true);
    expect(c.consecutiveThirstDays).toBe(0); // nourri, pas assoiffé
    expect(c.actionPoints).toBe(config.startingActionPoints); // pleine forme
    // Une unité de conserve consommée (le reste préservé).
    expect(game.items()['canned-food']).toBe(2);
  });

  it('sans vivres ni eau, la soif progresse normalement', () => {
    const config = makeConfig({
      hordeBaseAttack: 0,
      hordeGrowthPerDay: 0,
      startingBank: { wood: 0, metal: 0, water: 0 },
    });
    const game = new Game(config);
    game.addCitizen('Alia');
    game.endDay();
    expect(game.status().citizens[0]!.consecutiveThirstDays).toBe(1);
  });
});

describe('Game — objets exigés par la construction avancée', () => {
  it('refuse un rempart sans les poutres d\'acier requises', () => {
    const config = makeConfig({
      startingActionPoints: 20,
      startingBank: { wood: 100, metal: 100, water: 8 },
    });
    const game = new Game(config);
    const c = game.addCitizen('Alia');
    expect(() => game.constructBuilding(c.id, 'rampart')).toThrow(/Objets manquants/);
  });

  it('érige le rempart quand les poutres sont en stock, et les consomme', () => {
    const config = makeConfig({
      startingActionPoints: 20,
      startingBank: { wood: 100, metal: 100, water: 8 },
    });
    const base = new Game(config);
    base.addCitizen('Alia');
    const game = withItems(config, base, { 'steel-beam': 2 });
    const c = game.status().citizens[0]!;
    const res = game.constructBuilding(c.id, 'rampart');
    expect(res.count).toBe(1);
    // rampart : wallDefense +25 sur la base.
    expect(res.townDefense).toBe(DEFAULT_CONFIG.baseDefense + 25);
    // Les 2 poutres ont été consommées.
    expect(game.items()['steel-beam']).toBeUndefined();
  });
});
