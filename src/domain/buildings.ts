/**
 * Catalogue des bâtiments constructibles d'une ville de Hordes Revival.
 *
 * Chaque entrée définit :
 *   - l'identifiant stable (`id`) — utilisé en persistance et sur le wire ;
 *   - le coût d'érection (PA + ressources) ;
 *   - les effets passifs accumulés tant que le bâtiment existe :
 *       • `wallDefense`         : défense flat ajoutée aux remparts ;
 *       • `watchBonusPerCitizen`: défense par citoyen en faction la nuit ;
 *       • `waterPerDawn`        : eau produite à l'aube de chaque nouveau jour.
 *   - `maxCount` : plafond d'instances (1 pour des bâtiments uniques comme
 *     l'atelier, plusieurs pour les barricades qui s'empilent).
 *
 * Les effets sont *additifs* — la mécanique de horde nocturne (cf.
 * `game.endDay()`) calcule la défense totale = baseDefense + townDefense
 * accumulée par `build()` + somme(count × wallDefense des bâtiments)
 * + watcherCount × (watchDefensePerCitizen + somme(count × watchBonus)).
 *
 * Effets avancés (Jalon 3, bâtiments de seconde génération) :
 *   • `hordeDeterrence`  : puissance de horde retranchée AVANT l'assaut
 *                          (pièges qui déciment la nuée en approche) ;
 *   • `casualtyReduction`: nombre de victimes épargnées en cas de percée
 *                          (infirmerie qui sauve des blessés) ;
 *   • `itemCost`         : objets du désert exigés en plus du bois/métal
 *                          (matériaux rares & outils, cf. `items.ts`).
 */
import type { ResourceBank } from './types.js';
import type { ItemCost } from './items.js';

/** Identifiant stable d'un bâtiment du catalogue. */
export type BuildingId =
  | 'watchtower'
  | 'workshop'
  | 'well'
  | 'barricades'
  | 'rampart'
  | 'trap-field'
  | 'infirmary'
  | 'pumping-station'
  | 'bunker';

/** Coût en ressources pour ériger un bâtiment. */
export interface BuildingCost {
  readonly wood: number;
  readonly metal: number;
}

/** Définition d'un bâtiment du catalogue (statique, partagée par toutes les villes). */
export interface BuildingDef {
  readonly id: BuildingId;
  readonly name: string;
  readonly description: string;
  readonly icon: string;
  readonly cost: BuildingCost;
  /** Objets du désert exigés en plus du bois/métal (optionnel). */
  readonly itemCost?: ItemCost;
  readonly actionPointCost: number;
  readonly wallDefense: number;
  readonly watchBonusPerCitizen: number;
  readonly waterPerDawn: number;
  /** Puissance de horde retranchée avant l'assaut (pièges). */
  readonly hordeDeterrence: number;
  /** Victimes épargnées lors d'une percée (soin). */
  readonly casualtyReduction: number;
  readonly maxCount: number;
}

/** Compteur d'instances de chaque bâtiment construit, indexé par `BuildingId`. */
export type BuildingState = Readonly<Partial<Record<BuildingId, number>>>;

/** Catalogue immuable des bâtiments disponibles dans cette version du jeu. */
export const BUILDING_CATALOG: readonly BuildingDef[] = [
  {
    id: 'watchtower',
    name: 'Tour de guet',
    description:
      'Plateforme d\'observation surélevée : chaque citoyen en faction la nuit voit son arc de tir étendu.',
    icon: '🗼',
    cost: { wood: 8, metal: 4 },
    actionPointCost: 2,
    wallDefense: 0,
    watchBonusPerCitizen: 2,
    waterPerDawn: 0,
    hordeDeterrence: 0,
    casualtyReduction: 0,
    maxCount: 5,
  },
  {
    id: 'workshop',
    name: 'Atelier de fortification',
    description:
      'Forge communale : durcit définitivement les remparts avec des pièces métalliques retravaillées.',
    icon: '⚒',
    cost: { wood: 12, metal: 8 },
    actionPointCost: 3,
    wallDefense: 10,
    watchBonusPerCitizen: 0,
    waterPerDawn: 0,
    hordeDeterrence: 0,
    casualtyReduction: 0,
    maxCount: 1,
  },
  {
    id: 'well',
    name: 'Puits',
    description:
      'Creuse jusqu\'à la nappe phréatique. Produit 2 unités d\'eau à chaque aube pour ravitailler la banque.',
    icon: '💧',
    cost: { wood: 6, metal: 6 },
    actionPointCost: 2,
    wallDefense: 0,
    watchBonusPerCitizen: 0,
    waterPerDawn: 2,
    hordeDeterrence: 0,
    casualtyReduction: 0,
    maxCount: 2,
  },
  {
    id: 'barricades',
    name: 'Barricades',
    description:
      'Empilage de poutres, ferrailles et carcasses. Renfort modeste mais empilable à volonté.',
    icon: '🚧',
    cost: { wood: 5, metal: 0 },
    actionPointCost: 1,
    wallDefense: 4,
    watchBonusPerCitizen: 0,
    waterPerDawn: 0,
    hordeDeterrence: 0,
    casualtyReduction: 0,
    maxCount: 20,
  },
  // ── Bâtiments de seconde génération (exigent des objets du désert) ─────────
  {
    id: 'rampart',
    name: 'Rempart de béton',
    description:
      'Mur de béton coulé sur armature d\'acier. Le socle défensif le plus solide de la ville — unique et massif.',
    icon: '🧱',
    cost: { wood: 10, metal: 14 },
    itemCost: { 'steel-beam': 2 },
    actionPointCost: 3,
    wallDefense: 25,
    watchBonusPerCitizen: 0,
    waterPerDawn: 0,
    hordeDeterrence: 0,
    casualtyReduction: 0,
    maxCount: 1,
  },
  {
    id: 'trap-field',
    name: 'Champ de pièges',
    description:
      'Fosses hérissées, fils tendus et collets. Déciment la horde avant même qu\'elle n\'atteigne les murs.',
    icon: '🕳️',
    cost: { wood: 6, metal: 4 },
    itemCost: { rope: 1, 'duct-tape': 1 },
    actionPointCost: 2,
    wallDefense: 0,
    watchBonusPerCitizen: 0,
    waterPerDawn: 0,
    hordeDeterrence: 6,
    casualtyReduction: 0,
    maxCount: 5,
  },
  {
    id: 'infirmary',
    name: 'Infirmerie',
    description:
      'Poste de secours équipé. Stabilise les blessés d\'une percée : une victime de moins par nuit et par instance.',
    icon: '⛑️',
    cost: { wood: 8, metal: 6 },
    itemCost: { toolbox: 1 },
    actionPointCost: 3,
    wallDefense: 0,
    watchBonusPerCitizen: 0,
    waterPerDawn: 0,
    hordeDeterrence: 0,
    casualtyReduction: 1,
    maxCount: 2,
  },
  {
    id: 'pumping-station',
    name: 'Station de pompage',
    description:
      'Pompe électrique alimentée par batterie. Remonte 4 unités d\'eau à chaque aube — bien plus qu\'un simple puits.',
    icon: '🚰',
    cost: { wood: 6, metal: 10 },
    itemCost: { 'car-battery': 1, electronics: 1 },
    actionPointCost: 3,
    wallDefense: 0,
    watchBonusPerCitizen: 0,
    waterPerDawn: 4,
    hordeDeterrence: 0,
    casualtyReduction: 0,
    maxCount: 1,
  },
  {
    id: 'bunker',
    name: 'Bunker blindé',
    description:
      'Casemate enterrée reliée aux remparts. Décuple l\'efficacité des guetteurs et abrite un blessé de plus.',
    icon: '🛡️',
    cost: { wood: 8, metal: 12 },
    itemCost: { 'steel-beam': 1, 'copper-wire': 2 },
    actionPointCost: 3,
    wallDefense: 0,
    watchBonusPerCitizen: 3,
    waterPerDawn: 0,
    hordeDeterrence: 0,
    casualtyReduction: 1,
    maxCount: 1,
  },
];

