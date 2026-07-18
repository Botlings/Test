/**
 * Crafting & transformation d'objets — l'établi de la ville (Hordes Revival).
 *
 * Une fois la **forge** érigée (`workshop`, la « Forge communale » du catalogue
 * `buildings.ts`), les citoyens présents en ville peuvent transformer leurs
 * ressources brutes (bois / métal / eau) et les objets récupérés au désert en
 * d'autres objets : c'est ce qui donne enfin de la valeur aux composants rares
 * (on peut désormais *fabriquer* la poutre d'acier ou les composants
 * électroniques que la construction avancée exigeait, au lieu de dépendre
 * uniquement de la fouille).
 *
 * Deux invariants de conception, garantis par les tests :
 *   1. **Aucune recette ne produit de ressource brute** — le crafting est un
 *      *puits* de bois/métal/eau, jamais une pompe : impossible de fabriquer de
 *      la matière première à partir de rien.
 *   2. **Les recettes de vivres sont neutres en rations** — convertir un type
 *      de nourriture en un autre ne crée jamais de ration nette, sinon on
 *      pourrait fabriquer de la survie infinie à partir de bois.
 *
 * La logique est 100 % pure et déterministe (aucune Rng), à l'image de
 * `governance.ts` : le moteur (`Game.craft`) se contente d'orchestrer les
 * effets de bord (dépense PA, banque, stock) autour de ces primitives.
 */
import type { ResourceBank } from './types.js';
import type { ItemId, ItemStock, ItemCost } from './items.js';
import type { BuildingId } from './buildings.js';

/** Bâtiment qui débloque l'établi : la forge (« Atelier de fortification »). */
export const CRAFTING_BUILDING: BuildingId = 'workshop';

/** Identifiant stable d'une recette de fabrication. */
export type RecipeId =
  // ── Outils ────────────────────────────────────────────────────────────────
  | 'craft-rope'
  | 'craft-duct-tape'
  | 'craft-toolbox'
  | 'craft-rusty-shovel'
  | 'craft-medical-kit'
  // ── Matériaux ───────────────────────────────────────────────────────────
  | 'craft-steel-beam'
  | 'craft-copper-wire'
  | 'craft-cable'
  | 'craft-electronics'
  | 'craft-car-battery'
  | 'craft-fuel-can'
  // ── Vivres (transformations neutres en rations) ─────────────────────────────
  | 'craft-canned-food'
  | 'craft-dried-meat'
  | 'craft-ration-tin'
  | 'craft-energy-bar';

/** Coût / rendement en ressources brutes d'une recette (lignes optionnelles). */
export interface CraftResources {
  readonly wood?: number;
  readonly metal?: number;
  readonly water?: number;
}

/** Ce qu'une recette consomme : ressources de la banque + objets du stock. */
export interface CraftInputs {
  readonly resources: CraftResources;
  readonly items: ItemCost;
}

/** Ce qu'une recette produit : uniquement des objets (jamais de ressource brute). */
export interface CraftOutputs {
  readonly items: Readonly<Partial<Record<ItemId, number>>>;
}

/** Regroupement d'affichage (miroir des familles d'objets). */
export type RecipeGroup = 'tool' | 'material' | 'food';

/** Définition statique d'une recette (partagée par toutes les villes). */
export interface RecipeDef {
  readonly id: RecipeId;
  readonly name: string;
  readonly description: string;
  readonly icon: string;
  readonly group: RecipeGroup;
  /** Points d'action dépensés par le citoyen qui fabrique. */
  readonly actionPointCost: number;
  /** Bâtiment requis pour accéder à l'établi (toujours la forge). */
  readonly requiresBuilding: BuildingId;
  readonly inputs: CraftInputs;
  readonly outputs: CraftOutputs;
}

/**
 * Catalogue immuable des 15 recettes de base. Chaque entrée transforme des
 * ressources et/ou objets en objets. Les ratios sont calibrés pour rester un
 * puits net de ressources (voir invariants en tête de fichier).
 */
