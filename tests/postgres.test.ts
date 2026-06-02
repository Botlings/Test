/**
 * Tests d'intégration Postgres.
 *
 * Ces tests ne tournent que si `DATABASE_URL_TEST` est défini (sinon le bloc
 * est marqué `skip`). La CI / le dev posera cette variable avec une base
 * dédiée — JAMAIS la production : les tables sont DROP/TRUNCATE entre tests.
 *
 * Couverture :
 *   - migrations idempotentes
 *   - comptes : createAccount + unique email + getAccount + findByEmail
 *   - sessions : create/consume/revoke
 *   - villes : create, list, join, persistance d'actions, rechargement
 *   - lock NX-EX (`pg_try_advisory_lock`) : deux résolutions concurrentes
 *     → la seconde lève StoreError('night-already-running')
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Id } from '../src/persistence/types.js';
import { PgStore } from '../src/persistence/postgres.js';
import { StoreError } from '../src/persistence/store.js';

const databaseUrl = process.env['DATABASE_URL_TEST'];
const describePg = databaseUrl ? describe : describe.skip;

describePg('PgStore — intégration Postgres', () => {
  let store: PgStore;

  beforeAll(async () => {
    store = new PgStore(databaseUrl!);
    await store.init();
  });

  afterAll(async () => {
    await store.close();
  });

  beforeEach(async () => {
    // Nettoyage entre tests (l'ordre de DELETE respecte les FKs).
    const pool = (store as unknown as { pool: import('pg').Pool }).pool;
    await pool.query('DELETE FROM night_locks');
    await pool.query('DELETE FROM night_events');
    await pool.query('DELETE FROM town_memberships');
    await pool.query('DELETE FROM citizens');
    await pool.query('DELETE FROM towns');
    await pool.query('DELETE FROM sessions');
    await pool.query('DELETE FROM accounts');
    // Réinitialise le cache in-memory : on recharge depuis la base vide.
    (store as unknown as { towns: Map<Id, unknown> }).towns.clear();
  });

  it('runMigrations est idempotent', async () => {
    await store.runMigrations();
    await store.runMigrations(); // ne doit pas échouer
  });

  describe('comptes', () => {
    it('crée un compte et le retrouve par email ou id', async () => {
      const account = await store.createAccount('alia@hordes.test', '$argon2id$hash');
      expect(account.id).toMatch(/[0-9a-f-]{36}/);
      const byEmail = await store.findAccountByEmail('alia@hordes.test');
      expect(byEmail?.id).toBe(account.id);
      const byId = await store.getAccount(account.id);
      expect(byId?.email).toBe('alia@hordes.test');
    });

    it('rejette un email déjà utilisé (StoreError email-taken)', async () => {
      await store.createAccount('dup@hordes.test', 'h');
      await expect(store.createAccount('dup@hordes.test', 'h')).rejects.toMatchObject({
        code: 'email-taken',
      });
    });
  });

  describe('sessions', () => {
    it('cycle create → consume → undefined la fois suivante', async () => {
      const account = await store.createAccount('sess@hordes.test', 'h');
      await store.createSession('fp1', account.id);
      const consumed = await store.consumeSession('fp1');
      expect(consumed?.accountId).toBe(account.id);
      // Une session consommée n'est plus utilisable.
      const reconsumed = await store.consumeSession('fp1');
      expect(reconsumed).toBeUndefined();
    });

    it('consume retourne undefined si la session est expirée', async () => {
      const account = await store.createAccount('exp@hordes.test', 'h');
      await store.createSession('fp2', account.id, -1000); // déjà expirée
      const consumed = await store.consumeSession('fp2');
      expect(consumed).toBeUndefined();
    });

    it('revoke supprime la session', async () => {
      const account = await store.createAccount('rev@hordes.test', 'h');
      await store.createSession('fp3', account.id);
      await store.revokeSession('fp3');
      const consumed = await store.consumeSession('fp3');
      expect(consumed).toBeUndefined();
    });
  });

  describe('villes', () => {
    it('crée, rejoint et liste les villes ouvertes', async () => {
      const acc = await store.createAccount('founder@hordes.test', 'h');
      const town = await store.createTown('Aldebaran', 'normal');
      await store.joinTown(town.id, acc.id, 'founder');
      const open = await store.listOpenTowns();
      expect(open.map((t) => t.id)).toContain(town.id);
    });

    it('persiste les actions et survit à un rechargement', async () => {
      const acc = await store.createAccount('persist@hordes.test', 'h');
      const town = await store.createTown('Persistia', 'normal');
      await store.joinTown(town.id, acc.id, 'persist');
      const citizenId = town.membership.get(acc.id)!;
      town.game.build(citizenId);
      await store.saveTown(town);
      const defenseAfter = town.game.status().townDefense;

      // Nouveau store branché sur la même base : doit retrouver l'état.
      const reloaded = new PgStore(databaseUrl!);
      await reloaded.init();
      try {
        const got = await reloaded.getTown(town.id);
        expect(got).toBeDefined();
        expect(got!.game.status().townDefense).toBe(defenseAfter);
        expect(got!.membership.get(acc.id)).toBe(citizenId);
      } finally {
        await reloaded.close();
      }
    });

    it('rejette un nom trop court (town-name-invalid)', async () => {
      await expect(store.createTown('ab', 'normal')).rejects.toMatchObject({
        code: 'town-name-invalid',
      });
    });

    it('rejette une double inscription (already-joined)', async () => {
      const acc = await store.createAccount('twice@hordes.test', 'h');
      const town = await store.createTown('Twicia', 'normal');
      await store.joinTown(town.id, acc.id, 'twice');
      await expect(store.joinTown(town.id, acc.id, 'twice')).rejects.toMatchObject({
        code: 'already-joined',
      });
    });
  });

  describe('nightLock — sémantique NX-EX', () => {
    it('deux résolutions concurrentes → la seconde lève "night-already-running"', async () => {
      const acc = await store.createAccount('lock@hordes.test', 'h');
      const town = await store.createTown('Lockia', 'normal');
      await store.joinTown(town.id, acc.id, 'lock');

      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const slowOp = store.nightLock(town.id, async () => {
        await gate;
        return 'ok';
      });
      // Petite latence pour laisser le 1er lock s'acquérir avant le 2nd.
      await new Promise((r) => setTimeout(r, 50));
      const racing = store.nightLock(town.id, async () => 'fast').catch((err) => err);
      const err = await racing;
      expect(err).toBeInstanceOf(StoreError);
      expect((err as StoreError).code).toBe('night-already-running');
      release();
      await expect(slowOp).resolves.toBe('ok');
    });

    it('enregistre un événement de nuit', async () => {
      const acc = await store.createAccount('night@hordes.test', 'h');
      const town = await store.createTown('Nightia', 'normal');
      await store.joinTown(town.id, acc.id, 'night');
      await store.recordNightEvent(town.id, {
        day: 1,
        attackers: 12,
        defense: 10,
        breached: true,
        deaths: 1,
      });
      const pool = (store as unknown as { pool: import('pg').Pool }).pool;
      const res = await pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM night_events WHERE town_id = $1`,
        [town.id],
      );
      expect(Number(res.rows[0]!.count)).toBe(1);
    });
  });
});
