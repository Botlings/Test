/**
 * Mécaniques sociales authentiques de Hordes : gouvernance de la ville.
 *
 * Trois piliers, tous purs et sérialisables (l'état vit en JSONB sur la
 * ville, à côté de `buildings`/`desert`) :
 *
 *   1. Élection du maire — un scrutin peut être ouvert tous les
 *      `ELECTION_INTERVAL_DAYS` jours ; chaque compte vote pour un citoyen
 *      candidat ; à la clôture, le citoyen en tête devient maire.
 *   2. Pouvoirs du maire — fermer la banque (régime `restricted`) et
 *      décréter un couvre-feu (ordre imposé : aucun vote d'exil tant qu'il
 *      est actif).
 *   3. Vote d'exil — n'importe quel citoyen ouvre une motion contre un autre ;
 *      la motion PASSE dès que les voix « pour » atteignent la majorité
 *      stricte des citoyens vivants (l'habitant est alors expulsé).
 *
 * Ce module ne fait AUCUNE I/O : il transforme un `GovernanceState` en un
 * nouveau `GovernanceState` (ou calcule un dépouillement). L'orchestration
 * des effets de bord (retrait d'un citoyen, changement de régime de banque,
 * persistance) est la responsabilité de la couche serveur.
 */

/** Nombre de jours entre deux élections municipales possibles. */
export const ELECTION_INTERVAL_DAYS = 3;

/** Maire en fonction. */
export interface Mayor {
  readonly citizenId: string;
  readonly citizenName: string;
  /** Jour de jeu où le maire a été élu. */
  readonly electedDay: number;
}

/**
 * Scrutin municipal ouvert. `votes` associe un compte (accountId) au citoyen
 * pour lequel il vote (candidateCitizenId) — un compte = une voix, révisable
 * tant que le scrutin est ouvert.
 */
export interface MayorElection {
  readonly id: string;
  readonly openedDay: number;
  readonly openedByName: string;
  readonly votes: Record<string, string>;
}

/** Couvre-feu décrété par le maire pour la nuit d'un jour donné. */
export interface Curfew {
  readonly decreedDay: number;
  readonly by: string;
}

/** Issue d'une motion d'exil. */
export type ExileStatus = 'open' | 'passed' | 'rejected';

/**
 * Motion d'exil contre un habitant. `votes` associe un compte à sa voix
 * (`true` = pour l'exil, `false` = contre). Le vote d'exil est public dans
 * Hordes : les voix sont conservées telles quelles.
 */
export interface ExileMotion {
  readonly id: string;
  readonly targetCitizenId: string;
  readonly targetName: string;
  readonly openedByName: string;
  readonly openedDay: number;
  status: ExileStatus;
  readonly votes: Record<string, boolean>;
}

/** État de gouvernance complet d'une ville (persisté en JSONB). */
export interface GovernanceState {
  mayor: Mayor | null;
  election: MayorElection | null;
  curfew: Curfew | null;
  exileMotions: ExileMotion[];
}

/** État de gouvernance vierge d'une ville neuve. */
export function emptyGovernance(): GovernanceState {
  return { mayor: null, election: null, curfew: null, exileMotions: [] };
}

/**
 * Reconstruit un `GovernanceState` propre à partir d'une valeur inconnue
 * (colonne JSONB potentiellement absente / corrompue / d'une ancienne
 * version). Ne fait jamais confiance aux données : filtre et normalise.
 */
export function sanitizeGovernance(raw: unknown): GovernanceState {
  const base = emptyGovernance();
  if (typeof raw !== 'object' || raw === null) return base;
  const obj = raw as Record<string, unknown>;

  const mayor = obj.mayor as Record<string, unknown> | null | undefined;
  if (mayor && typeof mayor.citizenId === 'string') {
    base.mayor = {
      citizenId: mayor.citizenId,
      citizenName: typeof mayor.citizenName === 'string' ? mayor.citizenName : mayor.citizenId,
      electedDay: Number.isFinite(mayor.electedDay) ? (mayor.electedDay as number) : 0,
    };
  }

  const election = obj.election as Record<string, unknown> | null | undefined;
  if (election && typeof election.id === 'string') {
    base.election = {
      id: election.id,
      openedDay: Number.isFinite(election.openedDay) ? (election.openedDay as number) : 0,
      openedByName:
        typeof election.openedByName === 'string' ? election.openedByName : 'un citoyen',
      votes: sanitizeStringRecord(election.votes),
    };
  }

  const curfew = obj.curfew as Record<string, unknown> | null | undefined;
  if (curfew && Number.isFinite(curfew.decreedDay)) {
    base.curfew = {
      decreedDay: curfew.decreedDay as number,
      by: typeof curfew.by === 'string' ? curfew.by : 'le maire',
    };
  }

  if (Array.isArray(obj.exileMotions)) {
    for (const m of obj.exileMotions) {
      if (typeof m !== 'object' || m === null) continue;
      const mm = m as Record<string, unknown>;
      if (typeof mm.id !== 'string' || typeof mm.targetCitizenId !== 'string') continue;
      base.exileMotions.push({
        id: mm.id,
        targetCitizenId: mm.targetCitizenId,
        targetName: typeof mm.targetName === 'string' ? mm.targetName : mm.targetCitizenId,
        openedByName: typeof mm.openedByName === 'string' ? mm.openedByName : 'un citoyen',
        openedDay: Number.isFinite(mm.openedDay) ? (mm.openedDay as number) : 0,
        status: isExileStatus(mm.status) ? mm.status : 'open',
        votes: sanitizeBoolRecord(mm.votes),
      });
    }
  }
  return base;
}