export const RECIPE_CATALOG: readonly RecipeDef[] = [
  // ══ Outils ═════════════════════════════════════════════════════════════════
  {
    id: 'craft-rope',
    name: 'Corde tressée',
    description: 'Tresse des fibres de bois refendu en un cordage résistant.',
    icon: '🪢',
    group: 'tool',
    actionPointCost: 1,
    requiresBuilding: CRAFTING_BUILDING,
    inputs: { resources: { wood: 4 }, items: {} },
    outputs: { items: { rope: 1 } },
  },
  {
    id: 'craft-duct-tape',
    name: 'Ruban de fortune',
    description: 'Recycle chutes de bois et copeaux de métal en rouleaux d\'adhésif.',
    icon: '🩹',
    group: 'tool',
    actionPointCost: 1,
    requiresBuilding: CRAFTING_BUILDING,
    inputs: { resources: { wood: 3, metal: 2 }, items: {} },
    outputs: { items: { 'duct-tape': 2 } },
  },
  {
    id: 'craft-toolbox',
    name: 'Boîte à outils',
    description: 'Assemble clés, pinces et tournevis sur un cadre métallique renforcé au ruban.',
    icon: '🧰',
    group: 'tool',
    actionPointCost: 2,
    requiresBuilding: CRAFTING_BUILDING,
    inputs: { resources: { metal: 5 }, items: { 'duct-tape': 1 } },
    outputs: { items: { toolbox: 1 } },
  },
  {
    id: 'craft-rusty-shovel',
    name: 'Pelle de fortune',
    description: 'Forge un fer de pelle grossier et l\'emmanche sur un solide manche de bois.',
    icon: '⛏️',
    group: 'tool',
    actionPointCost: 1,
    requiresBuilding: CRAFTING_BUILDING,
    inputs: { resources: { wood: 2, metal: 3 }, items: {} },
    outputs: { items: { 'rusty-shovel': 1 } },
  },
  {
    id: 'craft-medical-kit',
    name: 'Trousse de soin',
    description: 'Stérilise compresses et sutures dans une boîte à outils reconvertie en infirmerie de poche.',
    icon: '🩺',
    group: 'tool',
    actionPointCost: 2,
    requiresBuilding: CRAFTING_BUILDING,
    inputs: { resources: { water: 3 }, items: { toolbox: 1, 'duct-tape': 2 } },
    outputs: { items: { 'medical-kit': 1 } },
  },
  // ══ Matériaux ══════════════════════════════════════════════════════════════
  {
    id: 'craft-steel-beam',
    name: 'Poutre forgée',
    description: 'Refond une pleine coulée de métal en un longeron d\'acier prêt à porter un rempart.',
    icon: '🏗️',
    group: 'material',
    actionPointCost: 2,
    requiresBuilding: CRAFTING_BUILDING,
    inputs: { resources: { metal: 14 }, items: {} },
    outputs: { items: { 'steel-beam': 1 } },
  },
  {
    id: 'craft-copper-wire',
    name: 'Fil dénudé',
    description: 'Dépouille un câble de sa gaine pour en tirer du fil de cuivre nu.',
    icon: '🧵',
    group: 'material',
    actionPointCost: 1,
    requiresBuilding: CRAFTING_BUILDING,
    inputs: { resources: {}, items: { cable: 1 } },
    outputs: { items: { 'copper-wire': 2 } },
  },
  {
    id: 'craft-cable',
    name: 'Câblage regainé',
    description: 'Regaine du fil de cuivre au ruban adhésif pour reformer un câble utilisable.',
    icon: '🔌',
    group: 'material',
    actionPointCost: 1,
    requiresBuilding: CRAFTING_BUILDING,
    inputs: { resources: {}, items: { 'copper-wire': 2, 'duct-tape': 1 } },
    outputs: { items: { cable: 1 } },
  },
  {
    id: 'craft-electronics',
    name: 'Circuits récupérés',
    description: 'Dessoude cartes et relais d\'une radio hors d\'usage, recâblés en composants sains.',
    icon: '💾',
    group: 'material',
    actionPointCost: 2,
    requiresBuilding: CRAFTING_BUILDING,
    inputs: { resources: {}, items: { 'copper-wire': 2, 'broken-radio': 1 } },
    outputs: { items: { electronics: 1 } },
  },
  {
    id: 'craft-car-battery',
    name: 'Batterie assemblée',
    description: 'Remplit une carcasse d\'accumulateur d\'électrolyte distillé du carburant : une réserve d\'énergie.',
    icon: '🔋',
    group: 'material',
    actionPointCost: 2,
    requiresBuilding: CRAFTING_BUILDING,
    inputs: { resources: { metal: 3 }, items: { 'fuel-can': 1, 'copper-wire': 1 } },
    outputs: { items: { 'car-battery': 1 } },
  },
  {
    id: 'craft-fuel-can',
    name: 'Carburant distillé',
    description: 'Distille un ersatz de carburant à partir de bois pyrolysé et d\'eau — instable mais inflammable.',
    icon: '⛽',
    group: 'material',
    actionPointCost: 1,
    requiresBuilding: CRAFTING_BUILDING,
    inputs: { resources: { wood: 4, water: 4 }, items: {} },
    outputs: { items: { 'fuel-can': 1 } },
  },
  // ══ Vivres — conversions NEUTRES en rations (anti-exploit) ══════════════════
  {
    id: 'craft-canned-food',
    name: 'Conserves scellées',
    description: 'Serti deux barres énergétiques dans une boîte métallique hermétique.',
    icon: '🥫',
    group: 'food',
    actionPointCost: 1,
    requiresBuilding: CRAFTING_BUILDING,
    inputs: { resources: { metal: 1 }, items: { 'energy-bar': 2 } },
    outputs: { items: { 'canned-food': 1 } },
  },
  {
    id: 'craft-dried-meat',
    name: 'Viande boucanée',
    description: 'Ouvre des conserves et boucane leur contenu au feu de bois pour le conserver.',
    icon: '🥩',
    group: 'food',
    actionPointCost: 1,
    requiresBuilding: CRAFTING_BUILDING,
    inputs: { resources: { wood: 3 }, items: { 'canned-food': 2 } },
    outputs: { items: { 'dried-meat': 2 } },
  },
  {
    id: 'craft-ration-tin',
    name: 'Ration militaire',
    description: 'Compose une ration complète (conserve + viande séchée) dans une grosse boîte de fer.',
    icon: '🥫',
    group: 'food',
    actionPointCost: 1,
    requiresBuilding: CRAFTING_BUILDING,
    inputs: { resources: { metal: 1 }, items: { 'canned-food': 1, 'dried-meat': 1 } },
    outputs: { items: { 'ration-tin': 2 } },
  },
  {
    id: 'craft-energy-bar',
    name: 'Barres reconditionnées',
    description: 'Reconditionne une ration militaire en portions énergétiques individuelles.',
    icon: '🍫',
    group: 'food',
    actionPointCost: 1,
    requiresBuilding: CRAFTING_BUILDING,
    inputs: { resources: { water: 2 }, items: { 'ration-tin': 1 } },
    outputs: { items: { 'energy-bar': 2 } },
  },
];

