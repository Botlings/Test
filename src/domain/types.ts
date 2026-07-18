/**
 * Types du domaine de jeu de Hordes Revival.
 *
 * Le jeu est une survie coopérative : une ville d'humains tient face aux
 * hordes de zombies. La boucle se déroule en journées découpées en deux
 * phases — `day` (exploration et construction) puis `night` (assaut de la
 * horde résolu automatiquement).
 */

import type { NightThreatCounts } from './zombies.js';

/** Phase courante d'une journée de jeu. */
export type Phase = 'day' | 'night';

/**
 * Issue d'une partie.
 *   - `ongoing` : la partie continue.
 *   - `victory` : la ville a survécu au nombre de nuits requis (`survivalDays`).
 *   - `defeat`  : tous les citoyens sont morts (la ville est tombée).
 */
export type GameOutcome = 'ongoing' | 'victory' | 'defeat';

/** Position d'un citoyen : à l'abri en ville, ou exposé dans le désert. */
export type Location = 'town' | 'desert';

/** Ressources collectables et stockées dans la banque de la ville. */
export type ResourceKind = 'wood' | 'metal' | 'water';

/** Stock de ressources de la ville. */
export type ResourceBank = Record<ResourceKind, number>;

/** Un joueur de la ville. */
export interface Citizen {
  readonly id: string;
  readonly name: string;
  alive: boolean;
  location: Location;
  /** Points d'action restants pour la journée courante. */
  actionPoints: number;
  /** Nombre de jours consécutifs sans avoir pu boire. */
  consecutiveThirstDays: number;
  /**
   * Position du citoyen dans le désert (case (x, y)). `null` quand il est
   * réfugié en ville. La cohérence avec `location` est maintenue par le
   * moteur : `location === 'desert'` ⇔ `position !== null`.
   */
  position: { x: number; y: number } | null;
  /**
   * Eau personnelle (gourde). Consommée à chaque fouille en zone et rechargée
   * à l'aube quand le citoyen passe la nuit en ville et que la banque a de
   * l'eau. Capacité plafonnée par `DesertConfig.canteenCapacity`.
   */
  waterCanteen: number;
  /** Renseigné uniquement si `alive === false`. */
  causeOfDeath?: string;
}

/** Catégorie d'origine d'un décès — sert au tri narratif du rapport. */
export type DeathSource = 'desert' | 'watch' | 'breach' | 'dehydration';

/** Décès survenu lors de la résolution d'une nuit (ou de l'aube qui suit). */
export interface Death {
  readonly citizenId: string;
  readonly name: string;
  readonly cause: string;
  readonly source: DeathSource;
}

/** Décomposition de la défense totale opposée à la horde. */
export interface DefenseBreakdown {
  /** Défense provenant des murs et constructions de la ville (base + bonus de bâtiments). */
  readonly walls: number;
  /** Défense apportée par les citoyens en faction (présents en ville la nuit). */
  readonly watchers: number;
  /** Nombre de citoyens vivants en ville au moment de la résolution. */
  readonly watcherCount: number;
  /** Bonus de défense fourni par les bâtiments (subdivision de `walls`). */
  readonly buildingsWallBonus: number;
  /** Bonus de défense par guetteur fourni par les bâtiments (subdivision de `watchers`). */
  readonly buildingsWatchBonus: number;
  /**
   * Défense de mur perforée par les colosses (`brute`) — soustraite du total.
   * `0` si aucun colosse dans la horde.
   */
  readonly wallsPenetrated: number;
  /**
   * Défense de guetteurs annulée par les rôdeurs rapides (`prowler`) —
   * soustraite du total. `0` si aucun rôdeur ou aucun guetteur en faction.
   */
  readonly watchersNegated: number;
  /** Défense effective : `walls - wallsPenetrated + watchers - watchersNegated`. */
  readonly total: number;
}

/** Bilan du sabotage nocturne infligé par les zombies `sapper` (Sournois). */
export interface SabotageReport {
  /** Défense de mur détruite durablement cette nuit. */
  readonly defenseLost: number;
  /** Ressources dérobées à la banque. */
  readonly looted: { readonly wood: number; readonly metal: number; readonly water: number };
}

/**
 * Une vague de la horde. La horde frappe en trois vagues successives : si la
 * défense totale n'absorbe pas la vague, le surplus passe sur les habitants.
 * Les vagues sont déterministes (poids fixes) — elles servent à raconter le
 * déroulé de la nuit au joueur.
 */
export interface AttackWave {
  /** Numéro de la vague (1, 2, 3). */
  readonly index: number;
  /** Puissance d'attaque de cette vague. */
  readonly attack: number;
  /** Quantité absorbée par la défense de la ville. */
  readonly absorbed: number;
  /** Surplus passé au travers des défenses (contribue aux décès). */
  readonly overflow: number;
}

