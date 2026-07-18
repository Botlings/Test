/**
 * Contrat applicatif de persistance pour Hordes Revival.
 *
 * Deux implémentations cohabitent :
 *   - `MemoryStore` (in-memory) — tests + démarrage local sans Postgres.
 *   - `PgStore`     (PostgreSQL) — production, schéma versionné en SQL.
 *
 * Toutes les méthodes sont **async** afin de ne pas figer le contrat à
 * une implémentation synchrone : Postgres impose des I/O asynchrones.
 *
 * Sémantique du lock de nuit : `nightLock(townId, fn)` refuse immédiatement
 * (StoreError 'night-already-running') si une résolution est déjà en cours.
 * Pas de file d'attente — deux requêtes simultanées DOIVENT se traduire par
 * un 409 côté API, pas s'enchaîner par hasard.
 */
import type { Game } from '../domain/game.js';
import type { GameOutcome, NightReport, Phase } from '../domain/types.js';
import type { AchievementId } from '../domain/achievements.js';
import type { GovernanceState } from '../domain/governance.js';
import type { Id } from './types.js';

/** Issue finale enregistrée d'une partie (jamais `ongoing`). */
export type GameResultOutcome = 'victory' | 'defeat';

/** D'où vient la résolution d'une nuit : action joueur ou tic automatique. */
export type NightTrigger = 'manual' | 'scheduler';

/** Une entrée du journal des nuits passées d'une ville. */
export interface StoredNightReport {
  readonly trigger: NightTrigger;
  readonly storedAt: Date;
  readonly report: NightReport;
}

export type Difficulty = 'normal' | 'hard' | 'hardcore';

/**
 * Régime d'accès à la banque commune de la ville.
 *   - `open`       : n'importe quel citoyen peut puiser dans la banque pour
 *                    construire (comportement historique du jalon 1).
 *   - `restricted` : seuls le fondateur et les gestionnaires désignés peuvent
 *                    dépenser les ressources de la banque (anti-pillage).
 */
export type BankPolicy = 'open' | 'restricted';

/** Rôle d'un compte vis-à-vis de la ville et de sa banque. */
export type TownRole = 'founder' | 'manager' | 'citizen';

/** Une entrée de la file d'attente d'une ville pleine. */
export interface TownQueueEntry {
  readonly accountId: Id;
  /** Position 1-based dans la file (1 = prochain à entrer). */
  readonly position: number;
  readonly enqueuedAt: Date;
}

/** Nombre maximum de joueurs distincts dans une ville (jalon 2 : 40 habitants). */
export const MAX_CITIZENS_PER_TOWN = 40;
/** Durée de vie par défaut d'un refresh token (en ms) — 30 jours. */
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface AccountRecord {
  readonly id: Id;
  readonly email: string;
  readonly passwordHash: string;
  readonly createdAt: Date;
}

export interface SessionRecord {
  readonly tokenFingerprint: string;
  readonly accountId: Id;
  readonly expiresAt: Date;
}

/**
 * Représentation applicative d'une ville. Le moteur `game` est l'objet de
 * vérité en mémoire ; les implémentations du Store sont responsables de
 * sérialiser / restaurer son `snapshot()` sur leur backend respectif.
 *
 * `membership` mappe `accountId → citizenId` (l'identifiant côté domain).
 *
 * Gouvernance multijoueur (jalon 2) :
 *   - `founderAccountId` : premier compte à avoir rejoint (créateur). Toujours
 *     gestionnaire de banque, ne peut être révoqué.
 *   - `bankPolicy`       : régime d'accès à la banque commune.
 *   - `bankManagers`     : comptes autorisés à dépenser la banque en régime
 *     `restricted` (le fondateur est implicitement inclus).
 *   - `queue`            : file d'attente ordonnée (accountId) pour rejoindre
 *     une ville pleine. Transitoire : non persistée durablement.
 */
export interface TownRecord {
  readonly id: Id;
  readonly name: string;
  readonly difficulty: Difficulty;
  readonly createdAt: Date;
  readonly game: Game;
  readonly membership: Map<Id, string>;
  closed: boolean;
  founderAccountId: Id | null;
  bankPolicy: BankPolicy;
  readonly bankManagers: Set<Id>;
  readonly queue: Id[];
  /**
   * État de gouvernance sociale (maire, élection, couvre-feu, votes d'exil).
   * Objet mutable et sérialisable (persisté en JSONB à côté du snapshot du
   * moteur). Les transitions passent par le module `domain/governance`.
   */
  governance: GovernanceState;
}

