import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { bearer, makeTestApp, register } from './helpers/app.js';

/** Crée une ville avec `n` membres. Renvoie tokens + townId + citoyens. */
async function seedTown(app: FastifyInstance, n: number) {
  const tokens: string[] = [];
  const first = await register(app, `m0@hordes.test`, 'password!1');
  tokens.push(first.body.accessToken!);
  const created = await app.inject({
    method: 'POST',
    url: '/towns',
    headers: bearer(tokens[0]!),
    payload: { name: 'Concordia', difficulty: 'normal' },
  });
  const townId = (created.json() as { id: string }).id;
  for (let i = 1; i < n; i += 1) {
    const reg = await register(app, `m${i}@hordes.test`, 'password!1');
    tokens.push(reg.body.accessToken!);
    await app.inject({
      method: 'POST',
      url: `/towns/${townId}/join`,
      headers: bearer(reg.body.accessToken!),
    });
  }
  return { tokens, townId };
}

interface GovView {
  day: number;
  yourCitizenId: string | null;
  isMayor: boolean;
  canOpenElection: boolean;
  mayor: { citizenId: string; citizenName: string; electedDay: number } | null;
  election: {
    id: string;
    totalVotes: number;
    myVote: string | null;
    tally: Array<{ candidateCitizenId: string; name: string; votes: number }>;
  } | null;
  curfew: { active: boolean; decreedDay: number | null; by: string | null };
  exileMotions: Array<{
    id: string;
    targetCitizenId: string;
    targetName: string;
    for: number;
    against: number;
    myVote: boolean | null;
    isSelf: boolean;
  }>;
  candidates: Array<{ citizenId: string; name: string }>;
}

async function getGov(app: FastifyInstance, townId: string, token: string): Promise<GovView> {
  const res = await app.inject({
    method: 'GET',
    url: `/towns/${townId}/governance`,
    headers: bearer(token),
  });
  return (res.json() as { governance: GovView }).governance;
}