/** Indexe le catalogue pour un accès O(1) par id. */
const CATALOG_INDEX: ReadonlyMap<RecipeId, RecipeDef> = new Map(
  RECIPE_CATALOG.map((r) => [r.id, r] as const),
);

/** Retourne la définition d'une recette ou `undefined` si l'id est inconnu. */
export function getRecipeDef(id: string): RecipeDef | undefined {
  return CATALOG_INDEX.get(id as RecipeId);
}

/** `true` si l'identifiant correspond à une recette du catalogue. */
export function isKnownRecipeId(id: string): id is RecipeId {
  return CATALOG_INDEX.has(id as RecipeId);
}

/** Raison pour laquelle une recette n'est pas réalisable (ou `null` si elle l'est). */
export type CraftBlocker =
  | { readonly kind: 'no-forge' }
  | { readonly kind: 'resources'; readonly resource: 'wood' | 'metal' | 'water' }
  | { readonly kind: 'items'; readonly item: ItemId };

/**
 * Contrôle *pur* de faisabilité d'une recette. Ne mute rien : renvoie le
 * premier obstacle rencontré (forge absente, ressource ou objet manquant) ou
 * `null` si la recette peut être lancée. L'ordre des contrôles est stable pour
 * des messages d'erreur déterministes.
 */
export function recipeBlocker(
  recipe: RecipeDef,
  bank: Pick<ResourceBank, 'wood' | 'metal' | 'water'>,
  stock: ItemStock,
  buildingCount: number,
): CraftBlocker | null {
  if (buildingCount <= 0) return { kind: 'no-forge' };
  const res = recipe.inputs.resources;
  for (const resource of ['wood', 'metal', 'water'] as const) {
    const need = res[resource] ?? 0;
    if (need > 0 && (bank[resource] ?? 0) < need) return { kind: 'resources', resource };
  }
  for (const id of Object.keys(recipe.inputs.items) as ItemId[]) {
    const need = recipe.inputs.items[id] ?? 0;
    if (need > 0 && (stock[id] ?? 0) < need) return { kind: 'items', item: id };
  }
  return null;
}

/**
 * Total des rations couvertes par les vivres d'une table `ItemId → quantité`,
 * pondéré par une fonction `rationsOf` (injectée pour éviter une dépendance
 * circulaire avec `items.ts`). Sert à prouver la neutralité en rations.
 */
export function totalRations(
  table: Readonly<Partial<Record<ItemId, number>>>,
  rationsOf: (id: ItemId) => number,
): number {
  let total = 0;
  for (const id of Object.keys(table) as ItemId[]) {
    total += (table[id] ?? 0) * rationsOf(id);
  }
  return total;
}