/**
 * Détermine si un compte a le droit de dépenser les ressources de la banque
 * commune (construction). En régime `open`, tout citoyen le peut ; en régime
 * `restricted`, seuls le fondateur et les gestionnaires désignés. Pure
 * fonction (pas d'I/O) — mutualisée par les routes et les tests.
 */
export function canSpendBank(town: TownRecord, accountId: Id): boolean {
  if (town.bankPolicy === 'open') return true;
  if (town.founderAccountId && town.founderAccountId === accountId) return true;
  return town.bankManagers.has(accountId);
}

/** Rôle d'un compte dans une ville (pour l'affichage / les autorisations). */
export function roleFor(town: TownRecord, accountId: Id): TownRole {
  if (town.founderAccountId && town.founderAccountId === accountId) return 'founder';
  if (town.bankManagers.has(accountId)) return 'manager';
  return 'citizen';
}

/** Résultat d'un départ de ville : éventuelle promotion de la tête de file. */
export interface LeaveTownResult {
  /** Le citoyen retiré (compte sortant). `null` si le compte n'était pas membre. */
  readonly removedCitizenId: string | null;
  /** Compte promu depuis la file d'attente pour occuper la place libérée. */
  readonly promoted: {
    readonly accountId: Id;
    readonly citizenId: string;
    readonly citizenName: string;
  } | null;
}

export interface NightEventInput {
  readonly day: number;
  readonly attackers: number;
  readonly defense: number;
  readonly breached: boolean;
  readonly deaths: number;
}

/* --------------------------- Fin de partie / classement ----------------- */

/**
 * Résultat final d'une partie, enregistré une seule fois quand la ville
 * atteint la victoire ou la défaite. Alimente le classement global.
 */
export interface GameResultInput {
  /** `victory` si la ville a tenu `survivalDays` nuits, sinon `defeat`. */
  readonly outcome: GameResultOutcome;
  /** Nombre de nuits effectivement survécues par la ville. */
  readonly daysSurvived: number;
  /** Citoyens encore en vie à la fin de la partie. */
  readonly survivors: number;
  /** Nombre total de citoyens ayant rejoint la ville sur la partie. */
  readonly population: number;
  /** Difficulté de la partie (sert au classement / affichage). */
  readonly difficulty: Difficulty;
}

/** Une ligne du classement global des villes (partie terminée). */
export interface LeaderboardEntry {
  /** Rang 1-based dans le classement (1 = meilleur). */
  readonly rank: number;
  readonly townId: Id;
  readonly townName: string;
  readonly difficulty: Difficulty;
  readonly outcome: GameResultOutcome;
  readonly daysSurvived: number;
  readonly survivors: number;
  readonly population: number;
  readonly endedAt: Date;
}

/* ------------------------------ Forum --------------------------------- */

/** Type d'un sujet du forum de ville. */
export type ForumThreadKind = 'discussion' | 'vote';

/** Option disponible pour un sujet de type `vote`. */
export interface ForumVoteOption {
  readonly id: string;
  readonly label: string;
}

/** Un sujet du forum (discussion ou vote). */
export interface ForumThreadRecord {
  readonly id: Id;
  readonly townId: Id;
  readonly authorAccountId: Id;
  readonly authorCitizenName: string;
  readonly title: string;
  readonly kind: ForumThreadKind;
  readonly options: readonly ForumVoteOption[];
  readonly createdAt: Date;
  readonly closesAt: Date | null;
  closed: boolean;
}

/** Un sujet enrichi pour l'API : compte de messages + dernier message. */
export interface ForumThreadSummary extends ForumThreadRecord {
  readonly messageCount: number;
  readonly lastMessageAt: Date | null;
  readonly voteCount: number;
}

/** Un message d'une discussion. */
export interface ForumMessageRecord {
  readonly id: Id;
  readonly threadId: Id;
  readonly townId: Id;
  readonly authorAccountId: Id;
  readonly authorCitizenName: string;
  readonly body: string;
  readonly createdAt: Date;
}

/** Un vote individuel posé par un compte sur un sujet. */
export interface ForumVoteRecord {
  readonly threadId: Id;
  readonly accountId: Id;
  readonly citizenName: string;
  readonly optionId: string;
  readonly castAt: Date;
}

/** Agrégat de votes pour un sujet. */
export interface ForumVoteTally {
  readonly threadId: Id;
  /** Total de votes posés. */
  readonly total: number;
  /** Comptes par optionId. */
  readonly counts: Readonly<Record<string, number>>;
  /** Vote courant de l'utilisateur courant (si l'API a passé un accountId). */
  readonly myChoice: string | null;
}

