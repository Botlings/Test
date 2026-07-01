/**
 * Carte du désert explorable autour de la ville de Hordes Revival.
 *
 * La ville occupe la zone centrale (0, 0). Les autres zones s'organisent en
 * grille carrée bornée par un `radius` (rayon Chebyshev). Pour `radius = 3`,
 * la carte fait 7×7 cases moins la ville → 48 zones désertiques.
 *
 * Chaque zone porte :
 *   - un `terrain` qui pondère la nature et la quantité du loot ;
 *   - un stock résiduel d'objets (`loot.wood/metal/water`) ramassables à la
 *     fouille — chaque action `scavengeZone` décrémente d'une unité d'une
 *     ressource présente ;
 *   - un nombre de `zombies` errants qui bloquent toute fouille tant qu'ils
 *     ne sont pas chassés (`fightZombie`) ;
 *   - un drapeau `discovered` mis à `true` la première fois qu'un citoyen y
 *     pénètre (utile à l'UI : on cache le contenu des zones inexplorées).
 *
 * La génération est **déterministe** : à partir d'une seed numérique stable
 * (dérivée du `townId`) et d'un PRNG Mulberry32, on obtient toujours la même
 * carte. Cela rend les tests reproductibles et permet de re-jouer une partie
 * sans surprise après reload.
 *
 * Les zones lointaines portent plus de loot et plus de zombies : c'est le
 * compromis risque / récompense de la mécanique d'exploration.
 */

import type { ResourceKind } from './types.js';

/** Tirage déterministe : voir https://en.wikipedia.org/wiki/Linear_congruential_generator. */
export interface Rng {
  next(): number;
  nextInt(min: number, maxExclusive: number): number;
  /** Choisit aléatoirement un index pondéré (somme des poids = total). */
  weighted<T>(items: ReadonlyArray<{ readonly value: T; readonly weight: number }>): T;
}

