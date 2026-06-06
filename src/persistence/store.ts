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
import type { Phase } from '../domain/types.js';
import type { Id } from './types.js';

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

  /** Lock NX-EX sur une ville. Rejette immédiatement si déjà acquis. */
  nightLock<T>(townId: Id, fn: () => Promise<T> | T): Promise<T>;

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
