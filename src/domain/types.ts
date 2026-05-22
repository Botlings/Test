/**
 * Types du domaine de jeu de Hordes Revival.
 *
 * Le jeu est une survie coopérative : une ville d'humains tient face aux
 * hordes de zombies. La boucle se déroule en journées découpées en deux
 * phases — `day` (exploration et construction) puis `night` (assaut de la
 * horde résolu automatiquement).
 */

/** Phase courante d'une journée de jeu. */
export type Phase = 'day' | 'night';

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
  /** Renseigné uniquement si `alive === false`. */
  causeOfDeath?: string;
}

/** Décès survenu lors de la résolution d'une nuit (ou de l'aube qui suit). */
export interface Death {
  readonly citizenId: string;
  readonly name: string;
  readonly cause: string;
}

/** Compte rendu de la résolution d'une nuit. */
export interface NightReport {
  /** Numéro du jour dont la nuit vient d'être résolue. */
  readonly day: number;
  /** Puissance d'attaque de la horde cette nuit. */
  readonly hordePower: number;
  /** Défense totale de la ville opposée à la horde. */
  readonly townDefense: number;
  /** `true` si la horde a percé les défenses de la ville. */
  readonly breached: boolean;
  readonly deaths: readonly Death[];
  /** Nombre de citoyens encore en vie après la nuit et l'aube. */
  readonly survivors: number;
  /** `true` si plus aucun citoyen n'est en vie : la partie est terminée. */
  readonly gameOver: boolean;
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
}