describe('gouvernance — élection du maire', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('exige un token d\'accès', async () => {
    const built = await makeTestApp();
    app = built.app;
    const res = await built.app.inject({ method: 'GET', url: '/towns/x/governance' });
    expect(res.statusCode).toBe(401);
  });

  it('déroulé complet : ouvrir → voter → clôturer → maire élu', async () => {
    const built = await makeTestApp();
    app = built.app;
    const { tokens, townId } = await seedTown(built.app, 3);

    const open = await built.app.inject({
      method: 'POST',
      url: `/towns/${townId}/governance/election`,
      headers: bearer(tokens[0]!),
    });
    expect(open.statusCode).toBe(201);

    const gov0 = await getGov(built.app, townId, tokens[0]!);
    expect(gov0.election).not.toBeNull();
    expect(gov0.canOpenElection).toBe(false);
    const candidate = gov0.candidates[0]!.citizenId;

    // Deux comptes votent pour le même candidat.
    for (const token of [tokens[0]!, tokens[1]!]) {
      const res = await built.app.inject({
        method: 'POST',
        url: `/towns/${townId}/governance/election/vote`,
        headers: bearer(token),
        payload: { candidateCitizenId: candidate },
      });
      expect(res.statusCode).toBe(200);
    }

    const govVoted = await getGov(built.app, townId, tokens[0]!);
    expect(govVoted.election!.totalVotes).toBe(2);
    expect(govVoted.election!.myVote).toBe(candidate);
    expect(govVoted.election!.tally[0]).toEqual({
      candidateCitizenId: candidate,
      name: gov0.candidates[0]!.name,
      votes: 2,
    });

    const close = await built.app.inject({
      method: 'POST',
      url: `/towns/${townId}/governance/election/close`,
      headers: bearer(tokens[2]!),
    });
    expect(close.statusCode).toBe(200);
    expect((close.json() as { elected: { citizenId: string } }).elected.citizenId).toBe(candidate);

    const govAfter = await getGov(built.app, townId, tokens[0]!);
    expect(govAfter.mayor?.citizenId).toBe(candidate);
    expect(govAfter.election).toBeNull();
    // Réélection interdite dans la foulée (mandat trop récent).
    expect(govAfter.canOpenElection).toBe(false);
    const reopen = await built.app.inject({
      method: 'POST',
      url: `/towns/${townId}/governance/election`,
      headers: bearer(tokens[0]!),
    });
    expect(reopen.statusCode).toBe(409);
  });

  it('un candidat inexistant est rejeté', async () => {
    const built = await makeTestApp();
    app = built.app;
    const { tokens, townId } = await seedTown(built.app, 2);
    await built.app.inject({
      method: 'POST',
      url: `/towns/${townId}/governance/election`,
      headers: bearer(tokens[0]!),
    });
    const res = await built.app.inject({
      method: 'POST',
      url: `/towns/${townId}/governance/election/vote`,
      headers: bearer(tokens[0]!),
      payload: { candidateCitizenId: 'c999' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('gouvernance — pouvoirs du maire', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function electMayor(a: FastifyInstance, townId: string, tokens: string[]) {
    await a.inject({ method: 'POST', url: `/towns/${townId}/governance/election`, headers: bearer(tokens[0]!) });
    const gov = await getGov(a, townId, tokens[0]!);
    const candidate = gov.yourCitizenId!;
    await a.inject({
      method: 'POST',
      url: `/towns/${townId}/governance/election/vote`,
      headers: bearer(tokens[0]!),
      payload: { candidateCitizenId: candidate },
    });
    await a.inject({ method: 'POST', url: `/towns/${townId}/governance/election/close`, headers: bearer(tokens[0]!) });
    return candidate;
  }

  it('seul le maire décrète un couvre-feu, qui bloque alors les motions d\'exil', async () => {
    const built = await makeTestApp();
    app = built.app;
    const { tokens, townId } = await seedTown(built.app, 3);
    await electMayor(built.app, townId, tokens);

    // Un non-maire ne peut pas décréter.
    const denied = await built.app.inject({
      method: 'POST',
      url: `/towns/${townId}/governance/curfew`,
      headers: bearer(tokens[1]!),
    });
    expect(denied.statusCode).toBe(403);

    // Le maire (tokens[0]) décrète.
    const ok = await built.app.inject({
      method: 'POST',
      url: `/towns/${townId}/governance/curfew`,
      headers: bearer(tokens[0]!),
    });
    expect(ok.statusCode).toBe(200);
    const gov = await getGov(built.app, townId, tokens[0]!);
    expect(gov.curfew.active).toBe(true);

    // Sous couvre-feu, aucune motion d'exil.
    const target = gov.candidates.find((c) => c.citizenId !== gov.yourCitizenId)!.citizenId;
    const exile = await built.app.inject({
      method: 'POST',
      url: `/towns/${townId}/governance/exile`,
      headers: bearer(tokens[1]!),
      payload: { targetCitizenId: target },
    });
    expect(exile.statusCode).toBe(409);
    expect((exile.json() as { error: { code: string } }).error.code).toBe('curfew-active');
  });

  it('le maire ferme la banque (régime restricted)', async () => {
    const built = await makeTestApp();
    app = built.app;
    const { tokens, townId } = await seedTown(built.app, 2);
    await electMayor(built.app, townId, tokens);

    const denied = await built.app.inject({
      method: 'POST',
      url: `/towns/${townId}/governance/bank`,
      headers: bearer(tokens[1]!),
      payload: { policy: 'restricted' },
    });
    expect(denied.statusCode).toBe(403);

    const ok = await built.app.inject({
      method: 'POST',
      url: `/towns/${townId}/governance/bank`,
      headers: bearer(tokens[0]!),
      payload: { policy: 'restricted' },
    });
    expect(ok.statusCode).toBe(200);

    const town = await built.app.inject({
      method: 'GET',
      url: `/towns/${townId}`,
      headers: bearer(tokens[0]!),
    });
    expect((town.json() as { bankPolicy: string }).bankPolicy).toBe('restricted');
  });
});

describe('gouvernance — vote d\'exil', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('majorité stricte des vivants (hors cible) → exil effectif', async () => {
    const built = await makeTestApp();
    app = built.app;
    const { tokens, townId } = await seedTown(built.app, 3);

    const gov = await getGov(built.app, townId, tokens[0]!);
    // La cible = le 3e citoyen (celui de tokens[2]).
    const govM2 = await getGov(built.app, townId, tokens[2]!);
    const target = govM2.yourCitizenId!;

    const open = await built.app.inject({
      method: 'POST',
      url: `/towns/${townId}/governance/exile`,
      headers: bearer(tokens[0]!),
      payload: { targetCitizenId: target },
    });
    expect(open.statusCode).toBe(201);
    const motionId = (open.json() as { motionId: string }).motionId;

    // La cible ne peut pas voter sur son propre exil.
    const selfVote = await built.app.inject({
      method: 'POST',
      url: `/towns/${townId}/governance/exile/vote`,
      headers: bearer(tokens[2]!),
      payload: { motionId, support: false },
    });
    expect(selfVote.statusCode).toBe(403);

    // Premier vote « pour » : seuil = strictMajority(2) = 2, pas encore atteint.
    const v1 = await built.app.inject({
      method: 'POST',
      url: `/towns/${townId}/governance/exile/vote`,
      headers: bearer(tokens[0]!),
      payload: { motionId, support: true },
    });
    expect((v1.json() as { outcome: string }).outcome).toBe('open');

    // Deuxième « pour » → majorité atteinte → motion passée.
    const v2 = await built.app.inject({
      method: 'POST',
      url: `/towns/${townId}/governance/exile/vote`,
      headers: bearer(tokens[1]!),
      payload: { motionId, support: true },
    });
    expect(v2.statusCode).toBe(200);
    expect((v2.json() as { outcome: string }).outcome).toBe('passed');

    // La cible n'est plus citoyenne de la ville.
    const town = await built.app.inject({
      method: 'GET',
      url: `/towns/${townId}`,
      headers: bearer(tokens[0]!),
    });
    const citizens = (town.json() as { citizens: Array<{ id: string }> }).citizens;
    expect(citizens.find((c) => c.id === target)).toBeUndefined();
    expect(citizens).toHaveLength(2);
    void gov;
  });

  it('empêche une motion en double contre la même cible', async () => {
    const built = await makeTestApp();
    app = built.app;
    const { tokens, townId } = await seedTown(built.app, 3);
    const govM2 = await getGov(built.app, townId, tokens[2]!);
    const target = govM2.yourCitizenId!;
    await built.app.inject({
      method: 'POST',
      url: `/towns/${townId}/governance/exile`,
      headers: bearer(tokens[0]!),
      payload: { targetCitizenId: target },
    });
    const dup = await built.app.inject({
      method: 'POST',
      url: `/towns/${townId}/governance/exile`,
      headers: bearer(tokens[1]!),
      payload: { targetCitizenId: target },
    });
    expect(dup.statusCode).toBe(409);
    expect((dup.json() as { error: { code: string } }).error.code).toBe('motion-exists');
  });

  it('interdit de demander son propre exil', async () => {
    const built = await makeTestApp();
    app = built.app;
    const { tokens, townId } = await seedTown(built.app, 2);
    const gov = await getGov(built.app, townId, tokens[0]!);
    const res = await built.app.inject({
      method: 'POST',
      url: `/towns/${townId}/governance/exile`,
      headers: bearer(tokens[0]!),
      payload: { targetCitizenId: gov.yourCitizenId },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('target-self');
  });

  it('un non-citoyen ne peut pas agir sur la gouvernance', async () => {
    const built = await makeTestApp();
    app = built.app;
    const { townId } = await seedTown(built.app, 1);
    const outsider = await register(built.app, 'out@hordes.test', 'password!1');
    const res = await built.app.inject({
      method: 'POST',
      url: `/towns/${townId}/governance/election`,
      headers: bearer(outsider.body.accessToken!),
    });
    expect(res.statusCode).toBe(403);
  });
});
