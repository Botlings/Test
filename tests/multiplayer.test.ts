/**
 * Tests du Jalon 2 — ville multijoueur : file d'attente + promotion
 * automatique, régime d'accès à la banque commune (droits fondateur /
 * gestionnaires) et départ de ville.
 *
 * La partie « file d'attente » remplit une ville jusqu'à sa capacité (40) au
 * niveau du Store en mémoire — les comptes y sont créés avec un hash factice,
 * ce qui évite 40 hachages argon2 (bien plus rapide qu'un parcours HTTP).
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { MemoryStore } from '../src/persistence/memory.js';
import { MAX_CITIZENS_PER_TOWN, StoreError } from '../src/persistence/store.js';
import type { Id } from '../src/persistence/types.js';
import { bearer, makeTestApp, register } from './helpers/app.js';

interface TownState {
  id: string;
  yourCitizenId: string;
  yourRole: string;
  bankPolicy: string;
  canSpendBank: boolean;
}

describe('File d\'attente et promotion (Store)', () => {
  it('met en file d\'attente sur ville pleine puis promeut la tête de file au départ d\'un membre', async () => {
    const store = new MemoryStore();
    const town = await store.createTown('Aldebaran', 'normal');

    // Remplit la ville jusqu'à la capacité maximale (40 habitants).
    const memberIds: Id[] = [];
    for (let i = 0; i < MAX_CITIZENS_PER_TOWN; i++) {
      const acc = await store.createAccount(`m${i}@hordes.test`, 'hash');
      await store.joinTown(town.id, acc.id, `m${i}`);
      memberIds.push(acc.id);
    }
    expect(town.membership.size).toBe(MAX_CITIZENS_PER_TOWN);
    expect(town.founderAccountId).toBe(memberIds[0]);

    // Un 41ème compte ne peut plus rejoindre directement.
    const late = await store.createAccount('late@hordes.test', 'hash');
    await expect(store.joinTown(town.id, late.id, 'late')).rejects.toMatchObject({
      code: 'town-full',
    });

    // …mais peut entrer dans la file d'attente.
    const enq = await store.enqueueForTown(town.id, late.id);
    expect(enq.position).toBe(1);
    expect(enq.size).toBe(1);

    // Rejoindre une ville non pleine est refusé côté file d'attente.
    const other = await store.createTown('Vega', 'normal');
    const solo = await store.createAccount('solo@hordes.test', 'hash');
    await store.joinTown(other.id, solo.id, 'solo');
    await expect(store.enqueueForTown(other.id, solo.id)).rejects.toBeInstanceOf(StoreError);

    // Un membre quitte → la tête de file est promue automatiquement.
    const result = await store.leaveTown(town.id, memberIds[5]!);
    expect(result.removedCitizenId).not.toBeNull();
    expect(result.promoted).not.toBeNull();
    expect(result.promoted!.accountId).toBe(late.id);

    expect(town.membership.has(late.id)).toBe(true);
    expect(town.membership.has(memberIds[5]!)).toBe(false);
    expect(town.membership.size).toBe(MAX_CITIZENS_PER_TOWN);
    expect((await store.getQueue(town.id)).length).toBe(0);
  });

  it('transfère le rôle de fondateur si le fondateur quitte', async () => {
    const store = new MemoryStore();
    const town = await store.createTown('Sirius', 'normal');
    const a = await store.createAccount('a@hordes.test', 'hash');
    const b = await store.createAccount('b@hordes.test', 'hash');
    await store.joinTown(town.id, a.id, 'a');
    await store.joinTown(town.id, b.id, 'b');
    expect(town.founderAccountId).toBe(a.id);

    await store.leaveTown(town.id, a.id);
    expect(town.founderAccountId).toBe(b.id);
    expect(town.membership.has(a.id)).toBe(false);
  });
});

describe('Banque commune : régime d\'accès et gestionnaires', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function setup() {
    const built = await makeTestApp();
    app = built.app;
    const founder = await register(built.app, 'founder@hordes.test', 'password!1');
    const created = await built.app.inject({
      method: 'POST',
      url: '/towns',
      headers: bearer(founder.body.accessToken!),
      payload: { name: 'Aldebaran', difficulty: 'normal' },
    });
    const town = created.json() as TownState;
    const member = await register(built.app, 'member@hordes.test', 'password!1');
    await built.app.inject({
      method: 'POST',
      url: `/towns/${town.id}/join`,
      headers: bearer(member.body.accessToken!),
    });
    const dash = await built.app.inject({
      method: 'GET',
      url: `/towns/${town.id}`,
      headers: bearer(member.body.accessToken!),
    });
    const memberCitizenId = (dash.json() as TownState).yourCitizenId;
    return { built, founder, member, town, memberCitizenId };
  }

  it('expose le fondateur et le régime open par défaut', async () => {
    const { built, founder, town } = await setup();
    const dash = await built.app.inject({
      method: 'GET',
      url: `/towns/${town.id}`,
      headers: bearer(founder.body.accessToken!),
    });
    const state = dash.json() as TownState;
    expect(state.yourRole).toBe('founder');
    expect(state.bankPolicy).toBe('open');
    expect(state.canSpendBank).toBe(true);
  });

  it('en régime restreint, un simple citoyen ne peut plus construire', async () => {
    const { built, founder, member, town, memberCitizenId } = await setup();

    // Le fondateur passe la banque en accès restreint.
    const setPolicy = await built.app.inject({
      method: 'PUT',
      url: `/towns/${town.id}/bank/policy`,
      headers: bearer(founder.body.accessToken!),
      payload: { policy: 'restricted' },
    });
    expect(setPolicy.statusCode).toBe(200);

    // Le membre non-gestionnaire est bloqué à la construction.
    const blocked = await built.app.inject({
      method: 'POST',
      url: `/towns/${town.id}/citizens/${memberCitizenId}/action`,
      headers: bearer(member.body.accessToken!),
      payload: { type: 'build' },
    });
    expect(blocked.statusCode).toBe(403);
    expect((blocked.json() as { error: { code: string } }).error.code).toBe('bank-restricted');

    // Le fondateur le nomme gestionnaire → il n'est plus bloqué par le régime.
    const grant = await built.app.inject({
      method: 'PUT',
      url: `/towns/${town.id}/bank/managers/${member.body.userId}`,
      headers: bearer(founder.body.accessToken!),
      payload: { allowed: true },
    });
    expect(grant.statusCode).toBe(200);

    const afterGrant = await built.app.inject({
      method: 'POST',
      url: `/towns/${town.id}/citizens/${memberCitizenId}/action`,
      headers: bearer(member.body.accessToken!),
      payload: { type: 'build' },
    });
    // Plus de blocage de régime : soit succès, soit règle métier (ressources),
    // mais jamais un refus 'bank-restricted'.
    if (afterGrant.statusCode !== 200) {
      expect((afterGrant.json() as { error: { code: string } }).error.code).not.toBe('bank-restricted');
    }
  });

  it('interdit à un simple citoyen de changer le régime, et à un non-fondateur de nommer un gestionnaire', async () => {
    const { built, member, town } = await setup();
    const policy = await built.app.inject({
      method: 'PUT',
      url: `/towns/${town.id}/bank/policy`,
      headers: bearer(member.body.accessToken!),
      payload: { policy: 'restricted' },
    });
    expect(policy.statusCode).toBe(403);
    expect((policy.json() as { error: { code: string } }).error.code).toBe('not-a-manager');

    const manager = await built.app.inject({
      method: 'PUT',
      url: `/towns/${town.id}/bank/managers/${member.body.userId}`,
      headers: bearer(member.body.accessToken!),
      payload: { allowed: true },
    });
    expect(manager.statusCode).toBe(403);
    expect((manager.json() as { error: { code: string } }).error.code).toBe('not-the-founder');
  });
});

describe('Départ de ville et file d\'attente (HTTP)', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('un membre peut quitter la ville', async () => {
    const built = await makeTestApp();
    app = built.app;
    const founder = await register(built.app, 'f@hordes.test', 'password!1');
    const created = await built.app.inject({
      method: 'POST',
      url: '/towns',
      headers: bearer(founder.body.accessToken!),
      payload: { name: 'Aldebaran', difficulty: 'normal' },
    });
    const town = created.json() as TownState;
    const member = await register(built.app, 'm@hordes.test', 'password!1');
    await built.app.inject({
      method: 'POST',
      url: `/towns/${town.id}/join`,
      headers: bearer(member.body.accessToken!),
    });

    const leave = await built.app.inject({
      method: 'POST',
      url: `/towns/${town.id}/leave`,
      headers: bearer(member.body.accessToken!),
    });
    expect(leave.statusCode).toBe(200);
    expect((leave.json() as { left: boolean }).left).toBe(true);

    const dash = await built.app.inject({
      method: 'GET',
      url: `/towns/${town.id}`,
      headers: bearer(founder.body.accessToken!),
    });
    const state = dash.json() as { citizens: unknown[] };
    expect(state.citizens.length).toBe(1);
  });

  it('refuse la file d\'attente sur une ville non pleine', async () => {
    const built = await makeTestApp();
    app = built.app;
    const founder = await register(built.app, 'f2@hordes.test', 'password!1');
    const created = await built.app.inject({
      method: 'POST',
      url: '/towns',
      headers: bearer(founder.body.accessToken!),
      payload: { name: 'Vega', difficulty: 'normal' },
    });
    const town = created.json() as TownState;
    const other = await register(built.app, 'o@hordes.test', 'password!1');
    const res = await built.app.inject({
      method: 'POST',
      url: `/towns/${town.id}/queue`,
      headers: bearer(other.body.accessToken!),
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('town-not-full');
  });
});
