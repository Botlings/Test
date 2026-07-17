import { describe, it, expect } from 'vitest';
import {
  ELECTION_INTERVAL_DAYS,
  emptyGovernance,
  sanitizeGovernance,
  strictMajority,
  canOpenElection,
  openElection,
  castMayorVote,
  mayorTally,
  closeElection,
  isMayor,
  curfewActive,
  decreeCurfew,
  pruneMayor,
  openMotionAgainst,
  openExileMotion,
  exileTally,
  castExileVote,
  dropMotion,
  cancelMotionsAgainst,
  type GovernanceState,
} from '../src/domain/governance.js';

const CITIZENS = [
  { id: 'c1', name: 'Alice' },
  { id: 'c2', name: 'Bob' },
  { id: 'c3', name: 'Carol' },
];
const IDS = CITIZENS.map((c) => c.id);

describe('gouvernance — utilitaires', () => {
  it('strictMajority = moitié + 1 (majorité simple)', () => {
    expect(strictMajority(1)).toBe(1);
    expect(strictMajority(2)).toBe(2);
    expect(strictMajority(3)).toBe(2);
    expect(strictMajority(4)).toBe(3);
    expect(strictMajority(5)).toBe(3);
    expect(strictMajority(0)).toBe(1);
  });

  it('emptyGovernance est vierge', () => {
    const g = emptyGovernance();
    expect(g).toEqual({ mayor: null, election: null, curfew: null, exileMotions: [] });
  });
});

describe('élection du maire', () => {
  it('peut ouvrir un scrutin quand il n’y a pas de maire', () => {
    const g = emptyGovernance();
    expect(canOpenElection(g, 1)).toBe(true);
  });

  it('bloque un second scrutin tant qu’un est ouvert', () => {
    let g = emptyGovernance();
    g = openElection(g, { id: 'e1', day: 1, openedByName: 'Alice' });
    expect(canOpenElection(g, 1)).toBe(false);
  });

  it('n’autorise une nouvelle élection qu’après ELECTION_INTERVAL_DAYS jours', () => {
    let g = emptyGovernance();
    g = openElection(g, { id: 'e1', day: 1, openedByName: 'Alice' });
    g = castMayorVote(g, { accountId: 'a1', candidateCitizenId: 'c1' });
    g = closeElection(g, { day: 1, aliveCitizens: CITIZENS }).state;
    expect(g.mayor?.citizenId).toBe('c1');
    // Mandat trop récent.
    expect(canOpenElection(g, 1 + ELECTION_INTERVAL_DAYS - 1)).toBe(false);
    // Assez de temps écoulé.
    expect(canOpenElection(g, 1 + ELECTION_INTERVAL_DAYS)).toBe(true);
  });

  it('dépouille et départage de façon déterministe', () => {
    let g = emptyGovernance();
    g = openElection(g, { id: 'e1', day: 1, openedByName: 'Alice' });
    g = castMayorVote(g, { accountId: 'a1', candidateCitizenId: 'c2' });
    g = castMayorVote(g, { accountId: 'a2', candidateCitizenId: 'c3' });
    // Un compte révise sa voix : c2 et c3 à égalité (1-1).
    const tally = mayorTally(g.election!, IDS);
    expect(tally).toEqual([
      { candidateCitizenId: 'c2', votes: 1 },
      { candidateCitizenId: 'c3', votes: 1 },
    ]);
    // Égalité → départage par id croissant : c2 gagne.
    const { winner } = closeElection(g, { day: 1, aliveCitizens: CITIZENS });
    expect(winner?.citizenId).toBe('c2');
  });

  it('révision de vote : un compte = une voix', () => {
    let g = emptyGovernance();
    g = openElection(g, { id: 'e1', day: 1, openedByName: 'Alice' });
    g = castMayorVote(g, { accountId: 'a1', candidateCitizenId: 'c1' });
    g = castMayorVote(g, { accountId: 'a1', candidateCitizenId: 'c2' });
    expect(mayorTally(g.election!, IDS)).toEqual([{ candidateCitizenId: 'c2', votes: 1 }]);
  });

  it('ignore les voix pour un candidat mort/parti', () => {
    let g = emptyGovernance();
    g = openElection(g, { id: 'e1', day: 1, openedByName: 'Alice' });
    g = castMayorVote(g, { accountId: 'a1', candidateCitizenId: 'c9' });
    expect(mayorTally(g.election!, IDS)).toEqual([]);
    const { winner, state } = closeElection(g, { day: 1, aliveCitizens: CITIZENS });
    expect(winner).toBeNull();
    expect(state.election).toBeNull();
  });

  it('le maire est destitué s’il n’est plus citoyen vivant', () => {
    let g = emptyGovernance();
    g = openElection(g, { id: 'e1', day: 1, openedByName: 'Alice' });
    g = castMayorVote(g, { accountId: 'a1', candidateCitizenId: 'c1' });
    g = closeElection(g, { day: 1, aliveCitizens: CITIZENS }).state;
    expect(g.mayor?.citizenId).toBe('c1');
    g = pruneMayor(g, ['c2', 'c3']);
    expect(g.mayor).toBeNull();
  });
});