/** Détail complet d'un sujet : sujet + messages + tally + votant éventuel. */
export interface ForumThreadDetail {
  readonly thread: ForumThreadSummary;
  readonly messages: readonly ForumMessageRecord[];
  readonly tally: ForumVoteTally;
}

/* ------------------------------ Activité ------------------------------ */

/**
 * Types d'événements d'activité publiés dans le journal de la ville.
 * Les actions joueur (`citizen.*`) et événements de partie (`night.*`,
 * `town.*`) sont émis automatiquement par les routes correspondantes.
 */
export type ActivityKind =
  | 'town.create'
  | 'citizen.join'
  | 'citizen.leave'
  | 'citizen.promoted'
  | 'bank.policy'
  | 'bank.manager'
  | 'citizen.move'
  | 'citizen.scavenge'
  | 'citizen.build'
  | 'citizen.construct'
  | 'citizen.craft'
  | 'citizen.explore'
  | 'citizen.scavenge-zone'
  | 'citizen.fight'
  | 'citizen.loot-event'
  | 'citizen.died'
  | 'night.resolved'
  | 'game.over'
  | 'election.opened'
  | 'mayor.elected'
  | 'mayor.curfew'
  | 'exile.opened'
  | 'exile.passed'
  | 'exile.rejected'
  | 'forum.thread.created'
  | 'forum.vote.created'
  | 'forum.vote.cast'
  | 'forum.message.posted';

/** Une entrée du journal d'activité d'une ville. */
export interface ActivityEntry {
  readonly id: Id;
  readonly townId: Id;
  readonly accountId: Id | null;
  readonly citizenId: string | null;
  readonly citizenName: string | null;
  readonly kind: ActivityKind;
  /** Détails sérialisables : montant ramassé, destination, etc. */
  readonly details: Readonly<Record<string, string | number | boolean | null>>;
  readonly createdAt: Date;
}

/** Input pour `recordActivity`. */
export interface ActivityInput {
  readonly accountId?: Id | null;
  readonly citizenId?: string | null;
  readonly citizenName?: string | null;
  readonly kind: ActivityKind;
  readonly details?: Readonly<Record<string, string | number | boolean | null>>;
}

/**
 * Une ligne d'historique : une ville à laquelle un compte a participé, avec
 * l'état actuel (jour atteint, partie terminée ou non) et le devenir du
 * citoyen contrôlé. Sert à alimenter le profil du joueur.
 */
export interface AccountTownEntry {
  readonly townId: Id;
  readonly townName: string;
  readonly difficulty: Difficulty;
  readonly joinedAt: Date;
  readonly currentDay: number;
  readonly phase: Phase;
  readonly gameOver: boolean;
  /** Issue de la partie : `ongoing`, `victory` ou `defeat`. */
  readonly outcome: GameOutcome;
  readonly closed: boolean;
  readonly citizen: {
    readonly id: string;
    readonly name: string;
    readonly alive: boolean;
    readonly causeOfDeath: string | null;
  };
}

/** Un haut fait débloqué par un compte, avec la date de déblocage. */
export interface AchievementUnlock {
  readonly achievementId: AchievementId;
  readonly unlockedAt: Date;
}

export interface Store {
  /* ------------------------------ Comptes ------------------------------- */
  findAccountByEmail(email: string): Promise<AccountRecord | undefined>;
  getAccount(id: Id): Promise<AccountRecord | undefined>;
  createAccount(email: string, passwordHash: string): Promise<AccountRecord>;

  /* ------------------------------ Sessions ------------------------------ */
  createSession(
    tokenFingerprint: string,
    accountId: Id,
    ttlMs?: number,
  ): Promise<SessionRecord>;
  consumeSession(tokenFingerprint: string, now?: Date): Promise<SessionRecord | undefined>;
  revokeSession(tokenFingerprint: string): Promise<void>;

  /* ------------------------------ Villes -------------------------------- */
  listOpenTowns(): Promise<TownRecord[]>;
  /**
   * Toutes les villes encore en vie (non `closed`), même celles qui sont
   * pleines. Utilisé par le scheduler de nuit qui doit faire tourner toutes
   * les parties actives.
   */
  listOngoingTowns(): Promise<TownRecord[]>;
  getTown(id: Id): Promise<TownRecord | undefined>;
  createTown(name: string, difficulty: Difficulty): Promise<TownRecord>;
  joinTown(townId: Id, accountId: Id, citizenName: string): Promise<{ citizenId: string }>;
  citizenIdFor(townId: Id, accountId: Id): Promise<string | undefined>;

