/**
 * Implémentation in-memory du store de Hordes Revival.
 *
 * Sert de back-end pour les tests d'intégration et pour le démarrage local
 * sans Postgres/Redis. La forme des entités suit `persistence/types.ts` ;
 * une future implémentation Drizzle pourra brancher la même interface
 * `Store` sans toucher au reste du code.
 *
 * Concurrence : Node étant single-threaded, les mutations sont atomiques.
 * Le `nightLock(townId)` retourne une promesse-mutex pour sérialiser les
 * résolutions de nuit d'une même ville (équivalent in-memory du lock Redis).
 */
import { randomUUID } from 'node:crypto';
import { Game } from '../domain/game.js';
import type { GameConfig } from '../domain/config.js';
import { DEFAULT_CONFIG } from '../domain/config.js';
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

export interface TownRecord {
  readonly id: Id;
  readonly name: string;
  readonly difficulty: Difficulty;
  readonly createdAt: Date;
  /** Le moteur de jeu de la ville (mutable). */
  readonly game: Game;
  /** Mapping accountId → citizenId (mutable). */
  readonly membership: Map<Id, string>;
  /** `true` si la partie est gagnée ou perdue (verrouille les actions). */
  closed: boolean;
}

function newId(): Id {
  return randomUUID() as Id;
}

function difficultyConfig(difficulty: Difficulty): GameConfig {
  switch (difficulty) {
    case 'normal':
      return DEFAULT_CONFIG;
    case 'hard':
      return {
        ...DEFAULT_CONFIG,
        hordeBaseAttack: DEFAULT_CONFIG.hordeBaseAttack + 4,
        hordeGrowthPerDay: DEFAULT_CONFIG.hordeGrowthPerDay + 2,
      };
    case 'hardcore':
      return {
        ...DEFAULT_CONFIG,
        hordeBaseAttack: DEFAULT_CONFIG.hordeBaseAttack + 8,
        hordeGrowthPerDay: DEFAULT_CONFIG.hordeGrowthPerDay + 4,
        startingActionPoints: DEFAULT_CONFIG.startingActionPoints - 1,
      };
  }
}

/**
 * Store applicatif. Les méthodes synchrones ne réservent pas d'I/O ;
 * `nightLock` retourne une promesse pour mimer un lock distribué.
 */
export class MemoryStore {
  private readonly accounts = new Map<Id, AccountRecord>();
  private readonly accountsByEmail = new Map<string, Id>();
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly towns = new Map<Id, TownRecord>();
  private readonly nightLocks = new Set<Id>();

  /* ---------------------------- Comptes ---------------------------------- */

  findAccountByEmail(email: string): AccountRecord | undefined {
    const id = this.accountsByEmail.get(email.toLowerCase());
    if (!id) return undefined;
    return this.accounts.get(id);
  }

  getAccount(id: Id): AccountRecord | undefined {
    return this.accounts.get(id);
  }

  createAccount(email: string, passwordHash: string): AccountRecord {
    const normalized = email.toLowerCase();
    if (this.accountsByEmail.has(normalized)) {
      throw new StoreError('email-taken', 'Cet email est déjà utilisé');
    }
    const record: AccountRecord = {
      id: newId(),
      email: normalized,
      passwordHash,
      createdAt: new Date(),
    };
    this.accounts.set(record.id, record);
    this.accountsByEmail.set(normalized, record.id);
    return record;
  }

  /* ---------------------------- Sessions --------------------------------- */

  createSession(tokenFingerprint: string, accountId: Id, ttlMs = REFRESH_TOKEN_TTL_MS): SessionRecord {
    const record: SessionRecord = {
      tokenFingerprint,
      accountId,
      expiresAt: new Date(Date.now() + ttlMs),
    };
    this.sessions.set(tokenFingerprint, record);
    return record;
  }

  consumeSession(tokenFingerprint: string, now: Date = new Date()): SessionRecord | undefined {
    const session = this.sessions.get(tokenFingerprint);
    if (!session) return undefined;
    if (session.expiresAt.getTime() <= now.getTime()) {
      this.sessions.delete(tokenFingerprint);
      return undefined;
    }
    this.sessions.delete(tokenFingerprint);
    return session;
  }

  revokeSession(tokenFingerprint: string): void {
    this.sessions.delete(tokenFingerprint);
  }

  /* ---------------------------- Villes ----------------------------------- */

  listOpenTowns(): TownRecord[] {
    return [...this.towns.values()].filter(
      (t) => !t.closed && t.membership.size < MAX_CITIZENS_PER_TOWN,
    );
  }

  getTown(id: Id): TownRecord | undefined {
    return this.towns.get(id);
  }

  createTown(name: string, difficulty: Difficulty): TownRecord {
    const trimmed = name.trim();
    if (trimmed.length < 3 || trimmed.length > 30) {
      throw new StoreError('town-name-invalid', 'Le nom de la ville doit faire 3 à 30 caractères');
    }
    const town: TownRecord = {
      id: newId(),
      name: trimmed,
      difficulty,
      createdAt: new Date(),
      game: new Game(difficultyConfig(difficulty)),
      membership: new Map(),
      closed: false,
    };
    this.towns.set(town.id, town);
    return town;
  }

  /**
   * Inscrit un compte comme citoyen d'une ville. Renvoie le citoyen créé
   * (côté domain) ainsi que la ville mise à jour.
   */
  joinTown(townId: Id, accountId: Id, citizenName: string): { citizenId: string } {
    const town = this.towns.get(townId);
    if (!town) {
      throw new StoreError('town-not-found', 'Ville introuvable');
    }
    if (town.closed) {
      throw new StoreError('town-closed', 'Cette ville est terminée');
    }
    if (town.membership.has(accountId)) {
      throw new StoreError('already-joined', 'Vous avez déjà rejoint cette ville');
    }
    if (town.membership.size >= MAX_CITIZENS_PER_TOWN) {
      throw new StoreError('town-full', 'Cette ville est complète');
    }
    const citizen = town.game.addCitizen(citizenName);
    town.membership.set(accountId, citizen.id);
    return { citizenId: citizen.id };
  }

  /**
   * Retourne le citoyen lié à un compte dans une ville (ou `undefined`).
   */
  citizenIdFor(townId: Id, accountId: Id): string | undefined {
    return this.towns.get(townId)?.membership.get(accountId);
  }

  /**
   * Verrouille la résolution de nuit d'une ville selon une sémantique
   * « NX-EX » à la Redis : si une nuit est déjà en cours pour cette ville,
   * lève `StoreError('night-already-running')` immédiatement plutôt que de
   * mettre la requête en file d'attente. Cela garantit que deux résolutions
   * simultanées ne peuvent pas s'enchaîner par erreur.
   */
  async nightLock<T>(townId: Id, fn: () => Promise<T> | T): Promise<T> {
    if (this.nightLocks.has(townId)) {
      throw new StoreError('night-already-running', 'La nuit est déjà en cours');
    }
    this.nightLocks.add(townId);
    try {
      return await fn();
    } finally {
      this.nightLocks.delete(townId);
    }
  }
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
