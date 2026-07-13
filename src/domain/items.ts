/**
 * Catalogue des objets récupérables dans le désert de Hordes Revival.
 *
 * En plus des trois ressources brutes (bois / métal / eau) stockées dans la
 * banque, l'exploration fait remonter des **objets** discrets, rangés dans un
 * stock d'objets de la ville (`ItemStock`). Trois familles, aux rôles distincts :
 *
 *   - `tool`     (outils)          : composants manufacturés ; consommés comme
 *                                     matériel de construction des bâtiments
 *                                     avancés (cf. `buildings.ts` → `itemCost`).
 *   - `material` (matériaux rares) : ferraille de valeur ; également consommée
 *                                     par la construction avancée.
 *   - `food`     (vivres)          : rations de secours ; automatiquement
 *                                     consommées à l'aube pour empêcher la
 *                                     déshydratation d'un citoyen quand la
 *                                     banque d'eau est à sec (cf. `Game.dawn`).
 *
 * La rareté pondère à la fois la fréquence d'apparition à la fouille
 * (`dropWeight`) et la distance minimale à la ville en dessous de laquelle
 * l'objet ne tombe jamais (`minDistance`) : les matériaux rares ne se trouvent
 * qu'aux confins du désert.
 */

/** Famille d'un objet — pilote son rôle mécanique et son regroupement UI. */
export type ItemCategory = 'tool' | 'material' | 'food';

/** Niveau de rareté (narratif + tri d'affichage). */
export type ItemRarity = 'common' | 'uncommon' | 'rare';

/** Identifiant stable d'un objet du catalogue. */
export type ItemId =
  | 'toolbox'
  | 'rope'
  | 'duct-tape'
  | 'canned-food'
  | 'dried-meat'
  | 'energy-bar'
  | 'steel-beam'
  | 'copper-wire'
  | 'electronics'
  | 'car-battery';

/** Définition statique d'un objet du catalogue (partagée par toutes les villes). */
export interface ItemDef {
  readonly id: ItemId;
  readonly name: string;
  readonly description: string;
  readonly icon: string;
  readonly category: ItemCategory;
  readonly rarity: ItemRarity;
  /** Poids de tirage à la fouille (plus grand = plus fréquent). */
  readonly dropWeight: number;
  /** Distance Chebyshev minimale à la ville pour que l'objet puisse tomber. */
  readonly minDistance: number;
  /**
   * Rations couvertes par une unité pour les vivres (1 unité nourrit
   * `rations` citoyens à l'aube). `0` pour les non-comestibles.
   */
  readonly rations: number;
}

/** Stock d'objets d'une ville, indexé par `ItemId`. */
export type ItemStock = Readonly<Partial<Record<ItemId, number>>>;

/** Coût en objets d'une construction avancée (cf. `buildings.ts`). */
export type ItemCost = Readonly<Partial<Record<ItemId, number>>>;

/** Catalogue immuable des 10 objets récupérables. */
export const ITEM_CATALOG: readonly ItemDef[] = [
  // ── Outils (tool) ─────────────────────────────────────────────────────────
  {
    id: 'toolbox',
    name: 'Boîte à outils',
    description:
      'Clés, pinces et tournevis d\'un garagiste disparu. Indispensable aux chantiers de précision.',
    icon: '🧰',
    category: 'tool',
    rarity: 'uncommon',
    dropWeight: 4,
    minDistance: 2,
    rations: 0,
  },
  {
    id: 'rope',
    name: 'Corde',
    description: 'Cordage résistant récupéré sur un chantier abandonné. Sert à gréer pièges et échafaudages.',
    icon: '🪢',
    category: 'tool',
    rarity: 'common',
    dropWeight: 7,
    minDistance: 1,
    rations: 0,
  },
  {
    id: 'duct-tape',
    name: 'Ruban adhésif',
    description: 'Le sparadrap de l\'apocalypse : rafistole tout, des barricades aux gourdes fêlées.',
    icon: '🩹',
    category: 'tool',
    rarity: 'common',
    dropWeight: 6,
    minDistance: 1,
    rations: 0,
  },
  // ── Vivres (food) ─────────────────────────────────────────────────────────
  {
    id: 'canned-food',
    name: 'Conserves',
    description: 'Boîtes de ravitaillement d\'avant la chute. Une ration fiable quand l\'eau vient à manquer.',
    icon: '🥫',
    category: 'food',
    rarity: 'common',
    dropWeight: 7,
    minDistance: 1,
    rations: 2,
  },
  {
    id: 'dried-meat',
    name: 'Viande séchée',
    description: 'Lanières boucanées au soleil du désert. Se conserve indéfiniment et cale un estomac vide.',
    icon: '🥩',
    category: 'food',
    rarity: 'uncommon',
    dropWeight: 4,
    minDistance: 2,
    rations: 2,
  },
  {
    id: 'energy-bar',
    name: 'Barre énergétique',
    description: 'Snack calorique sous emballage argenté. Un coup de fouet immédiat, mais rien de plus.',
    icon: '🍫',
    category: 'food',
    rarity: 'common',
    dropWeight: 6,
    minDistance: 1,
    rations: 1,
  },
  // ── Matériaux rares (material) ────────────────────────────────────────────
  {
    id: 'steel-beam',
    name: 'Poutre d\'acier',
    description: 'Longeron d\'immeuble effondré. Le squelette rêvé pour un mur qui tiendra la horde.',
    icon: '🏗️',
    category: 'material',
    rarity: 'rare',
    dropWeight: 2,
    minDistance: 3,
    rations: 0,
  },
  {
    id: 'copper-wire',
    name: 'Fil de cuivre',
    description: 'Bobine de câblage arrachée aux murs. Conduit le courant et vaut son pesant de métal.',
    icon: '🧵',
    category: 'material',
    rarity: 'uncommon',
    dropWeight: 4,
    minDistance: 2,
    rations: 0,
  },
  {
    id: 'electronics',
    name: 'Composants électroniques',
    description: 'Cartes, relais et circuits pillés dans les ruines. Le cœur des installations sophistiquées.',
    icon: '💾',
    category: 'material',
    rarity: 'rare',
    dropWeight: 2,
    minDistance: 3,
    rations: 0,
  },
  {
    id: 'car-battery',
    name: 'Batterie de voiture',
    description: 'Lourde batterie au plomb tirée d\'une épave. Réserve d\'énergie pour les machines de la ville.',
    icon: '🔋',
    category: 'material',
    rarity: 'uncommon',
    dropWeight: 3,
    minDistance: 2,
    rations: 0,
  },
];