  /**
   * Retire un compte d'une ville (le joueur quitte la partie) puis, si la
   * file d'attente n'est pas vide, promeut automatiquement la tête de file
   * pour occuper la place libérée. Idempotent : un compte non membre renvoie
   * `removedCitizenId: null` sans erreur. Lève `StoreError('town-closed')`
   * si la partie est terminée.
   */
  leaveTown(townId: Id, accountId: Id): Promise<LeaveTownResult>;

  /* ----------------------- File d'attente (ville pleine) ---------------- */
  /**
   * Ajoute un compte à la file d'attente d'une ville pleine. Lève
   * `StoreError('town-not-found' | 'town-closed' | 'already-joined' |
   * 'already-queued' | 'town-not-full')`. Renvoie la position 1-based.
   */
  enqueueForTown(townId: Id, accountId: Id): Promise<{ position: number; size: number }>;

  /** Retire un compte de la file d'attente (no-op s'il n'y est pas). */
  leaveQueue(townId: Id, accountId: Id): Promise<void>;

  /** File d'attente ordonnée d'une ville (vide si aucune attente). */
  getQueue(townId: Id): Promise<TownQueueEntry[]>;

  /* ----------------------- Banque : droits d'accès ---------------------- */
  /**
   * Change le régime d'accès à la banque commune. Réservé au fondateur /
   * gestionnaires côté route. Lève `StoreError('town-not-found')`.
   */
  setBankPolicy(townId: Id, policy: BankPolicy): Promise<void>;

  /**
   * Accorde (ou révoque) le droit de gestion de banque à un compte membre.
   * Le fondateur ne peut être révoqué. Lève
   * `StoreError('town-not-found' | 'not-a-citizen' | 'founder-immutable')`.
   */
  setBankManager(townId: Id, accountId: Id, allowed: boolean): Promise<void>;
  /**
   * Liste les villes auxquelles un compte a participé, triées de la plus
   * récente à la plus ancienne. Utilisé par `/auth/me/history`.
   */
  listAccountTowns(accountId: Id): Promise<AccountTownEntry[]>;

  /* --------------------------- Hauts faits ------------------------------ */
  /**
   * Débloque un haut fait pour un compte. Idempotent : si le badge est déjà
   * acquis, ne change rien et renvoie `false` ; sinon l'enregistre (avec sa
   * date de déblocage) et renvoie `true`. Permet aux routes de ne notifier
   * l'utilisateur que lors d'un déblocage réellement nouveau.
   */
  unlockAchievement(accountId: Id, achievementId: AchievementId): Promise<boolean>;

  /**
   * Liste les hauts faits débloqués par un compte, du plus ancien au plus
   * récent (ordre de déblocage). Alimente la page profil.
   */
  listAccountAchievements(accountId: Id): Promise<AchievementUnlock[]>;

  /**
   * Persiste l'état courant du moteur (`town.game.snapshot()`) et le drapeau
   * `closed`. Doit être appelé par les routes après toute mutation.
   */
  saveTown(town: TownRecord): Promise<void>;

  /** Enregistre l'événement de résolution d'une nuit (audit / classement). */
  recordNightEvent(townId: Id, event: NightEventInput): Promise<void>;

  /**
   * Persiste le compte rendu détaillé d'une nuit pour rejouabilité côté UI.
   * Implémentations libres de tronquer l'historique au-delà d'une certaine
   * profondeur (par défaut : 20 dernières nuits par ville).
   */
  recordNightReport(townId: Id, trigger: NightTrigger, report: NightReport): Promise<void>;

  /**
   * Renvoie les comptes rendus persistés pour une ville, du plus récent au
   * plus ancien (limite par défaut : 20).
   */
  listNightReports(townId: Id, limit?: number): Promise<StoredNightReport[]>;

  /* --------------------------- Fin de partie ---------------------------- */
  /**
   * Enregistre (ou met à jour) le résultat final d'une partie terminée.
   * Idempotent par ville : un second appel pour la même ville écrase le
   * résultat précédent (le moteur ne termine une partie qu'une fois).
   */
  recordGameResult(townId: Id, result: GameResultInput): Promise<void>;

