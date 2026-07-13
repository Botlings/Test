/**
 * Construction du profil joueur (privé et public).
 *
 * Mutualise, entre `GET /auth/me*` (compte authentifié) et `GET /players/:id`
 * (page profil publique), le calcul des statistiques agrégées, la fusion du
 * catalogue de hauts faits avec les badges débloqués, et la mise en forme de
 * l'historique des parties.
 *
 * Le profil PUBLIC ne divulgue jamais l'email : on n'expose qu'un `displayName`
 * dérivé (partie locale de l'email, comme le nom de citoyen par défaut).
 */
import type { Store, AccountRecord, AccountTownEntry } from '../persistence/store.js';
import { ACHIEVEMENT_CATALOG } from '../domain/achievements.js';

/** Statistiques globales de survie d'un compte. */
export interface ProfileStats {
  readonly totalGames: number;
  readonly victories: number;
  readonly aliveGames: number;
  readonly deathsCount: number;
  readonly bestDay: number;
}

/** Un badge du catalogue, enrichi de l'état de déblocage pour ce compte. */
export interface ProfileAchievement {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly hint: string;
  readonly icon: string;
  readonly unlocked: boolean;
  readonly unlockedAt: string | null;
}

/** Une partie de l'historique, mise en forme pour l'affichage du profil. */
export interface ProfileHistoryEntry {
  readonly townId: string;
  readonly townName: string;
  readonly difficulty: string;
  readonly joinedAt: string;
  readonly currentDay: number;
  readonly phase: string;
  readonly outcome: string;
  readonly gameOver: boolean;
  readonly closed: boolean;
  readonly citizen: {
    readonly id: string;
    readonly name: string;
    readonly alive: boolean;
    readonly causeOfDeath: string | null;
  };
}

/** Nom d'affichage public : partie locale de l'email (jamais le domaine). */
export function displayNameFor(email: string): string {
  const local = email.split('@')[0] ?? '';
  return local.length > 0 ? local : 'Survivant';
}

/** Agrège les statistiques de survie depuis l'historique des villes. */
export function computeStats(history: readonly AccountTownEntry[]): ProfileStats {
  const totalGames = history.length;
  const aliveGames = history.filter((h) => h.citizen.alive).length;
  const victories = history.filter((h) => h.outcome === 'victory').length;
  const bestDay = history.reduce((acc, h) => Math.max(acc, h.currentDay), 0);
  return {
    totalGames,
    victories,
    aliveGames,
    deathsCount: totalGames - aliveGames,
    bestDay,
  };
}

/**
 * Fusionne le catalogue complet des hauts faits avec les badges réellement
 * débloqués par le compte : chaque entrée porte son état (`unlocked`) et sa
 * date. L'ordre suit celui du catalogue (progression naturelle).
 */
export async function buildAchievements(
  store: Store,
  accountId: AccountRecord['id'],
): Promise<ProfileAchievement[]> {
  const unlocked = await store.listAccountAchievements(accountId);
  const dateById = new Map(unlocked.map((u) => [u.achievementId, u.unlockedAt] as const));
  return ACHIEVEMENT_CATALOG.map((def) => {
    const at = dateById.get(def.id);
    return {
      id: def.id,
      name: def.name,
      description: def.description,
      hint: def.hint,
      icon: def.icon,
      unlocked: at !== undefined,
      unlockedAt: at ? at.toISOString() : null,
    };
  });
}

/** Met en forme l'historique des villes pour l'affichage du profil. */
export function mapHistory(history: readonly AccountTownEntry[]): ProfileHistoryEntry[] {
  return history.map((h) => ({
    townId: h.townId,
    townName: h.townName,
    difficulty: h.difficulty,
    joinedAt: h.joinedAt.toISOString(),
    currentDay: h.currentDay,
    phase: h.phase,
    outcome: h.outcome,
    gameOver: h.gameOver,
    closed: h.closed,
    citizen: h.citizen,
  }));
}

/** Profil public complet (sans donnée sensible). */
export interface PublicProfile {
  readonly userId: string;
  readonly displayName: string;
  readonly memberSince: string;
  readonly stats: ProfileStats;
  readonly achievements: readonly ProfileAchievement[];
  readonly history: readonly ProfileHistoryEntry[];
}

/**
 * Assemble le profil public d'un compte : identité anonymisée, stats, badges
 * (catalogue fusionné), et historique borné aux `historyLimit` parties les
 * plus récentes.
 */
export async function buildPublicProfile(
  store: Store,
  account: AccountRecord,
  historyLimit = 20,
): Promise<PublicProfile> {
  const history = await store.listAccountTowns(account.id);
  const achievements = await buildAchievements(store, account.id);
  return {
    userId: account.id,
    displayName: displayNameFor(account.email),
    memberSince: account.createdAt.toISOString(),
    stats: computeStats(history),
    achievements,
    history: mapHistory(history).slice(0, Math.max(0, historyLimit)),
  };
}
