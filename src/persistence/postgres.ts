/**
 * Implémentation PostgreSQL du `Store` de Hordes Revival.
 *
 * Architecture :
 *   - Postgres est la source de vérité durable. Le schéma est défini dans
 *     `sql/schema.sql` et appliqué via `runMigrations()` au démarrage.
 *   - Les `TownRecord` sont hydratés en mémoire à l'init (`loadTowns()`)
 *     afin que le moteur de jeu (`Game`) opère sur des objets vivants ;
 *     chaque mutation déclenche un `saveTown()` qui persiste le snapshot.
 *   - Le lock NX-EX de résolution de nuit utilise `pg_try_advisory_lock`
 *     (clé dérivée du UUID), auto-libéré à la fermeture de la connexion :
 *     une instance crashée ne laisse pas de verrou orphelin.
 *
 * Multi-process : la couche in-memory cache n'est pas synchronisée entre
 * instances. Pour l'horizontal scaling, viser un seul process actif par
 * ville (sticky routing) ou désactiver le cache. Hors scope du jalon 1.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient, type PoolConfig } from 'pg';
import { Game } from '../domain/game.js';
import type { Citizen, Location, Phase } from '../domain/types.js';
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
import { difficultyConfig } from './memory.js';

const SCHEMA_URL = new URL('./sql/schema.sql', import.meta.url);

/**
 * Map en mémoire id → TownRecord. Les `Game` sont des objets vivants ;
 * tous les chemins de mutation passent par `saveTown` pour persister.
 */
export class PgStore implements Store {
  private readonly pool: Pool;
  private readonly towns = new Map<Id, TownRecord>();
  private ready = false;

  constructor(config: string | PoolConfig) {
    this.pool = typeof config === 'string' ? new Pool({ connectionString: config }) : new Pool(config);
  }

  /** Applique le schéma et hydrate le cache des villes en mémoire. */
  async init(): Promise<void> {
    if (this.ready) return;
    await this.runMigrations();
    await this.loadTowns();
    this.ready = true;
  }

  async runMigrations(): Promise<void> {
    const sql = await readFile(fileURLToPath(SCHEMA_URL), 'utf8');
    await this.pool.query(sql);
  }

  private async loadTowns(): Promise<void> {
    const townsRes = await this.pool.query<{
      id: Id;
      name: string;
      difficulty: Difficulty;
      created_at: Date;
      closed: boolean;
      day: number;
      phase: Phase;
      town_defense: number;
      game_over: boolean;
      next_citizen_seq: number;
      bank_wood: number;
      bank_metal: number;
      bank_water: number;
    }>(
      `SELECT id, name, difficulty, created_at, closed, day, phase, town_defense,
              game_over, next_citizen_seq, bank_wood, bank_metal, bank_water
         FROM towns`,
    );
    if (townsRes.rowCount === 0) return;

    const citizensRes = await this.pool.query<{
      town_id: Id;
      id: string;
      name: string;
      alive: boolean;
      location: Location;
      action_points: number;
      consecutive_thirst_days: number;
      cause_of_death: string | null;
    }>(
      `SELECT town_id, id, name, alive, location, action_points,
              consecutive_thirst_days, cause_of_death
         FROM citizens`,
    );
    const citizensByTown = new Map<Id, Citizen[]>();
    for (const row of citizensRes.rows) {
      const c: Citizen = {
        id: row.id,
        name: row.name,
        alive: row.alive,
        location: row.location,
        actionPoints: row.action_points,
        consecutiveThirstDays: row.consecutive_thirst_days,
        ...(row.cause_of_death ? { causeOfDeath: row.cause_of_death } : {}),
      };
      const list = citizensByTown.get(row.town_id) ?? [];
      list.push(c);
      citizensByTown.set(row.town_id, list);
    }

    const membershipsRes = await this.pool.query<{
      town_id: Id;
      account_id: Id;
      citizen_id: string;
    }>(`SELECT town_id, account_id, citizen_id FROM town_memberships`);
    const membershipByTown = new Map<Id, Map<Id, string>>();
    for (const row of membershipsRes.rows) {
      let m = membershipByTown.get(row.town_id);
      if (!m) {
        m = new Map();
        membershipByTown.set(row.town_id, m);
      }
      m.set(row.account_id, row.citizen_id);
    }

    for (const row of townsRes.rows) {
      const config = difficultyConfig(row.difficulty);
      const game = Game.fromSnapshot(config, {
        day: row.day,
        phase: row.phase,
        townDefense: row.town_defense,
        bank: {
          wood: row.bank_wood,
          metal: row.bank_metal,
          water: row.bank_water,
        },
        citizens: citizensByTown.get(row.id) ?? [],
        gameOver: row.game_over,
        nextCitizenSeq: row.next_citizen_seq,
      });
      const town: TownRecord = {
        id: row.id,
        name: row.name,
        difficulty: row.difficulty,
        createdAt: row.created_at,
        game,
        membership: membershipByTown.get(row.id) ?? new Map(),
        closed: row.closed,
      };
      this.towns.set(row.id, town);
    }
  }