  /**
   * Classement global des parties terminées, de la meilleure à la moins
   * bonne : victoires d'abord, puis par nuits survécues décroissantes, puis
   * survivants décroissants, puis date de fin croissante. Limite par défaut : 20.
   */
  listLeaderboard(limit?: number): Promise<LeaderboardEntry[]>;

  /* ------------------------------ Forum -------------------------------- */
  /**
   * Crée un nouveau sujet du forum. Pour `kind: 'vote'`, `options` doit
   * contenir 2..6 entrées et un `closesAt` futur peut être fourni pour
   * verrouiller automatiquement le sujet à l'échéance.
   */
  createForumThread(input: {
    readonly townId: Id;
    readonly authorAccountId: Id;
    readonly authorCitizenName: string;
    readonly title: string;
    readonly kind: ForumThreadKind;
    readonly options?: readonly ForumVoteOption[];
    readonly closesAt?: Date | null;
    readonly body?: string;
  }): Promise<ForumThreadDetail>;

  /** Liste tous les sujets d'une ville, du plus récent au plus ancien. */
  listForumThreads(townId: Id, viewerAccountId?: Id): Promise<ForumThreadSummary[]>;

  /** Récupère le détail d'un sujet avec ses messages et tally de votes. */
  getForumThread(
    townId: Id,
    threadId: Id,
    viewerAccountId?: Id,
  ): Promise<ForumThreadDetail | undefined>;

  /** Ajoute un message à une discussion ou un commentaire à un vote. */
  postForumMessage(input: {
    readonly townId: Id;
    readonly threadId: Id;
    readonly authorAccountId: Id;
    readonly authorCitizenName: string;
    readonly body: string;
  }): Promise<ForumMessageRecord>;

  /**
   * Pose ou met à jour le vote du compte sur un sujet `kind: 'vote'`. Renvoie
   * le nouveau tally agrégé. Lève `StoreError('vote-not-allowed' | 'option-invalid' | 'vote-closed')`
   * en cas d'incompatibilité.
   */
  castForumVote(input: {
    readonly townId: Id;
    readonly threadId: Id;
    readonly accountId: Id;
    readonly citizenName: string;
    readonly optionId: string;
  }): Promise<ForumVoteTally>;

  /** Ferme manuellement un sujet (seul l'auteur peut le demander côté route). */
  closeForumThread(townId: Id, threadId: Id): Promise<ForumThreadSummary>;

  /* ------------------------------ Activité ----------------------------- */
  /** Persiste une entrée du journal d'activité. */
  recordActivity(townId: Id, input: ActivityInput): Promise<ActivityEntry>;

  /**
   * Liste les entrées d'activité d'une ville, des plus récentes aux plus
   * anciennes. Limite par défaut : 50.
   */
  listActivity(townId: Id, limit?: number): Promise<ActivityEntry[]>;

  /** Lock NX-EX sur une ville. Rejette immédiatement si déjà acquis. */
  nightLock<T>(townId: Id, fn: () => Promise<T> | T): Promise<T>;

  /**
   * Sonde de santé du backend de persistance. Doit renvoyer sans erreur si
   * le store est utilisable (pour Postgres : un `SELECT 1` ; pour la mémoire :
   * un no-op). Utilisée par l'endpoint `/health/ready`.
   */
  ping(): Promise<void>;

  /** Libère toutes les ressources (pool de connexion, etc.). */
  close(): Promise<void>;
}

/**
 * Ordre canonique du classement entre deux résultats de partie. Renvoie un
 * nombre négatif si `a` est mieux classé que `b`. Mutualisé par le store
 * mémoire (tri JS) ; le store Postgres reproduit la même logique en SQL.
 *
 * Critères, par priorité : victoire avant défaite, puis nuits survécues
 * décroissantes, survivants décroissants, et enfin date de fin la plus
 * ancienne (premier à accomplir l'exploit).
 */
export function compareGameResults(
  a: Omit<LeaderboardEntry, 'rank'>,
  b: Omit<LeaderboardEntry, 'rank'>,
): number {
  const aWin = a.outcome === 'victory' ? 1 : 0;
  const bWin = b.outcome === 'victory' ? 1 : 0;
  if (aWin !== bWin) return bWin - aWin;
  if (a.daysSurvived !== b.daysSurvived) return b.daysSurvived - a.daysSurvived;
  if (a.survivors !== b.survivors) return b.survivors - a.survivors;
  return a.endedAt.getTime() - b.endedAt.getTime();
}

/** Erreur métier émise par le store. Le `code` est stable et utilisable côté API. */
export class StoreError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'StoreError';
  }
}
