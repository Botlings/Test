import { DEFAULT_DESERT_CONFIG, type DesertConfig } from './desert.js';
import type { ResourceBank } from './types.js';

/**
 * Paramètres d'équilibrage d'une partie. Toutes les valeurs sont injectables
 * afin que les tests et de futurs modes de jeu puissent ajuster la difficulté.
 */
export interface GameConfig {
  /** Points d'action accordés à chaque citoyen au début d'une journée. */
  startingActionPoints: number;
  /** Stock de ressources de la ville au lancement de la partie. */
  startingBank: ResourceBank;
  /** Défense intrinsèque des murs de la ville, avant toute construction. */
  baseDefense: number;
  /** Puissance de la horde la première nuit (jour 1). */
  hordeBaseAttack: number;
  /** Puissance ajoutée à la horde à chaque jour qui passe. */
  hordeGrowthPerDay: number;
  /** Points de débordement de la horde nécessaires pour tuer un citoyen abrité. */
  killThreshold: number;
  /**
   * Défense apportée par chaque citoyen en faction (vivant, présent en ville)
   * la nuit. Les citoyens veillent sur les remparts ; ils renforcent la
   * défense mais sont aussi les premiers en première ligne en cas de percée.
   */
  watchDefensePerCitizen: number;
  /**
   * Poids des trois vagues de la horde (somme = 1). Détermine la répartition
   * narrative de l'attaque, sans changer l'arithmétique du verdict final.
   */
  hordeWaveWeights: readonly [number, number, number];
  /** Coût en points d'action d'une action de construction. */
  buildActionPointCost: number;
  /** Coût en ressources d'une action de construction. */
  buildResourceCost: { wood: number; metal: number };
  /** Défense ajoutée à la ville par action de construction. */
  defensePerBuildAction: number;
  /** Coût en points d'action d'une action de fouille. */
  scavengeActionPointCost: number;
  /** Ressources rapportées par une action de fouille dans le désert. */
  scavengeYield: ResourceBank;
  /** Paramètres de la carte du désert (rayon, gourde, coûts d'exploration). */
  desert: DesertConfig;
}

/** Configuration de partie par défaut, calibrée pour une montée en difficulté progressive. */
export const DEFAULT_CONFIG: GameConfig = {
  startingActionPoints: 6,
  startingBank: { wood: 20, metal: 10, water: 8 },
  baseDefense: 10,
  hordeBaseAttack: 12,
  hordeGrowthPerDay: 8,
  killThreshold: 15,
  watchDefensePerCitizen: 2,
  hordeWaveWeights: [0.45, 0.35, 0.2],
  buildActionPointCost: 1,
  buildResourceCost: { wood: 3, metal: 1 },
  defensePerBuildAction: 6,
  scavengeActionPointCost: 2,
  scavengeYield: { wood: 4, metal: 2, water: 1 },
  desert: DEFAULT_DESERT_CONFIG,
};
