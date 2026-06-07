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
import type { NightReport, Phase } from '../domain/types.js';
import type { Id } from './types.js';

/** D'où vient la résolution d'une nuit : action joueur ou tic automatique. */
export type NightTrigger = 'manual' | 'scheduler';

/** Une entrée du journal des nuits passées d'une ville. */
export interface StoredNightReport {
  readonly trigger: NightTrigger;
  readonly storedAt: Date;
  readonly report: NightReport;
}

export type Difficulty = 'normal' | 'hard' | 'hardcore';

/** Nombre maximum de joueurs distincts dans une ville. */
export const MAX_CITIZENS_PER_TOWN = 10;
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
 */
export interface TownRecord {
  readonly id: Id;
  readonly name: string;
  readonly difficulty: Difficulty;
  readonly createdAt: Date;
  readonly game: Game;
  readonly membership: Map<Id, string>;
  closed: boolean;
}

export interface NightEventInput {
  readonly day: number;
  readonly attackers: number;
  readonly defense: number;
  readonly breached: boolean;
  readonly deaths: number;
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
  | 'citizen.move'
  | 'citizen.scavenge'
  | 'citizen.build'
  | 'citizen.died'
  | 'night.resolved'
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
  readonly closed: boolean;
  readonly citizen: {
    readonly id: string;
    readonly name: string;
    readonly alive: boolean;
    readonly causeOfDeath: string | null;
  };
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
   * Liste les villes auxquelles un compte a participé, triées de la plus
   * récente à la plus ancienne. Utilisé par `/auth/me/history`.
   */
  listAccountTowns(accountId: Id): Promise<AccountTownEntry[]>;

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
