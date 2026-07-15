/**
 * Types de zombies spéciaux de l'assaut nocturne (extension de la mécanique de
 * horde de Hordes Revival).
 *
 * La horde de base est un scalaire de puissance (`hordePower`) qui grimpe jour
 * après jour. À partir de nuits avancées, des **zombies spéciaux** rejoignent la
 * horde, chacun avec un comportement distinct qui modifie la résolution :
 *
 *   - `brute`    (Colosse blindé) : blindé. Perce une part de la défense des
 *                             MURS (ignore le blindage des remparts). N'affecte
 *                             pas les guetteurs.
 *   - `prowler`  (Rôdeur rapide) : sprinteur. Frappe avant que les guetteurs
 *                             n'aient pris position : annule une part de la
 *                             défense des GUETTEURS (symétrique du colosse sur
 *                             les murs). Sans effet si personne ne monte la garde.
 *   - `sapper`   (Sournois) : saboteur. Pille la banque de ressources ET érode
 *                             durablement la défense des murs (dégâts qui
 *                             persistent au-delà de la nuit — il faut réparer).
 *   - `screamer` (Hurleur)  : attire ses congénères. Amplifie la puissance de la
 *                             horde de la nuit (un pourcentage de la horde de
 *                             base par hurleur).
 *
 * La **composition** d'une nuit est purement déterministe (fonction du jour de
 * partie et de la config) : aucun RNG, pour des tests reproductibles et un
 * verdict prévisible. Les zombies spéciaux n'apparaissent jamais avant leur
 * `startDay` respectif (par défaut ≥ jour 3), ce qui laisse les premières nuits
 * identiques à la mécanique historique.
 */

/** Nature d'un zombie spécial de la horde nocturne. */
export type NightThreatKind = 'brute' | 'prowler' | 'sapper' | 'screamer';

/** Comptes de zombies spéciaux composant une horde d'une nuit. */
export interface NightThreatCounts {
  readonly brute: number;
  readonly prowler: number;
  readonly sapper: number;
  readonly screamer: number;
}

/** Horde vierge de tout zombie spécial (nuits calmes). */
export const NO_THREATS: NightThreatCounts = {
  brute: 0,
  prowler: 0,
  sapper: 0,
  screamer: 0,
};

/** Planning d'apparition d'un type de zombie spécial. */
export interface ThreatSchedule {
  /** Premier jour de partie où ce type peut apparaître. */
  readonly startDay: number;
  /** Une unité supplémentaire tous les `everyDays` jours après `startDay`. */
  readonly everyDays: number;
}

/** Paramètres d'un `brute` (Colosse blindé) : blindage perforant. */
export interface BruteConfig extends ThreatSchedule {
  /** Points de défense de MUR ignorés (perforés) par colosse. */
  readonly wallPiercePerZombie: number;
}

/** Paramètres d'un `prowler` (Rôdeur rapide) : vitesse qui prend les guetteurs de vitesse. */
export interface ProwlerConfig extends ThreatSchedule {
  /** Points de défense de GUETTEURS annulés par rôdeur (borné au total des guetteurs). */
  readonly watchNegationPerZombie: number;
}

/** Paramètres d'un `sapper` (Sournois) : pillage + sabotage. */
export interface SapperConfig extends ThreatSchedule {
  /** Ressources dérobées à la banque par saboteur (bois/métal/eau confondus). */
  readonly bankLootPerZombie: number;
  /** Défense de mur détruite durablement par saboteur. */
  readonly sabotagePerZombie: number;
}

/** Paramètres d'un `screamer` (Hurleur) : amplification de la horde. */
export interface ScreamerConfig extends ThreatSchedule {
  /** Fraction (0..1) de la horde de base ajoutée par hurleur. */
  readonly hordePctPerZombie: number;
}

/** Bloc de configuration des zombies spéciaux (intégré à `GameConfig`). */
export interface ZombieConfig {
  readonly brute: BruteConfig;
  readonly prowler: ProwlerConfig;
  readonly sapper: SapperConfig;
  readonly screamer: ScreamerConfig;
}