/** Mulberry32 — PRNG ultra léger, suffisant pour des tirages de jeu. */
export function mulberry32(seed: number): Rng {
  let state = seed >>> 0;
  function next(): number {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  return {
    next,
    nextInt(min, maxExclusive) {
      const span = Math.max(0, Math.floor(maxExclusive) - Math.floor(min));
      if (span <= 0) return Math.floor(min);
      return Math.floor(min) + Math.floor(next() * span);
    },
    weighted<T>(items: ReadonlyArray<{ readonly value: T; readonly weight: number }>): T {
      let total = 0;
      for (const it of items) total += Math.max(0, it.weight);
      if (total <= 0) return items[0]!.value;
      let pick = next() * total;
      for (const it of items) {
        pick -= Math.max(0, it.weight);
        if (pick <= 0) return it.value;
      }
      return items[items.length - 1]!.value;
    },
  };
}

/** Convertit une chaîne arbitraire en seed numérique 32 bits stable. */
export function seedFromString(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Catégories de terrain — pondèrent la nature du loot et la densité de zombies. */
export type ZoneTerrain = 'plain' | 'ruins' | 'highway' | 'wasteland';

/** Stock de loot d'une zone, libre de partir à zéro. */
export interface ZoneLoot {
  wood: number;
  metal: number;
  water: number;
}

/**
 * Nature d'un événement de zone (Jalon 4). Chaque zone peut porter au plus un
 * événement actif, tiré de façon déterministe par jour de partie :
 *   - `survivor-cache`    : cache de survivant — magot ramassable d'un coup ;
 *   - `abandoned-vehicle` : véhicule abandonné — épave à fouiller (métal) ;
 *   - `zombie-nest`       : nid de zombies — pond une nuée à chasser avant tout ;
 *   - `sandstorm`         : tempête de sable — bloque entrée et fouille de la
 *                           zone tant qu'elle souffle (se dissipe à l'aube).
 */
export type ZoneEventKind =
  | 'survivor-cache'
  | 'abandoned-vehicle'
  | 'zombie-nest'
  | 'sandstorm';

/** Événement actif sur une zone du désert. */
export interface ZoneEvent {
  readonly kind: ZoneEventKind;
  /**
   * Butin propre à l'événement, ramassable d'un bloc via `lootEvent` (cache de
   * survivant / véhicule abandonné). Nul pour les événements non pillables
   * (`{ wood: 0, metal: 0, water: 0 }`).
   */
  stash: ZoneLoot;
}

/** `true` si l'événement se pille (cache de survivant ou véhicule abandonné). */
export function isLootableEvent(event: ZoneEvent | null | undefined): event is ZoneEvent {
  return !!event && (event.kind === 'survivor-cache' || event.kind === 'abandoned-vehicle');
}

/** Une zone du désert. La ville n'est pas une zone : elle reste implicite à (0, 0). */
export interface DesertZone {
  readonly x: number;
  readonly y: number;
  /** Distance Chebyshev à la ville (max(|x|, |y|)). */
  readonly distance: number;
  readonly terrain: ZoneTerrain;
  loot: ZoneLoot;
  zombies: number;
  discovered: boolean;
  /** Événement actif sur la zone (Jalon 4), ou `null`. */
  event: ZoneEvent | null;
}

/** État sérialisable d'une carte. */
export interface DesertMap {
  readonly seed: number;
  readonly radius: number;
  /** Zones par clé `"x,y"` (la ville (0,0) n'y est PAS incluse). */
  zones: Readonly<Record<string, DesertZone>>;
}

/** Configuration de génération de la carte. */
export interface DesertConfig {
  /** Rayon Chebyshev en cases autour de la ville. */
  readonly radius: number;
  /** Nombre d'unités d'eau dans la gourde personnelle d'un citoyen. */
  readonly canteenCapacity: number;
  /** Coût en PA d'un déplacement entre deux cases adjacentes. */
  readonly moveActionPointCost: number;
  /** Coût en PA d'une fouille de zone. */
  readonly scavengeZoneActionPointCost: number;
  /** Coût en PA d'un combat contre un zombie. */
  readonly fightActionPointCost: number;
  /** Probabilité (0..1) qu'un combat tue le citoyen — déterministe (Rng seedé). */
  readonly fightFatalityChance: number;
  /**
   * Probabilité de base (0..1) qu'un événement apparaisse sur une zone donnée à
   * chaque tirage journalier. Elle est multipliée par la distance à la ville :
   * les confins du désert sont bien plus mouvementés que les abords.
   */
  readonly eventBaseChance: number;
}

/** Configuration par défaut du désert. */
export const DEFAULT_DESERT_CONFIG: DesertConfig = {
  radius: 3,
  canteenCapacity: 3,
  moveActionPointCost: 1,
  scavengeZoneActionPointCost: 2,
  fightActionPointCost: 1,
  fightFatalityChance: 0.0,
  eventBaseChance: 0.08,
};

/** Index canonique d'une coordonnée (clé de la map des zones). */
export function zoneKey(x: number, y: number): string {
  return `${x},${y}`;
}

/** Calcule la distance Chebyshev entre une coordonnée et la ville. */
export function distanceFromTown(x: number, y: number): number {
  return Math.max(Math.abs(x), Math.abs(y));
}

/** `true` si (x, y) est la position de la ville. */
export function isTown(x: number, y: number): boolean {
  return x === 0 && y === 0;
}

/** `true` si les deux coordonnées sont adjacentes (incluant diagonales) et distinctes. */
export function isAdjacent(ax: number, ay: number, bx: number, by: number): boolean {
  if (ax === bx && ay === by) return false;
  return Math.abs(ax - bx) <= 1 && Math.abs(ay - by) <= 1;
}

/**
 * Génère une carte du désert pour un rayon et une seed donnés. La distribution
 * des terrains, du loot et des zombies est figée par la seed.
 */
export function generateDesertMap(
  seed: number,
  config: DesertConfig = DEFAULT_DESERT_CONFIG,
): DesertMap {
  const rng = mulberry32(seed);
  const zones: Record<string, DesertZone> = {};
  for (let x = -config.radius; x <= config.radius; x++) {
    for (let y = -config.radius; y <= config.radius; y++) {
      if (isTown(x, y)) continue;
      const distance = distanceFromTown(x, y);
      const terrain = rollTerrain(rng, distance);
      const loot = rollLoot(rng, terrain, distance);
      const zombies = rollZombies(rng, distance);
      zones[zoneKey(x, y)] = {
        x,
        y,
        distance,
        terrain,
        loot,
        zombies,
        discovered: false,
        event: null,
      };
    }
  }
  const map: DesertMap = { seed, radius: config.radius, zones };
  // Premier jour de partie : la carte porte déjà quelques événements.
  assignZoneEvents(map, 1, config);
  return map;
}

/**
 * Sanitize un objet libre (issu d'un JSONB hydraté en base ou d'un snapshot
 * importé) vers une `DesertMap` strictement typée. Si la forme est invalide,
 * regénère une carte depuis la seed. Garantit l'absence de zone (0,0).
 */
export function sanitizeDesertMap(raw: unknown, fallbackSeed: number): DesertMap {
  if (!raw || typeof raw !== 'object') {
    return generateDesertMap(fallbackSeed);
  }
  const r = raw as { seed?: unknown; radius?: unknown; zones?: unknown };
  const seed =
    typeof r.seed === 'number' && Number.isFinite(r.seed) ? (r.seed >>> 0) : fallbackSeed;
  const radius =
    typeof r.radius === 'number' && r.radius >= 1 && r.radius <= 8
      ? Math.trunc(r.radius)
      : DEFAULT_DESERT_CONFIG.radius;
  const zonesRaw = r.zones && typeof r.zones === 'object' ? (r.zones as Record<string, unknown>) : {};
  const zones: Record<string, DesertZone> = {};
  for (let x = -radius; x <= radius; x++) {
    for (let y = -radius; y <= radius; y++) {
      if (isTown(x, y)) continue;
      const key = zoneKey(x, y);
      const candidate = zonesRaw[key];
      const zone = sanitizeZone(candidate, x, y);
      if (zone) zones[key] = zone;
    }
  }
  if (Object.keys(zones).length === 0) {
    return generateDesertMap(seed, { ...DEFAULT_DESERT_CONFIG, radius });
  }
  return { seed, radius, zones };
}

function sanitizeZone(raw: unknown, x: number, y: number): DesertZone | null {
  const rng = mulberry32(seedFromString(`fallback-${x}-${y}`));
  const distance = distanceFromTown(x, y);
  if (!raw || typeof raw !== 'object') {
    return {
      x,
      y,
      distance,
      terrain: rollTerrain(rng, distance),
      loot: rollLoot(rng, 'plain', distance),
      zombies: 0,
      discovered: false,
      event: null,
    };
  }
  const r = raw as {
    terrain?: unknown;
    loot?: unknown;
    zombies?: unknown;
    discovered?: unknown;
    event?: unknown;
  };
  const terrain = isZoneTerrain(r.terrain) ? r.terrain : rollTerrain(rng, distance);
  const lootRaw = r.loot && typeof r.loot === 'object' ? (r.loot as Record<string, unknown>) : {};
  const loot: ZoneLoot = {
    wood: clampNonNegInt(lootRaw.wood),
    metal: clampNonNegInt(lootRaw.metal),
    water: clampNonNegInt(lootRaw.water),
  };
  const zombies = clampNonNegInt(r.zombies);
  const discovered = r.discovered === true;
  const event = sanitizeEvent(r.event);
  return { x, y, distance, terrain, loot, zombies, discovered, event };
}

function sanitizeEvent(raw: unknown): ZoneEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { kind?: unknown; stash?: unknown };
  if (!isZoneEventKind(r.kind)) return null;
  const stashRaw = r.stash && typeof r.stash === 'object' ? (r.stash as Record<string, unknown>) : {};
  const stash: ZoneLoot = {
    wood: clampNonNegInt(stashRaw.wood),
    metal: clampNonNegInt(stashRaw.metal),
    water: clampNonNegInt(stashRaw.water),
  };
  return { kind: r.kind, stash };
}

function isZoneEventKind(v: unknown): v is ZoneEventKind {
  return (
    v === 'survivor-cache' ||
    v === 'abandoned-vehicle' ||
    v === 'zombie-nest' ||
    v === 'sandstorm'
  );
}

function isZoneTerrain(v: unknown): v is ZoneTerrain {
  return v === 'plain' || v === 'ruins' || v === 'highway' || v === 'wasteland';
}

function clampNonNegInt(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
  return Math.max(0, Math.trunc(v));
}

/** Renvoie une copie superficielle de la carte (zones immuables, mais cards muables). */
export function cloneDesertMap(map: DesertMap): DesertMap {
  const zones: Record<string, DesertZone> = {};
  for (const [key, z] of Object.entries(map.zones)) {
    zones[key] = {
      ...z,
      loot: { ...z.loot },
      event: z.event ? { kind: z.event.kind, stash: { ...z.event.stash } } : null,
    };
  }
  return { seed: map.seed, radius: map.radius, zones };
}

/** Renvoie la zone à (x, y) ou `undefined` (ville ou hors carte). */
export function getZone(map: DesertMap, x: number, y: number): DesertZone | undefined {
  return map.zones[zoneKey(x, y)];
}

/** Toutes les zones de la carte, triées par (y, x) pour un affichage stable. */
export function listZones(map: DesertMap): DesertZone[] {
  return Object.values(map.zones).slice().sort((a, b) => {
    if (a.y !== b.y) return a.y - b.y;
    return a.x - b.x;
  });
}

/** Choisit le terrain en fonction de la distance à la ville (pondéré). */
function rollTerrain(rng: Rng, distance: number): ZoneTerrain {
  if (distance === 1) {
    return rng.weighted([
      { value: 'plain' as ZoneTerrain, weight: 5 },
      { value: 'ruins' as ZoneTerrain, weight: 3 },
      { value: 'highway' as ZoneTerrain, weight: 2 },
    ]);
  }
  if (distance === 2) {
    return rng.weighted([
      { value: 'plain' as ZoneTerrain, weight: 3 },
      { value: 'ruins' as ZoneTerrain, weight: 4 },
      { value: 'highway' as ZoneTerrain, weight: 2 },
      { value: 'wasteland' as ZoneTerrain, weight: 1 },
    ]);
  }
  return rng.weighted([
    { value: 'plain' as ZoneTerrain, weight: 1 },
    { value: 'ruins' as ZoneTerrain, weight: 3 },
    { value: 'highway' as ZoneTerrain, weight: 2 },
    { value: 'wasteland' as ZoneTerrain, weight: 4 },
  ]);
}

/** Génère un stock de loot pour une zone, plus généreux loin de la ville. */
function rollLoot(rng: Rng, terrain: ZoneTerrain, distance: number): ZoneLoot {
  const base = 2 + distance;
  const biases: Record<ZoneTerrain, [number, number, number]> = {
    plain: [3, 1, 2],
    ruins: [2, 3, 1],
    highway: [1, 2, 3],
    wasteland: [4, 4, 1],
  };
  const [wW, wM, wT] = biases[terrain];
  const wood = rng.nextInt(0, Math.max(1, base) + wW);
  const metal = rng.nextInt(0, Math.max(1, base) + wM);
  const water = rng.nextInt(0, Math.max(1, Math.floor(base / 2)) + wT);
  return { wood, metal, water };
}

/** Nombre de zombies errants présents à la génération. */
function rollZombies(rng: Rng, distance: number): number {
  if (distance <= 1) return 0;
  const max = distance === 2 ? 2 : 3;
  return rng.nextInt(0, max + 1);
}

/**
 * Tic d'aube sur la carte : nouveaux zombies errants, et un petit refresh de
 * loot dans certaines zones (un objet réapparaît au hasard).
 *
 * Cette fonction est **pure** : elle modifie la carte fournie. Appelée par
 * `Game.dawn()` après la résolution d'une nuit.
 */
export function dawnTickDesert(map: DesertMap, day: number): void {
  const rng = mulberry32(seedFromString(`dawn-${map.seed}-${day}`));
  const zones = listZones(map);
  if (!zones.length) return;
  // Nouveaux zombies : ~1 par jour + 1 tous les 3 jours, projetés sur les
  // zones lointaines.
  const spawns = 1 + Math.floor(day / 3);
  for (let i = 0; i < spawns; i++) {
    const candidates = zones.filter((z) => z.distance >= 2);
    if (!candidates.length) break;
    const target = candidates[rng.nextInt(0, candidates.length)]!;
    target.zombies += 1;
  }
  // Reprise du loot : 25% de chances qu'une zone retrouve 1 unité d'une
  // ressource cohérente avec son terrain. Plafond `2 * distance` pour éviter
  // l'inflation.
  for (const zone of zones) {
    if (rng.next() < 0.25) {
      const kind: ResourceKind = rng.weighted([
        { value: 'wood' as ResourceKind, weight: zone.terrain === 'plain' ? 3 : 1 },
        { value: 'metal' as ResourceKind, weight: zone.terrain === 'ruins' ? 3 : 1 },
        { value: 'water' as ResourceKind, weight: zone.terrain === 'highway' ? 2 : 1 },
      ]);
      const cap = 2 * Math.max(1, zone.distance);
      if (zone.loot[kind] < cap) zone.loot[kind] += 1;
    }
  }
  // La carte vit aussi au rythme des événements (Jalon 4).
  assignZoneEvents(map, day);
}

/**
 * (Ré)assigne les événements de zone pour le jour de partie donné (Jalon 4).
 * Déterministe : le tirage dépend uniquement de la seed de carte et du jour.
 *
 * Règles :
 *   - Les **tempêtes de sable** sont éphémères : elles se dissipent à chaque
 *     nouvel appel (nouveau jour), libérant la zone pour un nouveau tirage.
 *   - Les événements **persistants** (cache, véhicule, nid) sont conservés tant
 *     qu'ils n'ont pas été consommés par les joueurs (`lootEvent` vide la cache
 *     / le véhicule ; chasser tous les zombies détruit le nid — voir `Game`).
 *     Une zone qui en porte encore un est donc *sautée* (pas de re-tirage), ce
 *     qui évite l'empilement et le farm involontaire.
 *   - Une zone libre tire un événement avec une probabilité croissante avec la
 *     distance à la ville (`eventBaseChance × distance`).
 *   - Un **nid** engendre immédiatement sa nuée de zombies ; il n'apparaît
 *     jamais aux abords immédiats de la ville (distance 1, cohérent avec la
 *     génération de zombies).
 */
export function assignZoneEvents(
  map: DesertMap,
  day: number,
  config: DesertConfig = DEFAULT_DESERT_CONFIG,
): void {
  const rng = mulberry32(seedFromString(`events-${map.seed}-${day}`));
  for (const zone of listZones(map)) {
    // 1. Dissipation des tempêtes (événement transitoire).
    if (zone.event && zone.event.kind === 'sandstorm') {
      zone.event = null;
    }
    // 2. Un événement persistant occupe encore la zone : on n'y touche pas.
    if (zone.event) continue;
    // 3. Tirage d'un nouvel événement.
    const chance = Math.min(0.6, config.eventBaseChance * zone.distance);
    if (rng.next() >= chance) continue;
    const kind = rollEventKind(rng, zone.distance);
    zone.event = createEvent(rng, kind, zone.distance);
    if (kind === 'zombie-nest') {
      // Le nid pond sa nuée : ces zombies devront être chassés avant toute
      // fouille (et leur extinction détruit le nid, côté moteur de jeu).
      zone.zombies += 2 + Math.max(0, zone.distance - 1);
    }
  }
}

/** Choisit la nature d'un événement, pondérée par la distance à la ville. */
function rollEventKind(rng: Rng, distance: number): ZoneEventKind {
  return rng.weighted([
    { value: 'survivor-cache' as ZoneEventKind, weight: 3 },
    { value: 'abandoned-vehicle' as ZoneEventKind, weight: 1 + distance },
    { value: 'sandstorm' as ZoneEventKind, weight: 2 },
    // Pas de nid aux abords immédiats (distance 1) : cohérent avec l'absence de
    // zombies errants générés à cette distance.
    { value: 'zombie-nest' as ZoneEventKind, weight: distance >= 2 ? distance : 0 },
  ]);
}

/** Construit l'événement (et son éventuel magot) pour une nature donnée. */
function createEvent(rng: Rng, kind: ZoneEventKind, distance: number): ZoneEvent {
  if (kind === 'survivor-cache') {
    // Cache de survivant : réserves équilibrées, tournées vers la survie (eau).
    return {
      kind,
      stash: {
        wood: rng.nextInt(1, 3 + distance),
        metal: rng.nextInt(1, 2 + distance),
        water: rng.nextInt(2, 4 + distance),
      },
    };
  }
  if (kind === 'abandoned-vehicle') {
    // Véhicule abandonné : épave riche en métal, peu en eau.
    return {
      kind,
      stash: {
        wood: rng.nextInt(1, 3),
        metal: rng.nextInt(3, 6 + distance),
        water: rng.nextInt(0, 2),
      },
    };
  }
  // Nid / tempête : aucun magot direct.
  return { kind, stash: { wood: 0, metal: 0, water: 0 } };
}

/**
 * Tire un objet à ramasser dans une zone. Décrémente la zone et renvoie la
 * ressource récoltée, ou `undefined` si la zone est vide. La sélection
 * pondère par le stock restant : on prend ce qui est disponible.
 */
export function takeFromZone(rng: Rng, zone: DesertZone): ResourceKind | undefined {
  const choices: Array<{ value: ResourceKind; weight: number }> = [];
  if (zone.loot.wood > 0) choices.push({ value: 'wood', weight: zone.loot.wood });
  if (zone.loot.metal > 0) choices.push({ value: 'metal', weight: zone.loot.metal });
  if (zone.loot.water > 0) choices.push({ value: 'water', weight: zone.loot.water });
  if (!choices.length) return undefined;
  const picked = rng.weighted(choices);
  zone.loot[picked] = Math.max(0, zone.loot[picked] - 1);
  return picked;
}