  /* ---------------------------- Comptes ---------------------------------- */

  async findAccountByEmail(email: string): Promise<AccountRecord | undefined> {
    const normalized = email.toLowerCase();
    const res = await this.pool.query<{
      id: Id;
      email: string;
      password_hash: string;
      created_at: Date;
    }>(
      `SELECT id, email, password_hash, created_at FROM accounts WHERE email = $1 LIMIT 1`,
      [normalized],
    );
    const row = res.rows[0];
    if (!row) return undefined;
    return {
      id: row.id,
      email: row.email,
      passwordHash: row.password_hash,
      createdAt: row.created_at,
    };
  }

  async getAccount(id: Id): Promise<AccountRecord | undefined> {
    const res = await this.pool.query<{
      id: Id;
      email: string;
      password_hash: string;
      created_at: Date;
    }>(`SELECT id, email, password_hash, created_at FROM accounts WHERE id = $1`, [id]);
    const row = res.rows[0];
    if (!row) return undefined;
    return {
      id: row.id,
      email: row.email,
      passwordHash: row.password_hash,
      createdAt: row.created_at,
    };
  }

  async createAccount(email: string, passwordHash: string): Promise<AccountRecord> {
    const normalized = email.toLowerCase();
    const id = randomUUID() as Id;
    try {
      const res = await this.pool.query<{ created_at: Date }>(
        `INSERT INTO accounts (id, email, password_hash) VALUES ($1, $2, $3)
         RETURNING created_at`,
        [id, normalized, passwordHash],
      );
      return {
        id,
        email: normalized,
        passwordHash,
        createdAt: res.rows[0]!.created_at,
      };
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new StoreError('email-taken', 'Cet email est déjà utilisé');
      }
      throw err;
    }
  }

  /* ---------------------------- Sessions --------------------------------- */

  async createSession(
    tokenFingerprint: string,
    accountId: Id,
    ttlMs = REFRESH_TOKEN_TTL_MS,
  ): Promise<SessionRecord> {
    const expiresAt = new Date(Date.now() + ttlMs);
    await this.pool.query(
      `INSERT INTO sessions (token_fingerprint, account_id, expires_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (token_fingerprint) DO UPDATE
         SET account_id = EXCLUDED.account_id,
             expires_at = EXCLUDED.expires_at`,
      [tokenFingerprint, accountId, expiresAt],
    );
    return { tokenFingerprint, accountId, expiresAt };
  }

  async consumeSession(
    tokenFingerprint: string,
    now: Date = new Date(),
  ): Promise<SessionRecord | undefined> {
    const res = await this.pool.query<{
      account_id: Id;
      expires_at: Date;
    }>(
      `DELETE FROM sessions WHERE token_fingerprint = $1
       RETURNING account_id, expires_at`,
      [tokenFingerprint],
    );
    const row = res.rows[0];
    if (!row) return undefined;
    if (row.expires_at.getTime() <= now.getTime()) {
      return undefined;
    }
    return {
      tokenFingerprint,
      accountId: row.account_id,
      expiresAt: row.expires_at,
    };
  }

  async revokeSession(tokenFingerprint: string): Promise<void> {
    await this.pool.query(`DELETE FROM sessions WHERE token_fingerprint = $1`, [tokenFingerprint]);
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
    const id = randomUUID() as Id;
    const game = new Game(difficultyConfig(difficulty));
    const snapshot = game.snapshot();
    const res = await this.pool.query<{ created_at: Date }>(
      `INSERT INTO towns (id, name, difficulty, day, phase, town_defense,
                          game_over, next_citizen_seq, bank_wood, bank_metal, bank_water)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING created_at`,
      [
        id,
        trimmed,
        difficulty,
        snapshot.day,
        snapshot.phase,
        snapshot.townDefense,
        snapshot.gameOver,
        snapshot.nextCitizenSeq,
        snapshot.bank.wood,
        snapshot.bank.metal,
        snapshot.bank.water,
      ],
    );
    const town: TownRecord = {
      id,
      name: trimmed,
      difficulty,
      createdAt: res.rows[0]!.created_at,
      game,
      membership: new Map(),
      closed: false,
    };
    this.towns.set(id, town);
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

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.upsertCitizen(client, town.id, accountId, citizen);
      await client.query(
        `INSERT INTO town_memberships (town_id, account_id, citizen_id)
         VALUES ($1, $2, $3)`,
        [town.id, accountId, citizen.id],
      );
      await client.query(
        `UPDATE towns SET next_citizen_seq = $2 WHERE id = $1`,
        [town.id, town.game.snapshot().nextCitizenSeq],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      // Compense la mutation in-memory si le commit échoue.
      town.membership.delete(accountId);
      throw err;
    } finally {
      client.release();
    }
    return { citizenId: citizen.id };
  }

  async citizenIdFor(townId: Id, accountId: Id): Promise<string | undefined> {
    return this.towns.get(townId)?.membership.get(accountId);
  }

  async saveTown(town: TownRecord): Promise<void> {
    const snapshot = town.game.snapshot();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE towns
           SET day = $2,
               phase = $3,
               town_defense = $4,
               game_over = $5,
               next_citizen_seq = $6,
               bank_wood = $7,
               bank_metal = $8,
               bank_water = $9,
               closed = $10
         WHERE id = $1`,
        [
          town.id,
          snapshot.day,
          snapshot.phase,
          snapshot.townDefense,
          snapshot.gameOver,
          snapshot.nextCitizenSeq,
          snapshot.bank.wood,
          snapshot.bank.metal,
          snapshot.bank.water,
          town.closed,
        ],
      );
      const reverseMembership = new Map<string, Id>();
      for (const [accountId, citizenId] of town.membership.entries()) {
        reverseMembership.set(citizenId, accountId);
      }
      for (const c of snapshot.citizens) {
        const accountId = reverseMembership.get(c.id);
        await this.upsertCitizen(client, town.id, accountId ?? null, c);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  private async upsertCitizen(
    client: PoolClient,
    townId: Id,
    accountId: Id | null,
    citizen: Citizen,
  ): Promise<void> {
    await client.query(
      `INSERT INTO citizens
         (town_id, id, account_id, name, alive, location, action_points,
          consecutive_thirst_days, cause_of_death)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (town_id, id) DO UPDATE SET
         account_id              = EXCLUDED.account_id,
         name                    = EXCLUDED.name,
         alive                   = EXCLUDED.alive,
         location                = EXCLUDED.location,
         action_points           = EXCLUDED.action_points,
         consecutive_thirst_days = EXCLUDED.consecutive_thirst_days,
         cause_of_death          = EXCLUDED.cause_of_death`,
      [
        townId,
        citizen.id,
        accountId,
        citizen.name,
        citizen.alive,
        citizen.location,
        citizen.actionPoints,
        citizen.consecutiveThirstDays,
        citizen.causeOfDeath ?? null,
      ],
    );
  }

  async recordNightEvent(townId: Id, event: NightEventInput): Promise<void> {
    await this.pool.query(
      `INSERT INTO night_events (town_id, day, attackers, defense, breached, deaths)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [townId, event.day, event.attackers, event.defense, event.breached, event.deaths],
    );
  }

  /**
   * Lock NX-EX via `pg_try_advisory_lock`. La clé est dérivée du UUID de
   * la ville (16 premiers hex de son md5, projetés sur un bigint). Le lock
   * est lié à la connexion : il est automatiquement libéré si le process
   * crashe (pas de verrou orphelin à nettoyer à la main).
   */
  async nightLock<T>(townId: Id, fn: () => Promise<T> | T): Promise<T> {
    const client = await this.pool.connect();
    try {
      const tryLock = await client.query<{ acquired: boolean }>(
        `SELECT pg_try_advisory_lock(
           ('x' || substr(md5($1), 1, 16))::bit(64)::bigint
         ) AS acquired`,
        [townId],
      );
      if (!tryLock.rows[0]?.acquired) {
        throw new StoreError('night-already-running', 'La nuit est déjà en cours');
      }
      try {
        return await fn();
      } finally {
        await client
          .query(
            `SELECT pg_advisory_unlock(
               ('x' || substr(md5($1), 1, 16))::bit(64)::bigint
             )`,
            [townId],
          )
          .catch(() => undefined);
      }
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

interface PgError {
  code?: string;
}

function isUniqueViolation(err: unknown): err is PgError {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as PgError).code === '23505'
  );
}
