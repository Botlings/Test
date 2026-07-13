/**
 * Catalogue des hauts faits (achievements) de Hordes Revival et logique pure
 * de déblocage.
 *
 * Un haut fait est un badge permanent gagné par un *compte* (pas une ville).
 * Il récompense un jalon marquant de la survie : première construction, premier
 * butin arraché au désert, nuit repoussée, semaine tenue, ville sauvée.
 *
 * Ce module est PUR (aucune I/O) : il fournit le catalogue affichable et des
 * évaluateurs qui, à partir d'un contexte de jeu, renvoient la liste des
 * badges à débloquer. La persistance (idempotente, « on ne débloque qu'une
 * fois ») est du ressort du `Store` ; le déclenchement au bon moment est du
 * ressort des routes serveur.
 */
import type { GameOutcome } from './types.js';

/** Identifiant stable d'un haut fait (jamais renommé : sert de clé persistée). */
export type AchievementId =
  | 'first-builder'
  | 'explorer'
  | 'night-hero'
  | 'survivor-7'
  | 'victor';

/** Définition affichable d'un haut fait. */
export interface AchievementDef {
  readonly id: AchievementId;
  /** Nom court affiché sur le badge. */
  readonly name: string;
  /** Phrase expliquant l'exploit récompensé. */
  readonly description: string;
  /** Comment l'obtenir (indice pour un badge encore verrouillé). */
  readonly hint: string;
  /** Emoji/pictogramme du badge (rendu partout, aucun asset distant). */
  readonly icon: string;
}

/**
 * Catalogue canonique, dans l'ordre de progression naturelle d'une partie.
 * L'ordre est celui d'affichage sur la page profil.
 */
export const ACHIEVEMENT_CATALOG: readonly AchievementDef[] = [
  {
    id: 'first-builder',
    name: 'Premier Bâtisseur',
    description: 'Vous avez érigé votre première construction pour renforcer la ville.',
    hint: 'Construisez un renfort ou un bâtiment depuis la ville.',
    icon: '🔨',
  },
  {
    id: 'explorer',
    name: 'Pilleur du Désert',
    description: 'Vous avez rapporté votre premier butin arraché aux étendues désolées.',
    hint: 'Fouillez une zone du désert ou pillez une épave / une cache.',
    icon: '🎒',
  },
  {
    id: 'night-hero',
    name: 'Héros Nocturne',
    description: 'Vous avez survécu à un assaut de la horde sans que les murs ne cèdent.',
    hint: 'Tenez une nuit d\'attaque sans laisser la horde percer les défenses.',
    icon: '🌙',
  },
  {
    id: 'survivor-7',
    name: 'Survivant 7 jours',
    description: 'Vous avez tenu jusqu\'à la septième nuit et survécu à son assaut.',
    hint: 'Restez en vie jusqu\'à la nuit du jour 7.',
    icon: '🛡️',
  },
  {
    id: 'victor',
    name: 'Sauveur de la Ville',
    description: 'Votre ville a tenu le nombre de nuits requis : la partie est gagnée.',
    hint: 'Remportez une partie en survivant à la dernière nuit.',
    icon: '🏆',
  },
] as const;

const CATALOG_BY_ID: ReadonlyMap<AchievementId, AchievementDef> = new Map(
  ACHIEVEMENT_CATALOG.map((def) => [def.id, def] as const),
);

/** Renvoie la définition d'un haut fait, ou `undefined` si l'id est inconnu. */
export function getAchievementDef(id: string): AchievementDef | undefined {
  return CATALOG_BY_ID.get(id as AchievementId);
}

/** Garde de type : `id` est-il un identifiant de haut fait connu ? */
export function isKnownAchievementId(id: string): id is AchievementId {
  return CATALOG_BY_ID.has(id as AchievementId);
}

/**
 * Hauts faits gagnés par une action de construction (générique `build` ou
 * bâtiment du catalogue). Toujours « Premier Bâtisseur » — la persistance
 * garantit qu'il n'est débloqué qu'une seule fois.
 */
export function buildAchievements(): AchievementId[] {
  return ['first-builder'];
}

/**
 * Hauts faits gagnés en rapportant du butin du désert : fouille d'une zone
 * (ressource ou objet trouvé) ou pillage d'un événement (épave, cache).
 */
export function scavengeAchievements(gained: {
  /** Une ressource (bois/métal/eau) a-t-elle été récoltée ? */
  readonly resource?: boolean;
  /** Un objet du désert a-t-il été trouvé ? */
  readonly item?: boolean;
  /** Un événement de zone (épave / cache) a-t-il été pillé ? */
  readonly event?: boolean;
}): AchievementId[] {
  if (gained.resource || gained.item || gained.event) return ['explorer'];
  return [];
}

/**
 * Hauts faits gagnés par un citoyen donné à l'issue d'une nuit résolue.
 *
 * Les critères sont RELATIFS à ce que le citoyen a réellement vécu :
 *   - `night-hero` : le citoyen est encore en vie ET la horde a bien attaqué
 *     (`hordePower > 0`) ET les murs n'ont pas été percés (`!breached`).
 *   - `survivor-7` : le citoyen est en vie et la nuit résolue est au moins la
 *     septième (il a donc traversé une semaine complète d'assauts).
 *   - `victor`     : la partie s'est conclue par une victoire et le citoyen
 *     fait partie des survivants.
 */
export function nightAchievements(ctx: {
  /** Numéro du jour dont la nuit vient d'être résolue. */
  readonly nightDay: number;
  /** Puissance effective de la horde cette nuit. */
  readonly hordePower: number;
  /** Les défenses ont-elles cédé ? */
  readonly breached: boolean;
  /** Issue de la partie après cette nuit. */
  readonly outcome: GameOutcome;
  /** Le citoyen de ce compte est-il vivant après la nuit ? */
  readonly citizenAlive: boolean;
}): AchievementId[] {
  const earned: AchievementId[] = [];
  if (!ctx.citizenAlive) return earned;
  if (ctx.hordePower > 0 && !ctx.breached) earned.push('night-hero');
  if (ctx.nightDay >= 7) earned.push('survivor-7');
  if (ctx.outcome === 'victory') earned.push('victor');
  return earned;
}
