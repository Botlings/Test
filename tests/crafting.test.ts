/**
 * Système de crafting / transformation d'objets à l'établi (forge).
 *
 * Couvre :
 *   - les invariants statiques du catalogue (15 recettes, ids uniques, forge
 *     requise) et les DEUX garde-fous anti-exploit :
 *       1. aucune recette ne produit de ressource brute (puits, pas pompe) ;
 *       2. les recettes de vivres sont neutres en rations ;
 *   - le contrôle de faisabilité pur (`recipeBlocker`) ;
 *   - la fabrication effective par le moteur (`Game.craft`) : gate forge,
 *     dépense atomique PA + banque + stock, versement des objets produits.
 */
import { describe, expect, it } from 'vitest';
import { Game, type GameSnapshot } from '../src/domain/game.js';
import { DEFAULT_CONFIG, type GameConfig } from '../src/domain/config.js';
import {
  RECIPE_CATALOG,
  CRAFTING_BUILDING,
  getRecipeDef,
  isKnownRecipeId,
  recipeBlocker,
  totalRations,
} from '../src/domain/crafting.js';
import { getItemDef, type ItemId, type ItemStock } from '../src/domain/items.js';
import type { BuildingState } from '../src/domain/buildings.js';

function makeConfig(overrides: Partial<GameConfig>): GameConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

/** Rations couvertes par un objet (0 pour les non-comestibles). */
const rationsOf = (id: ItemId): number => getItemDef(id)?.rations ?? 0;

/**
 * Restaure une partie avec un stock d'objets et des bâtiments injectés
 * (l'établi n'est accessible que si la forge figure dans `buildings`).
 */
function restore(
  config: GameConfig,
  game: Game,
  patch: { items?: ItemStock; buildings?: BuildingState },
): Game {
  const snap: GameSnapshot = {
    ...game.snapshot(),
    ...(patch.items ? { items: patch.items } : {}),
    ...(patch.buildings ? { buildings: patch.buildings as Record<string, number> } : {}),
  };
  return Game.fromSnapshot(config, snap);
}

/** Config confortable : PA et banque abondants pour isoler la logique. */
const RICH = makeConfig({
  startingActionPoints: 40,
  startingBank: { wood: 200, metal: 200, water: 200 },
  hordeBaseAttack: 0,
  hordeGrowthPerDay: 0,
});

describe('Catalogue de recettes — invariants statiques', () => {
  it('compte 15 recettes aux ids uniques, toutes adossées à la forge', () => {
    expect(RECIPE_CATALOG).toHaveLength(15);
    const ids = new Set<string>();
    for (const r of RECIPE_CATALOG) {
      expect(ids.has(r.id)).toBe(false);
      ids.add(r.id);
      expect(r.actionPointCost).toBeGreaterThan(0);
      expect(r.requiresBuilding).toBe(CRAFTING_BUILDING);
      expect(r.name.length).toBeGreaterThan(0);
      // Toute recette produit au moins un objet…
      const outCount = Object.values(r.outputs.items).reduce((a, b) => a + (b ?? 0), 0);
      expect(outCount).toBeGreaterThan(0);
      // …et consomme au moins une ressource OU un objet (jamais gratuite).
      const inRes = (r.inputs.resources.wood ?? 0) + (r.inputs.resources.metal ?? 0) + (r.inputs.resources.water ?? 0);
      const inItems = Object.values(r.inputs.items).reduce((a, b) => a + (b ?? 0), 0);
      expect(inRes + inItems).toBeGreaterThan(0);
    }
  });

  it('INVARIANT 1 — aucune recette ne génère de ressource brute (puits, pas pompe)', () => {
    // Les outputs sont typés « items uniquement » : ce test verrouille qu'aucune
    // future recette ne détourne le rendement pour rendre bois/métal/eau.
    for (const r of RECIPE_CATALOG) {
      expect(Object.prototype.hasOwnProperty.call(r.outputs, 'resources')).toBe(false);
    }
  });

  it('INVARIANT 2 — les recettes de vivres sont neutres en rations', () => {
    const foodRecipes = RECIPE_CATALOG.filter((r) => r.group === 'food');
    expect(foodRecipes.length).toBeGreaterThan(0);
    for (const r of foodRecipes) {
      const inRations = totalRations(r.inputs.items, rationsOf);
      const outRations = totalRations(r.outputs.items, rationsOf);
      expect(outRations).toBe(inRations);
      // Sanity : une recette de vivres brasse effectivement des rations.
      expect(outRations).toBeGreaterThan(0);
    }
  });

  it('getRecipeDef / isKnownRecipeId reconnaissent les ids du catalogue', () => {
    expect(isKnownRecipeId('craft-steel-beam')).toBe(true);
    expect(isKnownRecipeId('craft-energy-bar')).toBe(true);
    expect(isKnownRecipeId('craft-unicorn')).toBe(false);
    expect(getRecipeDef('craft-rope')?.name).toBe('Corde tressée');
    expect(getRecipeDef('inconnu')).toBeUndefined();
  });
});

