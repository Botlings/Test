/**
 * Implémentation in-memory du `Store` de Hordes Revival.
 *
 * Sert de back-end pour les tests d'intégration et pour le démarrage local
 * sans Postgres/Redis. Les méthodes sont déclarées `async` afin de respecter
 * le contrat commun ; le coût réel reste O(1) (Map en mémoire).
 *
 * Concurrence : Node étant single-threaded, les mutations d'un même tick
 * sont atomiques. Le `nightLock(townId)` mime le lock NX-EX d'un store
 * distribué (rejet immédiat si déjà détenu).
 */
import { randomUUID } from 'node:crypto';
import { Game } from '../domain/game.js';
import type { GameConfig } from '../domain/config.js';
import { DEFAULT_CONFIG } from '../domain/config.js';
import type { Id } from './types.js';
import {
  MAX_CITIZENS_PER_TOWN,
  REFRESH_TOKEN_TTL_MS,
  StoreError,
  type AccountRecord,
  type Difficulty,
  type NightEventInput,
  type SessionRecord,
  type Store,
  type TownRecord,
} from './store.js';

export {
  MAX_CITIZENS_PER_TOWN,
  REFRESH_TOKEN_TTL_MS,
  StoreError,
  type AccountRecord,
  type Difficulty,
  type SessionRecord,
  type TownRecord,
};

function newId(): Id {
  return randomUUID() as Id;
}

/**
 * Renvoie la configuration de jeu correspondant à une difficulté. Exporté
 * pour que le store Postgres puisse reconstruire un `Game` avec la bonne
 * config à partir de la ligne `towns.difficulty`.
 */
export function difficultyConfig(difficulty: Difficulty): GameConfig {
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

/** Implémentation in-memory du `Store`. */
export class MemoryStore implements Store {
  private readonly accounts = new Map<Id, AccountRecord>();
  private readonly accountsByEmail = new Map<string, Id>();
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly towns = new Map<Id, TownRecord>();
  private readonly nightLocks = new Set<Id>();
  private readonly nightEvents: Array<{ townId: Id; event: NightEventInput; at: Date }> = [];

  /* ---------------------------- Comptes ---------------------------------- */

  async findAccountByEmail(email: string): Promise<AccountRecord | undefined> {
    const id = this.accountsByEmail.get(email.toLowerCase());
    if (!id) return undefined;
    return this.accounts.get(id);
  }

  async getAccount(id: Id): Promise<AccountRecord | undefined> {
    return this.accounts.get(id);
  }

  async createAccount(email: string, passwordHash: string): Promise<AccountRecord> {
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

  async createSession(
    tokenFingerprint: string,
    accountId: Id,
    ttlMs = REFRESH_TOKEN_TTL_MS,
  ): Promise<SessionRecord> {
    const record: SessionRecord = {
      tokenFingerprint,
      accountId,
      expiresAt: new Date(Date.now() + ttlMs),
    };
    this.sessions.set(tokenFingerprint, record);
    return record;
  }

  async consumeSession(
    tokenFingerprint: string,
    now: Date = new Date(),
  ): Promise<SessionRecord | undefined> {
    const session = this.sessions.get(tokenFingerprint);
    if (!session) return undefined;
    if (session.expiresAt.getTime() <= now.getTime()) {
      this.sessions.delete(tokenFingerprint);
      return undefined;
    }
    this.sessions.delete(tokenFingerprint);
    return session;
  }

  async revokeSession(tokenFingerprint: string): Promise<void> {
    this.sessions.delete(tokenFingerprint);
  }

  /* ---------------------------- Villes ----------------------------------- */

  async listOpenTowns(): Promise<TownRecord[]> {
    return [...this.towns.values()].filter(
      (t) => !t.closed && t.membership.size < MAX_CITIZENS_PER_TOWN,
    );
  }

  async getTown(id: Id): Promise<TownRecord | undefined> {
    return this.towns.get(id);
  }

  async createTown(name: string, difficulty: Difficulty): Promise<TownRecord> {
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

  async joinTown(
    townId: Id,
    accountId: Id,
    citizenName: string,
  ): Promise<{ citizenId: string }> {
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

  async citizenIdFor(townId: Id, accountId: Id): Promise<string | undefined> {
    return this.towns.get(townId)?.membership.get(accountId);
  }

  async saveTown(_town: TownRecord): Promise<void> {
    // No-op : le `Game` est déjà mis à jour en place dans la Map.
  }

  async recordNightEvent(townId: Id, event: NightEventInput): Promise<void> {
    this.nightEvents.push({ townId, event, at: new Date() });
  }

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

  async close(): Promise<void> {
    // Rien à fermer : aucune ressource externe.
  }
}