/** Indexe le catalogue pour un accès O(1) par id. */
const CATALOG_INDEX: ReadonlyMap<BuildingId, BuildingDef> = new Map(
  BUILDING_CATALOG.map((b) => [b.id, b] as const),
);

/** Retourne la définition d'un bâtiment ou `undefined` si l'id est inconnu. */
export function getBuildingDef(id: string): BuildingDef | undefined {
  return CATALOG_INDEX.get(id as BuildingId);
}

/** `true` si l'identifiant correspond à un bâtiment du catalogue. */
export function isKnownBuildingId(id: string): id is BuildingId {
  return CATALOG_INDEX.has(id as BuildingId);
}

/** Total `wallDefense` apportée par l'ensemble des bâtiments construits. */
export function totalWallDefenseFromBuildings(state: BuildingState): number {
  let total = 0;
  for (const def of BUILDING_CATALOG) {
    const count = state[def.id] ?? 0;
    total += count * def.wallDefense;
  }
  return total;
}

/** Bonus défensif additionnel par citoyen en faction la nuit. */
export function totalWatchBonusFromBuildings(state: BuildingState): number {
  let total = 0;
  for (const def of BUILDING_CATALOG) {
    const count = state[def.id] ?? 0;
    total += count * def.watchBonusPerCitizen;
  }
  return total;
}

/** Eau totale produite à l'aube par les puits et autres infrastructures. */
export function totalWaterPerDawnFromBuildings(state: BuildingState): number {
  let total = 0;
  for (const def of BUILDING_CATALOG) {
    const count = state[def.id] ?? 0;
    total += count * def.waterPerDawn;
  }
  return total;
}

/** Puissance de horde retranchée avant l'assaut par les pièges. */
export function totalHordeDeterrenceFromBuildings(state: BuildingState): number {
  let total = 0;
  for (const def of BUILDING_CATALOG) {
    const count = state[def.id] ?? 0;
    total += count * def.hordeDeterrence;
  }
  return total;
}

/** Victimes épargnées lors d'une percée par les infrastructures de soin. */
export function totalCasualtyReductionFromBuildings(state: BuildingState): number {
  let total = 0;
  for (const def of BUILDING_CATALOG) {
    const count = state[def.id] ?? 0;
    total += count * def.casualtyReduction;
  }
  return total;
}

/**
 * Filtre / normalise un objet libre vers un `BuildingState` strict : ne
 * conserve que les ids connus du catalogue, force les compteurs à des entiers
 * positifs et applique les plafonds par bâtiment. Utilisé par la couche
 * persistence pour valider un JSONB hydraté depuis Postgres.
 */
export function sanitizeBuildingState(raw: unknown): BuildingState {
  if (!raw || typeof raw !== 'object') return {};
  const out: Partial<Record<BuildingId, number>> = {};
  for (const def of BUILDING_CATALOG) {
    const value = (raw as Record<string, unknown>)[def.id];
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    const count = Math.max(0, Math.min(def.maxCount, Math.trunc(value)));
    if (count > 0) out[def.id] = count;
  }
  return out;
}

/**
 * Reconstitue le coût standard d'une ligne du catalogue (utile aux clients qui
 * veulent afficher la liste sans hardcoder les valeurs).
 */
export function buildingCostAsBank(cost: BuildingCost): Pick<ResourceBank, 'wood' | 'metal'> {
  return { wood: cost.wood, metal: cost.metal };
}