describe('recipeBlocker — contrôle de faisabilité pur', () => {
  const steel = getRecipeDef('craft-steel-beam')!; // 14 métal → 1 poutre
  const wire = getRecipeDef('craft-copper-wire')!; // 1 câble → 2 fils

  it('bloque sans forge', () => {
    const b = recipeBlocker(steel, { wood: 0, metal: 100, water: 0 }, {}, 0);
    expect(b).toEqual({ kind: 'no-forge' });
  });

  it('bloque sur une ressource manquante', () => {
    const b = recipeBlocker(steel, { wood: 0, metal: 13, water: 0 }, {}, 1);
    expect(b).toEqual({ kind: 'resources', resource: 'metal' });
  });

  it('bloque sur un objet manquant', () => {
    const b = recipeBlocker(wire, { wood: 0, metal: 0, water: 0 }, {}, 1);
    expect(b).toEqual({ kind: 'items', item: 'cable' });
  });

  it('renvoie null quand tout est réuni', () => {
    expect(recipeBlocker(steel, { wood: 0, metal: 14, water: 0 }, {}, 1)).toBeNull();
    expect(recipeBlocker(wire, { wood: 0, metal: 0, water: 0 }, { cable: 1 }, 1)).toBeNull();
  });
});

describe('Game.craft — fabrication à l\'établi', () => {
  it('refuse tant que la forge n\'est pas érigée', () => {
    const game = new Game(RICH);
    const c = game.addCitizen('Alia');
    expect(() => game.craft(c.id, 'craft-steel-beam')).toThrow(/forge/i);
  });

  it('forge une poutre d\'acier : dépense 14 métal + PA, verse l\'objet', () => {
    const base = new Game(RICH);
    const c = base.addCitizen('Alia');
    const game = restore(RICH, base, { buildings: { workshop: 1 } });
    const before = game.status();
    const apBefore = before.citizens[0]!.actionPoints;

    const res = game.craft(c.id, 'craft-steel-beam');
    expect(res.produced).toEqual({ 'steel-beam': 1 });

    const after = game.status();
    expect(after.bank.metal).toBe(before.bank.metal - 14);
    expect(after.bank.wood).toBe(before.bank.wood);
    expect(after.items['steel-beam']).toBe(1);
    // craft-steel-beam coûte 2 PA.
    expect(after.citizens[0]!.actionPoints).toBe(apBefore - 2);
  });

  it('transforme un objet en un autre : 1 câble → 2 fils de cuivre', () => {
    const base = new Game(RICH);
    const c = base.addCitizen('Alia');
    const game = restore(RICH, base, { buildings: { workshop: 1 }, items: { cable: 1 } });
    const res = game.craft(c.id, 'craft-copper-wire');
    expect(res.produced).toEqual({ 'copper-wire': 2 });
    const s = game.status();
    expect(s.items.cable).toBeUndefined(); // consommé jusqu'à zéro → purgé
    expect(s.items['copper-wire']).toBe(2);
  });

  it('échec atomique : ni PA ni ressources entamés si un objet manque', () => {
    const base = new Game(RICH);
    const c = base.addCitizen('Alia');
    // Forge présente mais aucun câble en stock.
    const game = restore(RICH, base, { buildings: { workshop: 1 } });
    const apBefore = game.status().citizens[0]!.actionPoints;
    expect(() => game.craft(c.id, 'craft-copper-wire')).toThrow(/Câble|manquants/i);
    expect(game.status().citizens[0]!.actionPoints).toBe(apBefore);
    expect(game.status().items).toEqual({});
  });

  it('refuse de fabriquer depuis le désert', () => {
    const base = new Game(RICH);
    const c = base.addCitizen('Alia');
    const game = restore(RICH, base, { buildings: { workshop: 1 } });
    game.setLocation(c.id, 'desert');
    expect(() => game.craft(c.id, 'craft-rope')).toThrow(/en ville/);
  });

  it('refuse une recette inconnue', () => {
    const base = new Game(RICH);
    const c = base.addCitizen('Alia');
    const game = restore(RICH, base, { buildings: { workshop: 1 } });
    expect(() => game.craft(c.id, 'craft-teleporter')).toThrow(/inconnue/i);
  });

  it('la neutralité en rations tient à l\'exécution : 2 conserves → 2 viandes séchées', () => {
    const base = new Game(RICH);
    const c = base.addCitizen('Alia');
    const game = restore(RICH, base, {
      buildings: { workshop: 1 },
      items: { 'canned-food': 2 },
    });
    const rationsBefore = totalRations(game.items(), rationsOf);
    game.craft(c.id, 'craft-dried-meat'); // 2 canned-food (2r) → 2 dried-meat (2r)
    const s = game.status();
    expect(s.items['canned-food']).toBeUndefined();
    expect(s.items['dried-meat']).toBe(2);
    expect(totalRations(game.items(), rationsOf)).toBe(rationsBefore);
  });
});