function isExileStatus(v: unknown): v is ExileStatus {
  return v === 'open' || v === 'passed' || v === 'rejected';
}

function sanitizeStringRecord(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof raw === 'object' && raw !== null) {
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === 'string') out[k] = v;
    }
  }
  return out;
}

function sanitizeBoolRecord(raw: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  if (typeof raw === 'object' && raw !== null) {
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === 'boolean') out[k] = v;
    }
  }
  return out;
}

/* ----------------------------- Élection du maire ------------------------- */

/** Majorité stricte (« majorité simple ») pour une population donnée. */
export function strictMajority(aliveCount: number): number {
  return Math.floor(Math.max(0, aliveCount) / 2) + 1;
}

/**
 * Un scrutin municipal peut-il être ouvert au jour `day` ? Non si un scrutin
 * est déjà en cours ; sinon oui tant qu'il n'y a pas de maire ou que le
 * mandat courant a au moins `ELECTION_INTERVAL_DAYS` jours.
 */
export function canOpenElection(state: GovernanceState, day: number): boolean {
  if (state.election) return false;
  if (!state.mayor) return true;
  return day - state.mayor.electedDay >= ELECTION_INTERVAL_DAYS;
}

/** Ouvre un scrutin municipal. L'appelant a validé `canOpenElection`. */
export function openElection(
  state: GovernanceState,
  input: { id: string; day: number; openedByName: string },
): GovernanceState {
  return {
    ...state,
    election: {
      id: input.id,
      openedDay: input.day,
      openedByName: input.openedByName,
      votes: {},
    },
  };
}

/** Enregistre (ou révise) la voix d'un compte pour un candidat. */
export function castMayorVote(
  state: GovernanceState,
  input: { accountId: string; candidateCitizenId: string },
): GovernanceState {
  if (!state.election) return state;
  return {
    ...state,
    election: {
      ...state.election,
      votes: { ...state.election.votes, [input.accountId]: input.candidateCitizenId },
    },
  };
}

/** Une ligne de dépouillement d'un scrutin municipal. */
export interface MayorTallyLine {
  readonly candidateCitizenId: string;
  readonly votes: number;
}

/**
 * Dépouille un scrutin : voix par candidat, tri décroissant puis par
 * `candidateCitizenId` croissant (départage déterministe). Les voix pour un
 * candidat absent de `aliveCitizenIds` sont ignorées (candidat mort / parti).
 */
