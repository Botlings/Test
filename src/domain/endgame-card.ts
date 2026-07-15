/**
 * Carte de fin de partie partageable.
 *
 * Résume, sous une forme structurée et **pure** (aucune dépendance runtime ou
 * DOM), la partie d'un joueur : jours survécus, rôle tenu, objets récupérés,
 * bâtiments construits et surtout le **titre** attribué selon l'issue. Cette
 * synthèse alimente à la fois l'endpoint `GET /towns/:id/card` et le rendu PNG
 * côté client (canvas), tout en produisant le texte de partage prêt à publier
 * sur X / Reddit — vecteur d'acquisition organique.
 *
 * Le titre est déterministe : il ne dépend que de (issue, jours, survie), ce
 * qui le rend testable et reproductible d'une partie à l'autre.
 */
import type { GameOutcome } from './types.js';
import { getItemDef } from './items.js';
import { getBuildingDef } from './buildings.js';

/** Rôle du joueur dans la gouvernance de la ville. */
export type CardRole = 'founder' | 'manager' | 'citizen';

/** Une ligne d'inventaire (objet ou bâtiment) affichée sur la carte. */
export interface EndgameCardEntry {
  readonly id: string;
  readonly name: string;
  readonly icon: string;
  readonly count: number;
}

/** Données brutes nécessaires à la synthèse (extraites de l'état de jeu). */
export interface EndgameCardInput {
  readonly townName: string;
  readonly difficulty: string;
  readonly outcome: GameOutcome;
  readonly gameOver: boolean;
  /** Jour courant = nombre de nuits déjà traversées. */
  readonly daysSurvived: number;
  /** Nombre de nuits à tenir pour l'emporter. */
  readonly survivalDays: number;
  /** Citoyens encore en vie dans la ville. */
  readonly survivors: number;
  /** Population totale de la ville (vivants + morts). */
  readonly population: number;
  readonly role: CardRole;
  readonly citizenName: string;
  readonly citizenAlive: boolean;
  readonly causeOfDeath: string | null;
  /** Compteurs de bâtiments construits, indexés par id (catalogue `buildings`). */
  readonly buildings: Readonly<Record<string, number>>;
  /** Compteurs d'objets récupérés, indexés par id (catalogue `items`). */
  readonly items: Readonly<Record<string, number>>;
}

/** Synthèse complète et prête à afficher / partager. */
export interface EndgameCardSummary {
  readonly townName: string;
  readonly difficulty: string;
  readonly difficultyLabel: string;
  readonly outcome: GameOutcome;
  readonly gameOver: boolean;
  readonly daysSurvived: number;
  readonly survivalDays: number;
  readonly survivors: number;
  readonly population: number;
  readonly role: CardRole;
  readonly roleLabel: string;
  readonly citizenName: string;
  readonly citizenAlive: boolean;
  readonly causeOfDeath: string | null;
  /** Titre honorifique attribué (déterministe). */
  readonly title: string;
  /** Phrase de contexte (issue + ville + jours). */
  readonly subtitle: string;
  /** Ligne d'ambiance thématique. */
  readonly flavor: string;
  /** Nombre total d'objets récupérés (somme des compteurs). */
  readonly totalItems: number;
  /** Détail des objets, du plus abondant au plus rare (ids connus uniquement). */
  readonly items: readonly EndgameCardEntry[];
  /** Nombre total de bâtiments construits (somme des compteurs). */
  readonly totalBuildings: number;
  /** Détail des bâtiments (ids connus uniquement). */
  readonly buildings: readonly EndgameCardEntry[];
  /** Texte prêt à publier sur X / Reddit. */
  readonly shareText: string;
}

const ROLE_LABELS: Readonly<Record<CardRole, string>> = {
  founder: 'Fondateur',
  manager: 'Gestionnaire de banque',
  citizen: 'Citoyen',
};

const DIFFICULTY_LABELS: Readonly<Record<string, string>> = {
  normal: 'Normal',
  hard: 'Difficile',
  hardcore: 'Extrême',
};

/**
 * Titre honorifique déterministe. La victoire prime toujours ; à défaut, le
 * titre monte par paliers de nuits traversées.
 */
export function survivorTitle(outcome: GameOutcome, daysSurvived: number, alive: boolean): string {
  if (outcome === 'victory') {
    return alive ? 'Sauveur légendaire' : 'Martyr triomphant';
  }
  if (daysSurvived >= 7) return 'Vétéran des hordes';
  if (daysSurvived >= 5) return 'Survivant aguerri';
  if (daysSurvived >= 3) return 'Éclaireur endurci';
  if (daysSurvived >= 1) return 'Survivant';
  return 'Recrue du désert';
}