/** Configuration par défaut des zombies spéciaux — montée en pression douce. */
export const DEFAULT_ZOMBIE_CONFIG: ZombieConfig = {
  brute: { startDay: 3, everyDays: 3, wallPiercePerZombie: 8 },
  prowler: { startDay: 5, everyDays: 4, watchNegationPerZombie: 4 },
  sapper: { startDay: 4, everyDays: 3, bankLootPerZombie: 3, sabotagePerZombie: 3 },
  screamer: { startDay: 5, everyDays: 4, hordePctPerZombie: 0.2 },
};

/** Métadonnées d'affichage d'un type de zombie spécial. */
export interface NightThreatDef {
  readonly kind: NightThreatKind;
  readonly name: string;
  readonly icon: string;
  readonly description: string;
}

/** Catalogue descriptif des zombies spéciaux (pour l'UI / la doc). */
export const NIGHT_THREAT_CATALOG: readonly NightThreatDef[] = [
  {
    kind: 'brute',
    name: 'Colosse blindé',
    icon: '🧟‍♂️',
    description:
      'Masse de chair blindée qui enfonce les remparts : une part de la défense des murs ne compte plus contre lui.',
  },
  {
    kind: 'prowler',
    name: 'Rôdeur rapide',
    icon: '🏃',
    description:
      'Zombie fraîchement tourné, encore vif et endurant. Il fond sur les remparts avant que les guetteurs ne se mettent en position : une part de leur défense s\'évapore.',
  },
  {
    kind: 'sapper',
    name: 'Sournois',
    icon: '🩸',
    description:
      'Rôdeur saboteur qui se glisse dans la ville : pille la banque et endommage durablement les fortifications.',
  },
  {
    kind: 'screamer',
    name: 'Hurleur',
    icon: '📢',
    description:
      'Son cri porte à des lieues et rameute la horde : la puissance d\'attaque de la nuit s\'en trouve gonflée.',
  },
];

/** Compte d'un type sur un jour donné selon son planning. */
function scheduledCount(day: number, schedule: ThreatSchedule): number {
  if (day < schedule.startDay) return 0;
  const every = Math.max(1, schedule.everyDays);
  return 1 + Math.floor((day - schedule.startDay) / every);
}

/**
 * Composition déterministe de la horde spéciale pour un jour de partie donné.
 * Aucun aléa : purement fonction du jour et de la config.
 */
export function computeNightThreats(day: number, config: ZombieConfig): NightThreatCounts {
  return {
    brute: scheduledCount(day, config.brute),
    prowler: scheduledCount(day, config.prowler),
    sapper: scheduledCount(day, config.sapper),
    screamer: scheduledCount(day, config.screamer),
  };
}

/** `true` si la horde de la nuit comporte au moins un zombie spécial. */
export function hasThreats(counts: NightThreatCounts): boolean {
  return (
    counts.brute > 0 ||
    counts.prowler > 0 ||
    counts.sapper > 0 ||
    counts.screamer > 0
  );
}

/** Perforation de mur totale infligée par les colosses (bornée au mur dispo). */
export function bruteWallPierce(counts: NightThreatCounts, config: ZombieConfig, walls: number): number {
  const raw = counts.brute * config.brute.wallPiercePerZombie;
  return Math.max(0, Math.min(walls, raw));
}

/**
 * Défense de guetteurs annulée par les rôdeurs rapides (bornée au total des
 * guetteurs). Nul si aucun rôdeur ou aucun guetteur — garde les scénarios sans
 * garde (`watchers = 0`) strictement inchangés.
 */
export function prowlerWatchNegation(
  counts: NightThreatCounts,
  config: ZombieConfig,
  watchers: number,
): number {
  const raw = counts.prowler * config.prowler.watchNegationPerZombie;
  return Math.max(0, Math.min(watchers, raw));
}

/**
 * Bonus de puissance de horde apporté par les hurleurs : une fraction de la
 * horde de base par hurleur. Nul si la horde de base est nulle (garde les
 * scénarios « sans horde » strictement inchangés).
 */
export function screamerHordeBonus(
  baseHorde: number,
  counts: NightThreatCounts,
  config: ZombieConfig,
): number {
  if (baseHorde <= 0 || counts.screamer <= 0) return 0;
  return Math.round(baseHorde * config.screamer.hordePctPerZombie * counts.screamer);
}