export function mayorTally(
  election: MayorElection,
  aliveCitizenIds: readonly string[],
): MayorTallyLine[] {
  const alive = new Set(aliveCitizenIds);
  const counts = new Map<string, number>();
  for (const candidate of Object.values(election.votes)) {
    if (!alive.has(candidate)) continue;
    counts.set(candidate, (counts.get(candidate) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([candidateCitizenId, votes]) => ({ candidateCitizenId, votes }))
    .sort((a, b) =>
      b.votes !== a.votes
        ? b.votes - a.votes
        : a.candidateCitizenId < b.candidateCitizenId
          ? -1
          : 1,
    );
}

/**
 * Clôt le scrutin en cours. Le vainqueur (tête du dépouillement) devient
 * maire ; s'il n'y a aucune voix exploitable, le scrutin est simplement
 * annulé (le maire éventuel reste en place). Renvoie le nouvel état et le
 * vainqueur (ou `null`).
 */
export function closeElection(
  state: GovernanceState,
  input: { day: number; aliveCitizens: readonly { id: string; name: string }[] },
): { state: GovernanceState; winner: Mayor | null } {
  if (!state.election) return { state, winner: null };
  const tally = mayorTally(state.election, input.aliveCitizens.map((c) => c.id));
  const top = tally[0];
  if (!top) {
    return { state: { ...state, election: null }, winner: null };
  }
  const name = input.aliveCitizens.find((c) => c.id === top.candidateCitizenId)?.name ?? top.candidateCitizenId;
  const winner: Mayor = { citizenId: top.candidateCitizenId, citizenName: name, electedDay: input.day };
  return { state: { ...state, election: null, mayor: winner }, winner };
}

/* ------------------------------ Pouvoirs du maire ------------------------ */

/** Le citoyen `citizenId` est-il le maire en fonction ? */
export function isMayor(state: GovernanceState, citizenId: string | null | undefined): boolean {
  return !!citizenId && state.mayor?.citizenId === citizenId;
}

/** Le couvre-feu est-il actif à ce jour de jeu ? */
export function curfewActive(state: GovernanceState, day: number): boolean {
  return !!state.curfew && state.curfew.decreedDay === day;
}

/** Décrète un couvre-feu pour la nuit du jour courant. */
export function decreeCurfew(
  state: GovernanceState,
  input: { day: number; by: string },
): GovernanceState {
  return { ...state, curfew: { decreedDay: input.day, by: input.by } };
}

/**
 * Retire le maire s'il n'est plus un citoyen vivant de la ville (mort, exil,
 * départ). À appeler après toute mutation de la population.
 */
export function pruneMayor(
  state: GovernanceState,
  aliveCitizenIds: readonly string[],
): GovernanceState {
  if (state.mayor && !aliveCitizenIds.includes(state.mayor.citizenId)) {
    return { ...state, mayor: null };
  }
  return state;
}

/* -------------------------------- Vote d'exil ---------------------------- */

/** Trouve la motion d'exil ouverte contre une cible, s'il en existe une. */
export function openMotionAgainst(
  state: GovernanceState,
  targetCitizenId: string,
): ExileMotion | undefined {
  return state.exileMotions.find(
    (m) => m.status === 'open' && m.targetCitizenId === targetCitizenId,
  );
}

/** Ouvre une motion d'exil. L'appelant a validé cible + absence de doublon. */
export function openExileMotion(
  state: GovernanceState,
  input: {
    id: string;
    targetCitizenId: string;
    targetName: string;
    openedByName: string;
    day: number;
  },
): GovernanceState {
  const motion: ExileMotion = {
    id: input.id,
    targetCitizenId: input.targetCitizenId,
    targetName: input.targetName,
    openedByName: input.openedByName,
    openedDay: input.day,
    status: 'open',
    votes: {},
  };
  return { ...state, exileMotions: [...state.exileMotions, motion] };
}

/** Dépouillement d'une motion d'exil. */
export interface ExileTally {
  readonly for: number;
  readonly against: number;
  readonly total: number;
}

/** Compte les voix pour/contre d'une motion. */
export function exileTally(motion: ExileMotion): ExileTally {
  let forVotes = 0;
  let against = 0;
  for (const v of Object.values(motion.votes)) {
    if (v) forVotes += 1;
    else against += 1;
  }
  return { for: forVotes, against, total: forVotes + against };
}

/**
 * Enregistre (ou révise) la voix d'un compte sur une motion, puis résout la
 * motion si un camp a atteint la majorité stricte des citoyens vivants.
 * Renvoie le nouvel état et le statut final de la motion.
 *
 * `aliveCount` DOIT exclure la cible elle-même (un habitant ne vote pas sur
 * son propre exil), afin que la majorité porte sur les votants légitimes.
 */
export function castExileVote(
  state: GovernanceState,
  input: { motionId: string; accountId: string; support: boolean; aliveCount: number },
): { state: GovernanceState; motion: ExileMotion | undefined } {
  const motions = state.exileMotions.map((m) => {
    if (m.id !== input.motionId || m.status !== 'open') return m;
    const updated: ExileMotion = {
      ...m,
      votes: { ...m.votes, [input.accountId]: input.support },
    };
    const tally = exileTally(updated);
    const threshold = strictMajority(input.aliveCount);
    if (tally.for >= threshold) updated.status = 'passed';
    else if (tally.against >= threshold) updated.status = 'rejected';
    return updated;
  });
  return {
    state: { ...state, exileMotions: motions },
    motion: motions.find((m) => m.id === input.motionId),
  };
}

/** Retire une motion résolue de la liste (nettoyage après effet de bord). */
export function dropMotion(state: GovernanceState, motionId: string): GovernanceState {
  return { ...state, exileMotions: state.exileMotions.filter((m) => m.id !== motionId) };
}

/**
 * Ferme toutes les motions ouvertes visant une cible donnée (utilisé quand la
 * cible quitte la ville par un autre chemin : mort, départ volontaire).
 */
export function cancelMotionsAgainst(
  state: GovernanceState,
  targetCitizenId: string,
): GovernanceState {
  return {
    ...state,
    exileMotions: state.exileMotions.filter(
      (m) => !(m.status === 'open' && m.targetCitizenId === targetCitizenId),
    ),
  };
}