/** Convertit un enregistrement de compteurs en lignes triées (ids connus). */
function toEntries(
  counts: Readonly<Record<string, number>>,
  resolve: (id: string) => { name: string; icon: string } | undefined,
): { entries: EndgameCardEntry[]; total: number } {
  const entries: EndgameCardEntry[] = [];
  let total = 0;
  for (const [id, rawCount] of Object.entries(counts)) {
    const count = Math.trunc(rawCount);
    if (!Number.isFinite(count) || count <= 0) continue;
    const def = resolve(id);
    if (!def) continue;
    entries.push({ id, name: def.name, icon: def.icon, count });
    total += count;
  }
  entries.sort((a, b) => (b.count - a.count) || a.name.localeCompare(b.name, 'fr'));
  return { entries, total };
}

/** Phrase de contexte selon l'issue. */
function buildSubtitle(input: EndgameCardInput): string {
  const { outcome, townName, daysSurvived } = input;
  if (outcome === 'victory') {
    return `A mené ${townName} à la victoire après ${daysSurvived} ` +
      `${daysSurvived > 1 ? 'nuits' : 'nuit'} de siège.`;
  }
  if (outcome === 'defeat') {
    return `${townName} est tombée à la nuit ${daysSurvived}.`;
  }
  return `Toujours en vie à ${townName} — nuit ${daysSurvived}.`;
}

/** Ligne d'ambiance thématique (jamais vide). */
function buildFlavor(outcome: GameOutcome, alive: boolean): string {
  if (outcome === 'victory') {
    return alive
      ? 'Les portes ont tenu. La horde a renoncé.'
      : 'Tombé au dernier assaut, mais la ville a survécu.';
  }
  if (outcome === 'defeat') {
    return 'Le désert a repris ce que les vivants lui avaient volé.';
  }
  return alive ? 'La nuit revient. Les murs tiendront-ils ?' : 'La horde ne pardonne pas.';
}

/** Texte de partage prêt à publier (X / Reddit). */
function buildShareText(input: EndgameCardInput, title: string): string {
  const { outcome, townName, daysSurvived } = input;
  const nights = `${daysSurvived} ${daysSurvived > 1 ? 'nuits' : 'nuit'}`;
  if (outcome === 'victory') {
    return `🏆 J'ai sauvé ${townName} après ${nights} de siège dans Hordes Revival ! ` +
      `Titre obtenu : ${title}. Sauras-tu tenir aussi longtemps ? #HordesRevival`;
  }
  if (outcome === 'defeat') {
    return `☠️ ${townName} est tombée après ${nights} face aux hordes de Hordes Revival. ` +
      `J'ai tenu comme ${title}. À ton tour de survivre. #HordesRevival`;
  }
  return `🧟 ${nights} que je tiens à ${townName} dans Hordes Revival. ` +
    `Rejoins la ville... ou finis dans le désert. #HordesRevival`;
}

/** Étiquette lisible d'une difficulté (repli sur la valeur brute capitalisée). */
export function difficultyLabel(difficulty: string): string {
  return DIFFICULTY_LABELS[difficulty] ?? difficulty;
}

/** Assemble la carte de fin de partie complète à partir de l'état de jeu. */
export function buildEndgameCard(input: EndgameCardInput): EndgameCardSummary {
  const title = survivorTitle(input.outcome, input.daysSurvived, input.citizenAlive);
  const { entries: items, total: totalItems } = toEntries(input.items, getItemDef);
  const { entries: buildings, total: totalBuildings } = toEntries(input.buildings, getBuildingDef);
  return {
    townName: input.townName,
    difficulty: input.difficulty,
    difficultyLabel: difficultyLabel(input.difficulty),
    outcome: input.outcome,
    gameOver: input.gameOver,
    daysSurvived: input.daysSurvived,
    survivalDays: input.survivalDays,
    survivors: input.survivors,
    population: input.population,
    role: input.role,
    roleLabel: ROLE_LABELS[input.role] ?? ROLE_LABELS.citizen,
    citizenName: input.citizenName,
    citizenAlive: input.citizenAlive,
    causeOfDeath: input.causeOfDeath,
    title,
    subtitle: buildSubtitle(input),
    flavor: buildFlavor(input.outcome, input.citizenAlive),
    totalItems,
    items,
    totalBuildings,
    buildings,
    shareText: buildShareText(input, title),
  };
}
