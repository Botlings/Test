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
import type { AchievementId } from '../domain/achievements.js';
import { sanitizeBuildingState } from '../domain/buildings.js';
import { sanitizeDesertMap, seedFromString } from '../domain/desert.js';
import { emptyGovernance, sanitizeGovernance } from '../domain/governance.js';
import type { Citizen, Location, NightReport, Phase } from '../domain/types.js';
import type { Id } from './types.js';
import {
  MAX_CITIZENS_PER_TOWN,
  REFRESH_TOKEN_TTL_MS,
  StoreError,
  type AccountRecord,
  type AccountTownEntry,
  type AchievementUnlock,
  type ActivityEntry,
  type ActivityInput,
  type ActivityKind,
  type BankPolicy,
  type Difficulty,
  type LeaveTownResult,
  type ForumMessageRecord,
  type ForumThreadDetail,
  type ForumThreadKind,
  type ForumThreadRecord,
  type ForumThreadSummary,
  type ForumVoteOption,
  type ForumVoteTally,
  type GameResultInput,
  type GameResultOutcome,
  type LeaderboardEntry,
  type NightEventInput,
  type NightTrigger,
  type SessionRecord,
  type StoredNightReport,
  type Store,
  type TownQueueEntry,
  type TownRecord,
} from './store.js';
import { difficultyConfig, normalizeVoteOptions } from './memory.js';

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
      buildings: unknown;
      desert: unknown;
      desert_seed: string | number;
      founder_account_id: Id | null;
      bank_policy: BankPolicy;
      governance: unknown;
    }>(
      `SELECT id, name, difficulty, created_at, closed, day, phase, town_defense,
              game_over, next_citizen_seq, bank_wood, bank_metal, bank_water,
              buildings, desert, desert_seed, founder_account_id, bank_policy,
              governance
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
      position_x: number | null;
      position_y: number | null;
      water_canteen: number;
    }>(
      `SELECT town_id, id, name, alive, location, action_points,
              consecutive_thirst_days, cause_of_death,
              position_x, position_y, water_canteen
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
        position:
          row.location === 'desert' && row.position_x !== null && row.position_y !== null
            ? { x: row.position_x, y: row.position_y }
            : null,
        waterCanteen: row.water_canteen,
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
      const seedNumeric =
        typeof row.desert_seed === 'string'
          ? Number.parseInt(row.desert_seed, 10)
          : row.desert_seed;
      const desertSeed =
        Number.isFinite(seedNumeric) && seedNumeric !== 0
          ? (seedNumeric >>> 0)
          : seedFromString(`town-${row.id}`);
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
        buildings: sanitizeBuildingState(row.buildings),
        desert: sanitizeDesertMap(row.desert, desertSeed),
        desertSeed,
      });
      const town: TownRecord = {
        id: row.id,
        name: row.name,
        difficulty: row.difficulty,
        createdAt: row.created_at,
        game,
        membership: membershipByTown.get(row.id) ?? new Map(),
        closed: row.closed,
        founderAccountId: row.founder_account_id ?? null,
        bankPolicy: row.bank_policy === 'restricted' ? 'restricted' : 'open',
        bankManagers: new Set<Id>(),
        queue: [],
        governance: sanitizeGovernance(row.governance),
      };
      this.towns.set(row.id, town);
    }

    // Hydrate les gestionnaires de banque et la file d'attente.
    const managersRes = await this.pool.query<{ town_id: Id; account_id: Id }>(
      `SELECT town_id, account_id FROM town_bank_managers`,
    );
    for (const row of managersRes.rows) {
      this.towns.get(row.town_id)?.bankManagers.add(row.account_id);
    }
    const queueRes = await this.pool.query<{ town_id: Id; account_id: Id }>(
      `SELECT town_id, account_id FROM town_queue ORDER BY town_id, enqueued_at ASC`,
    );
    for (const row of queueRes.rows) {
      this.towns.get(row.town_id)?.queue.push(row.account_id);
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

  async listOngoingTowns(): Promise<TownRecord[]> {
    return [...this.towns.values()].filter((t) => !t.closed);
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
    const desertSeed = seedFromString(`town-${id}`);
    const game = new Game(difficultyConfig(difficulty), desertSeed);
    const snapshot = game.snapshot();
    const res = await this.pool.query<{ created_at: Date }>(
      `INSERT INTO towns (id, name, difficulty, day, phase, town_defense,
                          game_over, next_citizen_seq, bank_wood, bank_metal,
                          bank_water, buildings, desert, desert_seed)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb, $14)
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
        JSON.stringify(snapshot.buildings ?? {}),
        JSON.stringify(snapshot.desert ?? {}),
        desertSeed,
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
      founderAccountId: null,
      bankPolicy: 'open',
      bankManagers: new Set<Id>(),
      queue: [],
      governance: emptyGovernance(),
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
    const wasEmpty = town.membership.size === 0;
    const becomesFounder = wasEmpty && !town.founderAccountId;
    const citizen = town.game.addCitizen(citizenName);
    town.membership.set(accountId, citizen.id);
    if (becomesFounder) town.founderAccountId = accountId;

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
        `UPDATE towns SET next_citizen_seq = $2${becomesFounder ? ', founder_account_id = $3' : ''} WHERE id = $1`,
        becomesFounder
          ? [town.id, town.game.snapshot().nextCitizenSeq, accountId]
          : [town.id, town.game.snapshot().nextCitizenSeq],
      );
      // Un compte qui rejoint quitte la file d'attente.
      await client.query(
        `DELETE FROM town_queue WHERE town_id = $1 AND account_id = $2`,
        [town.id, accountId],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      // Compense la mutation in-memory si le commit échoue.
      town.membership.delete(accountId);
      if (becomesFounder) town.founderAccountId = null;
      throw err;
    } finally {
      client.release();
    }
    const qi = town.queue.indexOf(accountId);
    if (qi !== -1) town.queue.splice(qi, 1);
    return { citizenId: citizen.id };
  }

  async citizenIdFor(townId: Id, accountId: Id): Promise<string | undefined> {
    return this.towns.get(townId)?.membership.get(accountId);
  }

  async leaveTown(townId: Id, accountId: Id): Promise<LeaveTownResult> {
    const town = this.towns.get(townId);
    if (!town) {
      throw new StoreError('town-not-found', 'Ville introuvable');
    }
    if (town.closed) {
      throw new StoreError('town-closed', 'Cette ville est terminée');
    }

    const qi = town.queue.indexOf(accountId);
    const citizenId = town.membership.get(accountId);

    if (!citizenId) {
      // Compte non membre : on l'évacue juste de la file s'il y était.
      if (qi !== -1) {
        town.queue.splice(qi, 1);
        await this.pool
          .query(`DELETE FROM town_queue WHERE town_id = $1 AND account_id = $2`, [townId, accountId])
          .catch(() => undefined);
      }
      return { removedCitizenId: null, promoted: null };
    }

    // Retire le citoyen du moteur et de la base, puis promeut la tête de file.
    town.game.removeCitizen(citizenId);
    town.membership.delete(accountId);
    town.bankManagers.delete(accountId);
    if (qi !== -1) town.queue.splice(qi, 1);
    const newFounder =
      town.founderAccountId === accountId
        ? (town.membership.keys().next().value ?? null)
        : town.founderAccountId;

    let promoted: LeaveTownResult['promoted'] = null;
    let promotedAccount: AccountRecord | undefined;
    while (town.queue.length > 0 && town.membership.size < MAX_CITIZENS_PER_TOWN) {
      const nextAccountId = town.queue[0]!;
      if (town.membership.has(nextAccountId)) {
        town.queue.shift();
        continue;
      }
      const account = await this.getAccount(nextAccountId);
      if (!account) {
        town.queue.shift();
        continue;
      }
      town.queue.shift();
      const citizenName = account.email.split('@')[0]!;
      const citizen = town.game.addCitizen(citizenName);
      town.membership.set(nextAccountId, citizen.id);
      promoted = { accountId: nextAccountId, citizenId: citizen.id, citizenName };
      promotedAccount = account;
      break;
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`DELETE FROM citizens WHERE town_id = $1 AND id = $2`, [townId, citizenId]);
      await client.query(
        `DELETE FROM town_memberships WHERE town_id = $1 AND account_id = $2`,
        [townId, accountId],
      );
      await client.query(
        `DELETE FROM town_bank_managers WHERE town_id = $1 AND account_id = $2`,
        [townId, accountId],
      );
      await client.query(`DELETE FROM town_queue WHERE town_id = $1 AND account_id = $2`, [
        townId,
        accountId,
      ]);
      if (newFounder !== town.founderAccountId) {
        town.founderAccountId = newFounder;
        await client.query(`UPDATE towns SET founder_account_id = $2 WHERE id = $1`, [
          townId,
          newFounder,
        ]);
      }
      if (promoted && promotedAccount) {
        const citizen = town.game
          .status()
          .citizens.find((c) => c.id === promoted!.citizenId)!;
        await this.upsertCitizen(client, townId, promoted.accountId, citizen);
        await client.query(
          `INSERT INTO town_memberships (town_id, account_id, citizen_id) VALUES ($1, $2, $3)`,
          [townId, promoted.accountId, promoted.citizenId],
        );
        await client.query(`DELETE FROM town_queue WHERE town_id = $1 AND account_id = $2`, [
          townId,
          promoted.accountId,
        ]);
        await client.query(`UPDATE towns SET next_citizen_seq = $2 WHERE id = $1`, [
          townId,
          town.game.snapshot().nextCitizenSeq,
        ]);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    return { removedCitizenId: citizenId, promoted };
  }

  async enqueueForTown(
    townId: Id,
    accountId: Id,
  ): Promise<{ position: number; size: number }> {
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
    if (town.membership.size < MAX_CITIZENS_PER_TOWN) {
      throw new StoreError('town-not-full', 'Cette ville n\'est pas pleine : rejoignez-la directement');
    }
    if (town.queue.includes(accountId)) {
      throw new StoreError('already-queued', 'Vous êtes déjà dans la file d\'attente');
    }
    await this.pool.query(
      `INSERT INTO town_queue (town_id, account_id) VALUES ($1, $2)
       ON CONFLICT (town_id, account_id) DO NOTHING`,
      [townId, accountId],
    );
    town.queue.push(accountId);
    return { position: town.queue.length, size: town.queue.length };
  }

  async leaveQueue(townId: Id, accountId: Id): Promise<void> {
    const town = this.towns.get(townId);
    if (town) {
      const i = town.queue.indexOf(accountId);
      if (i !== -1) town.queue.splice(i, 1);
    }
    await this.pool
      .query(`DELETE FROM town_queue WHERE town_id = $1 AND account_id = $2`, [townId, accountId])
      .catch(() => undefined);
  }

  async getQueue(townId: Id): Promise<TownQueueEntry[]> {
    const town = this.towns.get(townId);
    if (!town) return [];
    const res = await this.pool.query<{ account_id: Id; enqueued_at: Date }>(
      `SELECT account_id, enqueued_at FROM town_queue WHERE town_id = $1 ORDER BY enqueued_at ASC`,
      [townId],
    );
    if (res.rowCount && res.rowCount > 0) {
      return res.rows.map((r, idx) => ({
        accountId: r.account_id,
        position: idx + 1,
        enqueuedAt: r.enqueued_at,
      }));
    }
    // Repli sur le cache mémoire si la table est vide (ex. tests sans DB).
    return town.queue.map((accountId, idx) => ({
      accountId,
      position: idx + 1,
      enqueuedAt: new Date(),
    }));
  }

  async setBankPolicy(townId: Id, policy: BankPolicy): Promise<void> {
    const town = this.towns.get(townId);
    if (!town) {
      throw new StoreError('town-not-found', 'Ville introuvable');
    }
    town.bankPolicy = policy;
    await this.pool.query(`UPDATE towns SET bank_policy = $2 WHERE id = $1`, [townId, policy]);
  }

  async setBankManager(townId: Id, accountId: Id, allowed: boolean): Promise<void> {
    const town = this.towns.get(townId);
    if (!town) {
      throw new StoreError('town-not-found', 'Ville introuvable');
    }
    if (!town.membership.has(accountId)) {
      throw new StoreError('not-a-citizen', 'Ce compte n\'est pas citoyen de la ville');
    }
    if (town.founderAccountId === accountId) {
      throw new StoreError('founder-immutable', 'Le fondateur est gestionnaire permanent');
    }
    if (allowed) {
      town.bankManagers.add(accountId);
      await this.pool.query(
        `INSERT INTO town_bank_managers (town_id, account_id) VALUES ($1, $2)
         ON CONFLICT (town_id, account_id) DO NOTHING`,
        [townId, accountId],
      );
    } else {
      town.bankManagers.delete(accountId);
      await this.pool.query(
        `DELETE FROM town_bank_managers WHERE town_id = $1 AND account_id = $2`,
        [townId, accountId],
      );
    }
  }

  async listAccountTowns(accountId: Id): Promise<AccountTownEntry[]> {
    const res = await this.pool.query<{ town_id: Id; joined_at: Date }>(
      `SELECT town_id, joined_at
         FROM town_memberships
        WHERE account_id = $1`,
      [accountId],
    );
    const entries: AccountTownEntry[] = [];
    for (const row of res.rows) {
      const town = this.towns.get(row.town_id);
      if (!town) continue;
      const citizenId = town.membership.get(accountId);
      if (!citizenId) continue;
      const status = town.game.status();
      const citizen = status.citizens.find((c) => c.id === citizenId);
      if (!citizen) continue;
      entries.push({
        townId: town.id,
        townName: town.name,
        difficulty: town.difficulty,
        joinedAt: row.joined_at,
        currentDay: status.day,
        phase: status.phase,
        gameOver: status.gameOver,
        outcome: status.outcome,
        closed: town.closed,
        citizen: {
          id: citizen.id,
          name: citizen.name,
          alive: citizen.alive,
          causeOfDeath: citizen.causeOfDeath ?? null,
        },
      });
    }
    entries.sort((a, b) => b.joinedAt.getTime() - a.joinedAt.getTime());
    return entries;
  }

  /* --------------------------- Hauts faits ------------------------------ */

  async unlockAchievement(accountId: Id, achievementId: AchievementId): Promise<boolean> {
    const res = await this.pool.query(
      `INSERT INTO account_achievements (account_id, achievement_id)
       VALUES ($1, $2)
       ON CONFLICT (account_id, achievement_id) DO NOTHING`,
      [accountId, achievementId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async listAccountAchievements(accountId: Id): Promise<AchievementUnlock[]> {
    const res = await this.pool.query<{ achievement_id: AchievementId; unlocked_at: Date }>(
      `SELECT achievement_id, unlocked_at
         FROM account_achievements
        WHERE account_id = $1
        ORDER BY unlocked_at ASC`,
      [accountId],
    );
    return res.rows.map((r) => ({
      achievementId: r.achievement_id,
      unlockedAt: r.unlocked_at,
    }));
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
               closed = $10,
               buildings = $11::jsonb,
               desert = $12::jsonb,
               desert_seed = $13,
               governance = $14::jsonb
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
          JSON.stringify(snapshot.buildings ?? {}),
          JSON.stringify(snapshot.desert ?? {}),
          snapshot.desertSeed ?? 0,
          JSON.stringify(town.governance ?? emptyGovernance()),
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
          consecutive_thirst_days, cause_of_death,
          position_x, position_y, water_canteen)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (town_id, id) DO UPDATE SET
         account_id              = EXCLUDED.account_id,
         name                    = EXCLUDED.name,
         alive                   = EXCLUDED.alive,
         location                = EXCLUDED.location,
         action_points           = EXCLUDED.action_points,
         consecutive_thirst_days = EXCLUDED.consecutive_thirst_days,
         cause_of_death          = EXCLUDED.cause_of_death,
         position_x              = EXCLUDED.position_x,
         position_y              = EXCLUDED.position_y,
         water_canteen           = EXCLUDED.water_canteen`,
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
        citizen.position ? citizen.position.x : null,
        citizen.position ? citizen.position.y : null,
        citizen.waterCanteen,
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

  async recordNightReport(
    townId: Id,
    trigger: NightTrigger,
    report: NightReport,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO night_reports (town_id, day, trigger, report)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [townId, report.day, trigger, JSON.stringify(report)],
    );
  }

  async listNightReports(townId: Id, limit = 20): Promise<StoredNightReport[]> {
    const safeLimit = Math.max(0, Math.min(100, Math.trunc(limit)));
    const res = await this.pool.query<{
      trigger: NightTrigger;
      created_at: Date;
      report: NightReport;
    }>(
      `SELECT trigger, created_at, report
         FROM night_reports
        WHERE town_id = $1
        ORDER BY created_at DESC
        LIMIT $2`,
      [townId, safeLimit],
    );
    return res.rows.map((row) => ({
      trigger: row.trigger,
      storedAt: row.created_at,
      report: row.report,
    }));
  }

  /* ---------------------------- Fin de partie ---------------------------- */

  async recordGameResult(townId: Id, result: GameResultInput): Promise<void> {
    const town = this.towns.get(townId);
    await this.pool.query(
      `INSERT INTO game_results
         (town_id, town_name, difficulty, outcome, days_survived, survivors, population)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (town_id) DO UPDATE SET
         town_name     = EXCLUDED.town_name,
         difficulty    = EXCLUDED.difficulty,
         outcome       = EXCLUDED.outcome,
         days_survived = EXCLUDED.days_survived,
         survivors     = EXCLUDED.survivors,
         population    = EXCLUDED.population,
         ended_at      = now()`,
      [
        townId,
        town?.name ?? 'Ville inconnue',
        result.difficulty,
        result.outcome,
        result.daysSurvived,
        result.survivors,
        result.population,
      ],
    );
  }

  async listLeaderboard(limit = 20): Promise<LeaderboardEntry[]> {
    const safe = Math.max(0, Math.min(100, Math.trunc(limit)));
    const res = await this.pool.query<{
      town_id: Id;
      town_name: string;
      difficulty: Difficulty;
      outcome: GameResultOutcome;
      days_survived: number;
      survivors: number;
      population: number;
      ended_at: Date;
    }>(
      `SELECT town_id, town_name, difficulty, outcome, days_survived,
              survivors, population, ended_at
         FROM game_results
        ORDER BY (outcome = 'victory') DESC,
                 days_survived DESC,
                 survivors DESC,
                 ended_at ASC
        LIMIT $1`,
      [safe],
    );
    return res.rows.map((row, idx) => ({
      rank: idx + 1,
      townId: row.town_id,
      townName: row.town_name,
      difficulty: row.difficulty,
      outcome: row.outcome,
      daysSurvived: row.days_survived,
      survivors: row.survivors,
      population: row.population,
      endedAt: row.ended_at,
    }));
  }

  /* ---------------------------- Forum ------------------------------------ */

  async createForumThread(input: {
    readonly townId: Id;
    readonly authorAccountId: Id;
    readonly authorCitizenName: string;
    readonly title: string;
    readonly kind: ForumThreadKind;
    readonly options?: readonly ForumVoteOption[];
    readonly closesAt?: Date | null;
    readonly body?: string;
  }): Promise<ForumThreadDetail> {
    const town = this.towns.get(input.townId);
    if (!town) {
      throw new StoreError('town-not-found', 'Ville introuvable');
    }
    const title = input.title.trim();
    if (title.length < 3 || title.length > 120) {
      throw new StoreError('thread-title-invalid', 'Le titre doit faire 3 à 120 caractères');
    }
    const options = input.kind === 'vote' ? normalizeVoteOptions(input.options) : [];
    const id = randomUUID() as Id;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO forum_threads
           (id, town_id, author_account_id, author_citizen_name, title, kind, options, closes_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
        [
          id,
          input.townId,
          input.authorAccountId,
          input.authorCitizenName,
          title,
          input.kind,
          JSON.stringify(options),
          input.closesAt ?? null,
        ],
      );
      if (input.body && input.body.trim().length > 0) {
        const body = input.body.trim();
        if (body.length > 1000) {
          throw new StoreError('message-body-invalid', 'Le message doit faire 1 à 1000 caractères');
        }
        await client.query(
          `INSERT INTO forum_messages
             (thread_id, town_id, author_account_id, author_citizen_name, body)
           VALUES ($1, $2, $3, $4, $5)`,
          [id, input.townId, input.authorAccountId, input.authorCitizenName, body],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    const detail = await this.getForumThread(input.townId, id, input.authorAccountId);
    return detail!;
  }

  async listForumThreads(
    townId: Id,
    viewerAccountId?: Id,
  ): Promise<ForumThreadSummary[]> {
    const threadsRes = await this.pool.query<ForumThreadRow>(
      `SELECT id, town_id, author_account_id, author_citizen_name, title, kind,
              options, closes_at, closed, created_at
         FROM forum_threads
        WHERE town_id = $1
        ORDER BY created_at DESC`,
      [townId],
    );
    if (threadsRes.rowCount === 0) return [];
    const ids = threadsRes.rows.map((r) => r.id);
    const counts = await this.pool.query<{
      thread_id: Id;
      message_count: string;
      last_message_at: Date | null;
    }>(
      `SELECT thread_id,
              COUNT(*)::text AS message_count,
              MAX(created_at) AS last_message_at
         FROM forum_messages
        WHERE thread_id = ANY($1::uuid[])
        GROUP BY thread_id`,
      [ids],
    );
    const countByThread = new Map(
      counts.rows.map((r) => [r.thread_id, r] as const),
    );
    const voteCounts = await this.pool.query<{ thread_id: Id; vote_count: string }>(
      `SELECT thread_id, COUNT(*)::text AS vote_count
         FROM forum_votes
        WHERE thread_id = ANY($1::uuid[])
        GROUP BY thread_id`,
      [ids],
    );
    const voteCountByThread = new Map(
      voteCounts.rows.map((r) => [r.thread_id, Number.parseInt(r.vote_count, 10)] as const),
    );
    void viewerAccountId;
    return threadsRes.rows.map((row) => {
      const c = countByThread.get(row.id);
      const thread = rowToThread(row);
      this.maybeAutoClose(thread);
      return {
        ...thread,
        messageCount: c ? Number.parseInt(c.message_count, 10) : 0,
        lastMessageAt: c?.last_message_at ?? null,
        voteCount: voteCountByThread.get(row.id) ?? 0,
      };
    });
  }

  async getForumThread(
    townId: Id,
    threadId: Id,
    viewerAccountId?: Id,
  ): Promise<ForumThreadDetail | undefined> {
    const threadRes = await this.pool.query<ForumThreadRow>(
      `SELECT id, town_id, author_account_id, author_citizen_name, title, kind,
              options, closes_at, closed, created_at
         FROM forum_threads
        WHERE id = $1 AND town_id = $2`,
      [threadId, townId],
    );
    const row = threadRes.rows[0];
    if (!row) return undefined;
    const thread = rowToThread(row);
    this.maybeAutoClose(thread);
    if (thread.closed && !row.closed) {
      await this.pool.query(`UPDATE forum_threads SET closed = true WHERE id = $1`, [threadId]);
    }
    const messagesRes = await this.pool.query<{
      id: Id;
      thread_id: Id;
      town_id: Id;
      author_account_id: Id;
      author_citizen_name: string;
      body: string;
      created_at: Date;
    }>(
      `SELECT id, thread_id, town_id, author_account_id, author_citizen_name, body, created_at
         FROM forum_messages
        WHERE thread_id = $1
        ORDER BY created_at ASC`,
      [threadId],
    );
    const messages: ForumMessageRecord[] = messagesRes.rows.map((m) => ({
      id: m.id,
      threadId: m.thread_id,
      townId: m.town_id,
      authorAccountId: m.author_account_id,
      authorCitizenName: m.author_citizen_name,
      body: m.body,
      createdAt: m.created_at,
    }));
    const tally = await this.computeTally(thread, viewerAccountId);
    const lastMessageAt = messages.length
      ? messages[messages.length - 1]!.createdAt
      : null;
    const summary: ForumThreadSummary = {
      ...thread,
      messageCount: messages.length,
      lastMessageAt,
      voteCount: tally.total,
    };
    return { thread: summary, messages, tally };
  }

  async postForumMessage(input: {
    readonly townId: Id;
    readonly threadId: Id;
    readonly authorAccountId: Id;
    readonly authorCitizenName: string;
    readonly body: string;
  }): Promise<ForumMessageRecord> {
    const threadRes = await this.pool.query<ForumThreadRow>(
      `SELECT id, town_id, author_account_id, author_citizen_name, title, kind,
              options, closes_at, closed, created_at
         FROM forum_threads
        WHERE id = $1 AND town_id = $2`,
      [input.threadId, input.townId],
    );
    const row = threadRes.rows[0];
    if (!row) {
      throw new StoreError('thread-not-found', 'Sujet introuvable');
    }
    const thread = rowToThread(row);
    this.maybeAutoClose(thread);
    if (thread.closed) {
      if (!row.closed) {
        await this.pool.query(`UPDATE forum_threads SET closed = true WHERE id = $1`, [thread.id]);
      }
      throw new StoreError('thread-closed', 'Ce sujet est fermé');
    }
    const body = input.body.trim();
    if (body.length < 1 || body.length > 1000) {
      throw new StoreError('message-body-invalid', 'Le message doit faire 1 à 1000 caractères');
    }
    const id = randomUUID() as Id;
    const res = await this.pool.query<{ created_at: Date }>(
      `INSERT INTO forum_messages
         (id, thread_id, town_id, author_account_id, author_citizen_name, body)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING created_at`,
      [
        id,
        input.threadId,
        input.townId,
        input.authorAccountId,
        input.authorCitizenName,
        body,
      ],
    );
    return {
      id,
      threadId: input.threadId,
      townId: input.townId,
      authorAccountId: input.authorAccountId,
      authorCitizenName: input.authorCitizenName,
      body,
      createdAt: res.rows[0]!.created_at,
    };
  }

  async castForumVote(input: {
    readonly townId: Id;
    readonly threadId: Id;
    readonly accountId: Id;
    readonly citizenName: string;
    readonly optionId: string;
  }): Promise<ForumVoteTally> {
    const threadRes = await this.pool.query<ForumThreadRow>(
      `SELECT id, town_id, author_account_id, author_citizen_name, title, kind,
              options, closes_at, closed, created_at
         FROM forum_threads
        WHERE id = $1 AND town_id = $2`,
      [input.threadId, input.townId],
    );
    const row = threadRes.rows[0];
    if (!row) {
      throw new StoreError('thread-not-found', 'Sujet introuvable');
    }
    const thread = rowToThread(row);
    if (thread.kind !== 'vote') {
      throw new StoreError('vote-not-allowed', 'Ce sujet n\'est pas un vote');
    }
    this.maybeAutoClose(thread);
    if (thread.closed) {
      if (!row.closed) {
        await this.pool.query(`UPDATE forum_threads SET closed = true WHERE id = $1`, [thread.id]);
      }
      throw new StoreError('vote-closed', 'Le vote est clos');
    }
    if (!thread.options.some((o) => o.id === input.optionId)) {
      throw new StoreError('option-invalid', 'Option de vote invalide');
    }
    await this.pool.query(
      `INSERT INTO forum_votes (thread_id, account_id, citizen_name, option_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (thread_id, account_id)
         DO UPDATE SET option_id = EXCLUDED.option_id,
                       citizen_name = EXCLUDED.citizen_name,
                       cast_at = now()`,
      [input.threadId, input.accountId, input.citizenName, input.optionId],
    );
    return this.computeTally(thread, input.accountId);
  }

  async closeForumThread(townId: Id, threadId: Id): Promise<ForumThreadSummary> {
    const res = await this.pool.query<ForumThreadRow>(
      `UPDATE forum_threads SET closed = true
        WHERE id = $1 AND town_id = $2
        RETURNING id, town_id, author_account_id, author_citizen_name, title, kind,
                  options, closes_at, closed, created_at`,
      [threadId, townId],
    );
    const row = res.rows[0];
    if (!row) {
      throw new StoreError('thread-not-found', 'Sujet introuvable');
    }
    const thread = rowToThread(row);
    const counts = await this.pool.query<{ c: string; l: Date | null }>(
      `SELECT COUNT(*)::text AS c, MAX(created_at) AS l
         FROM forum_messages WHERE thread_id = $1`,
      [threadId],
    );
    const voteCountRes = await this.pool.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM forum_votes WHERE thread_id = $1`,
      [threadId],
    );
    return {
      ...thread,
      messageCount: Number.parseInt(counts.rows[0]?.c ?? '0', 10),
      lastMessageAt: counts.rows[0]?.l ?? null,
      voteCount: Number.parseInt(voteCountRes.rows[0]?.c ?? '0', 10),
    };
  }

  private maybeAutoClose(thread: ForumThreadRecord): void {
    if (!thread.closed && thread.closesAt && thread.closesAt.getTime() <= Date.now()) {
      thread.closed = true;
    }
  }

  private async computeTally(
    thread: ForumThreadRecord,
    viewerAccountId?: Id,
  ): Promise<ForumVoteTally> {
    const res = await this.pool.query<{
      option_id: string;
      total: string;
    }>(
      `SELECT option_id, COUNT(*)::text AS total
         FROM forum_votes
        WHERE thread_id = $1
        GROUP BY option_id`,
      [thread.id],
    );
    const counts: Record<string, number> = {};
    for (const opt of thread.options) counts[opt.id] = 0;
    let total = 0;
    for (const row of res.rows) {
      const n = Number.parseInt(row.total, 10);
      counts[row.option_id] = (counts[row.option_id] ?? 0) + n;
      total += n;
    }
    let myChoice: string | null = null;
    if (viewerAccountId) {
      const mine = await this.pool.query<{ option_id: string }>(
        `SELECT option_id FROM forum_votes WHERE thread_id = $1 AND account_id = $2`,
        [thread.id, viewerAccountId],
      );
      myChoice = mine.rows[0]?.option_id ?? null;
    }
    return { threadId: thread.id, total, counts, myChoice };
  }

  /* ---------------------------- Activité --------------------------------- */

  async recordActivity(townId: Id, input: ActivityInput): Promise<ActivityEntry> {
    const id = randomUUID() as Id;
    const res = await this.pool.query<{ created_at: Date }>(
      `INSERT INTO activity_log
         (id, town_id, account_id, citizen_id, citizen_name, kind, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       RETURNING created_at`,
      [
        id,
        townId,
        input.accountId ?? null,
        input.citizenId ?? null,
        input.citizenName ?? null,
        input.kind,
        JSON.stringify(input.details ?? {}),
      ],
    );
    return {
      id,
      townId,
      accountId: input.accountId ?? null,
      citizenId: input.citizenId ?? null,
      citizenName: input.citizenName ?? null,
      kind: input.kind,
      details: input.details ?? {},
      createdAt: res.rows[0]!.created_at,
    };
  }

  async listActivity(townId: Id, limit = 50): Promise<ActivityEntry[]> {
    const safe = Math.max(0, Math.min(500, Math.trunc(limit)));
    const res = await this.pool.query<{
      id: Id;
      town_id: Id;
      account_id: Id | null;
      citizen_id: string | null;
      citizen_name: string | null;
      kind: ActivityKind;
      details: Record<string, string | number | boolean | null>;
      created_at: Date;
    }>(
      `SELECT id, town_id, account_id, citizen_id, citizen_name, kind, details, created_at
         FROM activity_log
        WHERE town_id = $1
        ORDER BY created_at DESC
        LIMIT $2`,
      [townId, safe],
    );
    return res.rows.map((r) => ({
      id: r.id,
      townId: r.town_id,
      accountId: r.account_id,
      citizenId: r.citizen_id,
      citizenName: r.citizen_name,
      kind: r.kind,
      details: r.details ?? {},
      createdAt: r.created_at,
    }));
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

  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

interface ForumThreadRow {
  readonly id: Id;
  readonly town_id: Id;
  readonly author_account_id: Id;
  readonly author_citizen_name: string;
  readonly title: string;
  readonly kind: ForumThreadKind;
  readonly options: readonly ForumVoteOption[];
  readonly closes_at: Date | null;
  readonly closed: boolean;
  readonly created_at: Date;
}

function rowToThread(row: ForumThreadRow): ForumThreadRecord {
  return {
    id: row.id,
    townId: row.town_id,
    authorAccountId: row.author_account_id,
    authorCitizenName: row.author_citizen_name,
    title: row.title,
    kind: row.kind,
    options: row.options ?? [],
    closesAt: row.closes_at,
    closed: row.closed,
    createdAt: row.created_at,
  };
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