/** Indexe le catalogue pour un accès O(1) par id. */
const CATALOG_INDEX: ReadonlyMap<ItemId, ItemDef> = new Map(
  ITEM_CATALOG.map((it) => [it.id, it] as const),
);

/** Retourne la définition d'un objet ou `undefined` si l'id est inconnu. */
export function getItemDef(id: string): ItemDef | undefined {
  return CATALOG_INDEX.get(id as ItemId);
}

/** `true` si l'identifiant correspond à un objet du catalogue. */
export function isKnownItemId(id: string): id is ItemId {
  return CATALOG_INDEX.has(id as ItemId);
}

/**
 * Filtre / normalise un objet libre (JSONB hydraté, snapshot importé) vers un
 * `ItemStock` strict : ne conserve que les ids connus et force les compteurs à
 * des entiers positifs.
 */
export function sanitizeItemStock(raw: unknown): ItemStock {
  if (!raw || typeof raw !== 'object') return {};
  const out: Partial<Record<ItemId, number>> = {};
  for (const def of ITEM_CATALOG) {
    const value = (raw as Record<string, unknown>)[def.id];
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    const count = Math.max(0, Math.trunc(value));
    if (count > 0) out[def.id] = count;
  }
  return out;
}

/**
 * `true` si le stock couvre intégralement le coût en objets fourni. Un coût
 * vide (aucune ligne) est toujours satisfait.
 */
export function stockCoversCost(stock: ItemStock, cost: ItemCost | undefined): boolean {
  if (!cost) return true;
  for (const id of Object.keys(cost) as ItemId[]) {
    const need = cost[id] ?? 0;
    if ((stock[id] ?? 0) < need) return false;
  }
  return true;
}

/**
 * Tire un objet à faire tomber dans une zone de distance `distance` à la ville.
 * Ne considère que les objets dont `minDistance <= distance`, pondérés par leur
 * `dropWeight`. Renvoie `undefined` si aucun objet n'est éligible (jamais le cas
 * en pratique — les objets communs tombent dès la distance 1).
 *
 * `roll` est un nombre déterministe dans `[0, 1)` (issu d'un Rng seedé côté
 * moteur), ce qui garde le drop reproductible.
 */
export function pickDroppableItem(distance: number, roll: number): ItemId | undefined {
  const eligible = ITEM_CATALOG.filter((it) => it.minDistance <= distance);
  if (!eligible.length) return undefined;
  let total = 0;
  for (const it of eligible) total += it.dropWeight;
  let pick = Math.min(Math.max(roll, 0), 0.999999) * total;
  for (const it of eligible) {
    pick -= it.dropWeight;
    if (pick < 0) return it.id;
  }
  return eligible[eligible.length - 1]!.id;
}

/** Liste ordonnée des vivres (comestibles), du plus commun au plus rare. */
export function foodItemsByAbundance(): ItemDef[] {
  return ITEM_CATALOG.filter((it) => it.category === 'food').sort(
    (a, b) => b.dropWeight - a.dropWeight,
  );
}