describe('pouvoirs du maire — couvre-feu', () => {
  it('décret ciblé sur le jour courant', () => {
    let g = emptyGovernance();
    g = decreeCurfew(g, { day: 4, by: 'Alice' });
    expect(curfewActive(g, 4)).toBe(true);
    expect(curfewActive(g, 5)).toBe(false);
  });

  it('isMayor reconnaît le maire en fonction', () => {
    let g = emptyGovernance();
    g = openElection(g, { id: 'e1', day: 1, openedByName: 'Alice' });
    g = castMayorVote(g, { accountId: 'a1', candidateCitizenId: 'c1' });
    g = closeElection(g, { day: 1, aliveCitizens: CITIZENS }).state;
    expect(isMayor(g, 'c1')).toBe(true);
    expect(isMayor(g, 'c2')).toBe(false);
    expect(isMayor(g, null)).toBe(false);
  });
});

describe('vote d’exil', () => {
  it('passe dès la majorité stricte des vivants (hors cible)', () => {
    // 3 vivants au total, cible exclue → base de 2 votants → seuil = 2.
    let g = emptyGovernance();
    g = openExileMotion(g, {
      id: 'm1',
      targetCitizenId: 'c3',
      targetName: 'Carol',
      openedByName: 'Alice',
      day: 2,
    });
    let r = castExileVote(g, { motionId: 'm1', accountId: 'a1', support: true, aliveCount: 2 });
    expect(r.motion?.status).toBe('open');
    r = castExileVote(r.state, { motionId: 'm1', accountId: 'a2', support: true, aliveCount: 2 });
    expect(r.motion?.status).toBe('passed');
    expect(exileTally(r.motion!)).toEqual({ for: 2, against: 0, total: 2 });
  });

  it('est rejetée si les « contre » atteignent la majorité stricte', () => {
    let g = emptyGovernance();
    g = openExileMotion(g, {
      id: 'm1',
      targetCitizenId: 'c3',
      targetName: 'Carol',
      openedByName: 'Alice',
      day: 2,
    });
    let r = castExileVote(g, { motionId: 'm1', accountId: 'a1', support: false, aliveCount: 2 });
    r = castExileVote(r.state, { motionId: 'm1', accountId: 'a2', support: false, aliveCount: 2 });
    expect(r.motion?.status).toBe('rejected');
  });

  it('détecte une motion ouverte déjà existante contre une cible', () => {
    let g = emptyGovernance();
    g = openExileMotion(g, {
      id: 'm1',
      targetCitizenId: 'c3',
      targetName: 'Carol',
      openedByName: 'Alice',
      day: 2,
    });
    expect(openMotionAgainst(g, 'c3')?.id).toBe('m1');
    expect(openMotionAgainst(g, 'c2')).toBeUndefined();
  });

  it('dropMotion et cancelMotionsAgainst nettoient la liste', () => {
    let g = emptyGovernance();
    g = openExileMotion(g, { id: 'm1', targetCitizenId: 'c3', targetName: 'Carol', openedByName: 'Alice', day: 2 });
    g = openExileMotion(g, { id: 'm2', targetCitizenId: 'c2', targetName: 'Bob', openedByName: 'Alice', day: 2 });
    expect(dropMotion(g, 'm1').exileMotions).toHaveLength(1);
    expect(cancelMotionsAgainst(g, 'c2').exileMotions.map((m) => m.id)).toEqual(['m1']);
  });
});

describe('sanitizeGovernance', () => {
  it('renvoie un état vierge pour une entrée invalide', () => {
    expect(sanitizeGovernance(undefined)).toEqual(emptyGovernance());
    expect(sanitizeGovernance(null)).toEqual(emptyGovernance());
    expect(sanitizeGovernance(42)).toEqual(emptyGovernance());
  });

  it('reconstruit fidèlement un état sérialisé (aller-retour JSON)', () => {
    let g: GovernanceState = emptyGovernance();
    g = openElection(g, { id: 'e1', day: 1, openedByName: 'Alice' });
    g = castMayorVote(g, { accountId: 'a1', candidateCitizenId: 'c1' });
    g = closeElection(g, { day: 1, aliveCitizens: CITIZENS }).state;
    g = decreeCurfew(g, { day: 1, by: 'Alice' });
    g = openExileMotion(g, { id: 'm1', targetCitizenId: 'c2', targetName: 'Bob', openedByName: 'Alice', day: 1 });
    g = castExileVote(g, { motionId: 'm1', accountId: 'a1', support: true, aliveCount: 2 }).state;
    const roundTrip = sanitizeGovernance(JSON.parse(JSON.stringify(g)));
    expect(roundTrip).toEqual(g);
  });

  it('filtre les champs corrompus', () => {
    const g = sanitizeGovernance({
      mayor: { citizenId: 'c1' },
      election: { id: 'e1', votes: { a1: 'c1', a2: 3 } },
      exileMotions: [
        { id: 'm1', targetCitizenId: 'c2', status: 'weird', votes: { a1: true, a2: 'nope' } },
        { nope: true },
      ],
    });
    expect(g.mayor).toEqual({ citizenId: 'c1', citizenName: 'c1', electedDay: 0 });
    expect(g.election?.votes).toEqual({ a1: 'c1' });
    expect(g.exileMotions).toHaveLength(1);
    expect(g.exileMotions[0]!.status).toBe('open');
    expect(g.exileMotions[0]!.votes).toEqual({ a1: true });
  });
});