/** Décès groupés par origine — pratique pour l'affichage joueur. */
export interface DeathsBySource {
  readonly desert: number;
  readonly watch: number;
  readonly breach: number;
  readonly dehydration: number;
}

/** Compte rendu de la résolution d'une nuit. */
export interface NightReport {
  /** Numéro du jour dont la nuit vient d'être résolue. */
  readonly day: number;
  /**
   * Puissance d'attaque effective de la horde cette nuit (après amplification
   * des hurleurs et retranchement des pièges). La somme des `waves` la vaut.
   */
  readonly hordePower: number;
  /** Puissance de horde brute, avant zombies spéciaux et pièges. */
  readonly baseHordePower: number;
  /** Composition en zombies spéciaux de la horde de la nuit. */
  readonly threats: NightThreatCounts;
  /** Puissance de horde neutralisée par les pièges (avant l'assaut). */
  readonly hordeDeterrence: number;
  /** Sabotage infligé par les Sournois, ou `null` si aucun. */
  readonly sabotage: SabotageReport | null;
  /** Défense totale de la ville opposée à la horde (alias de `defense.total`). */
  readonly townDefense: number;
  /** Détail des sources de défense. */
  readonly defense: DefenseBreakdown;
  /** Découpe narrative de l'assaut en trois vagues. */
  readonly waves: readonly AttackWave[];
  /** Surplus cumulé qui a franchi les défenses. */
  readonly overflow: number;
  /** `true` si la horde a percé les défenses de la ville. */
  readonly breached: boolean;
  readonly deaths: readonly Death[];
  /** Décès groupés par cause (pour l'affichage). */
  readonly deathsBySource: DeathsBySource;
  /**
   * Eau récupérée sur les gourdes des citoyens tombés à l'abri (dans les murs)
   * et reversée à la banque commune cette nuit. Les corps abandonnés au désert
   * emportent leur eau : seuls les morts en ville alimentent ce total.
   */
  readonly salvagedWater: number;
  /** Nombre de citoyens encore en vie après la nuit et l'aube. */
  readonly survivors: number;
  /** `true` si la partie est terminée (ville tombée OU survie complète). */
  readonly gameOver: boolean;
  /**
   * Issue de la partie après cette nuit : `ongoing` tant qu'elle continue,
   * `victory` si la ville a tenu le nombre de nuits requis, `defeat` si elle
   * est tombée.
   */
  readonly outcome: GameOutcome;
  /** Horodatage ISO de la résolution (utile au client pour trier l'historique). */
  readonly resolvedAt: string;
}

/** Nature d'un événement de zone (Jalon 4). */
export type ZoneEventKind =
  | 'survivor-cache'
  | 'abandoned-vehicle'
  | 'zombie-nest'
  | 'sandstorm';

/** Événement de zone exposé à l'API publique. */
export interface ZoneEventSnapshot {
  readonly kind: ZoneEventKind;
  readonly stash: { readonly wood: number; readonly metal: number; readonly water: number };
}

/** Une zone du désert exposée à l'API publique (forme allégée). */
export interface DesertZoneSnapshot {
  readonly x: number;
  readonly y: number;
  readonly distance: number;
  readonly terrain: 'plain' | 'ruins' | 'highway' | 'wasteland';
  readonly loot: { readonly wood: number; readonly metal: number; readonly water: number };
  readonly zombies: number;
  readonly discovered: boolean;
  /** Événement actif sur la zone, ou `null`. */
  readonly event: ZoneEventSnapshot | null;
}

/** Vue publique de la carte du désert. */
export interface DesertSnapshot {
  readonly radius: number;
  readonly zones: readonly DesertZoneSnapshot[];
}

/** État public complet d'une partie. */
export interface GameStatus {
  readonly day: number;
  readonly phase: Phase;
  readonly townDefense: number;
  readonly bank: ResourceBank;
  readonly citizens: readonly Citizen[];
  readonly aliveCount: number;
  readonly hordePowerTonight: number;
  readonly gameOver: boolean;
  /** Issue de la partie (`ongoing` tant qu'elle n'est pas terminée). */
  readonly outcome: GameOutcome;
  /** Nombre de nuits à survivre pour gagner la partie. */
  readonly survivalDays: number;
  /** Compteur d'instances par bâtiment construit (catalogue `buildings.ts`). */
  readonly buildings: Readonly<Record<string, number>>;
  /** Stock d'objets du désert (catalogue `items.ts`), indexé par id. */
  readonly items: Readonly<Record<string, number>>;
  /** Composition en zombies spéciaux prévue pour l'assaut de la nuit à venir. */
  readonly threatsTonight: NightThreatCounts;
  /** Carte du désert (rayon + zones). */
  readonly desert: DesertSnapshot;
}
