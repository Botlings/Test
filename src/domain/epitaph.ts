/**
 * Épitaphe d'un citoyen — mécanique de permadeath de Hordes Revival.
 *
 * Quand un joueur meurt, sa mort est définitive : il ne reste de lui qu'une
 * épitaphe, phrase mémorielle affichée sur la page profil (historique des
 * parties). La logique est pure et déterministe afin d'être calculée aussi
 * bien côté serveur (endpoint profil) que testée isolément.
 */
import type { GameOutcome } from './types.js';

/** Données minimales nécessaires pour composer une épitaphe. */
export interface EpitaphInput {
  /** Nom du citoyen. */
  readonly name: string;
  /** `true` si le citoyen est encore en vie (aucune épitaphe alors). */
  readonly alive: boolean;
  /** Cause de la mort telle que renseignée par le moteur, ou `null`. */
  readonly causeOfDeath: string | null;
  /** Jour atteint par la ville au moment du décès (≥ 1). */
  readonly daysSurvived: number;
  /** Issue de la partie du citoyen (contextualise le sacrifice). */
  readonly outcome: GameOutcome;
}

/**
 * Compose l'épitaphe d'un citoyen tombé. Renvoie `null` pour un survivant
 * (aucune pierre tombale tant qu'on respire). Déterministe : une même entrée
 * produit toujours la même phrase.
 */
export function buildEpitaph(input: EpitaphInput): string | null {
  if (input.alive) return null;
  const name = input.name.trim() || 'Un survivant anonyme';
  const cause = (input.causeOfDeath ?? '').trim() || 'emporté par la horde';
  const day = Number.isFinite(input.daysSurvived)
    ? Math.max(1, Math.trunc(input.daysSurvived))
    : 1;
  const nights = day - 1;
  const tenure =
    nights <= 0
      ? "sans avoir vu tomber la première nuit"
      : 'après ' + nights + ' nuit' + (nights > 1 ? 's' : '') + ' de veille';
  // Une chute lors d'une partie victorieuse est un martyre : la ville a tenu.
  const honor = input.outcome === 'victory' ? ' Sa ville a survécu.' : '';
  return 'Ci-gît ' + name + ', ' + cause + ', ' + tenure + '.' + honor;
}
