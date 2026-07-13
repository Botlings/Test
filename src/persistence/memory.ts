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
import type { AchievementId } from '../domain/achievements.js';
import type { GameConfig } from '../domain/config.js';
import { DEFAULT_CONFIG } from '../domain/config.js';
import { seedFromString } from '../domain/desert.js';
import type { NightReport } from '../domain/types.js';
import type { Id } from './types.js';
import {
  MAX_CITIZENS_PER_TOWN,
  REFRESH_TOKEN_TTL_MS,
  StoreError,
  compareGameResults,
  type AccountRecord,
  type AccountTownEntry,
  type AchievementUnlock,
  type ActivityEntry,
  type ActivityInput,
  type BankPolicy,
  type Difficulty,
  type LeaveTownResult,
  type ForumMessageRecord,
  type ForumThreadDetail,
  type ForumThreadKind,
  type ForumThreadRecord,
  type ForumThreadSummary,
  type ForumVoteOption,
  type ForumVoteRecord,
  type ForumVoteTally,
  type GameResultInput,
  type LeaderboardEntry,
  type NightEventInput,
  type NightTrigger,
  type SessionRecord,
  type StoredNightReport,
  type Store,
  type TownQueueEntry,
  type TownRecord,
} from './store.js';

export {
  MAX_CITIZENS_PER_TOWN,
  REFRESH_TOKEN_TTL_MS,
  StoreError,
  type AccountRecord,
  type AccountTownEntry,
  type Difficulty,
  type SessionRecord,
  type TownRecord,
};

function newId(): Id {
  return randomUUID() as Id;
}

/**
 * Normalise et valide les options d'un sujet de type vote. Génère un id
 * `opt-N` pour chaque option si non fourni ; rejette si <2 ou >6 options
 * ou si une option a un libellé vide / trop long.
 */
export function normalizeVoteOptions(
  options: readonly ForumVoteOption[] | undefined,
): ForumVoteOption[] {
  if (!options || options.length < 2 || options.length > 6) {
    throw new StoreError(
      'vote-options-invalid',
      'Un vote doit proposer entre 2 et 6 options',
    );
  }
  const seenIds = new Set<string>();
  const result: ForumVoteOption[] = [];
  options.forEach((opt, idx) => {
    const label = String(opt.label ?? '').trim();
    if (label.length < 1 || label.length > 60) {
      throw new StoreError(
        'vote-options-invalid',
        'Chaque option doit faire 1 à 60 caractères',
      );
    }
    const rawId = String(opt.id ?? `opt-${idx}`).trim();
    const id = /^[a-z0-9_-]{1,32}$/i.test(rawId) ? rawId : `opt-${idx}`;
    if (seenIds.has(id)) {
      throw new StoreError('vote-options-invalid', 'Les ids d\'options doivent être uniques');
    }
    seenIds.add(id);
    result.push({ id, label });
  });
  return result;
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
  private readonly nightReports = new Map<Id, StoredNightReport[]>();
  /** Résultat final par ville (clé : townId). Un seul résultat par partie. */
  private readonly gameResults = new Map<Id, Omit<LeaderboardEntry, 'rank'>>();
  private readonly membershipJoinedAt = new Map<string, Date>();
  /** Hauts faits débloqués par compte : achievementId → date de déblocage. */
  private readonly achievements = new Map<Id, Map<AchievementId, Date>>();
  /** Horodatage d'entrée en file d'attente, clé `${townId}|${accountId}`. */
  private readonly queuedAt = new Map<string, Date>();
  private readonly forumThreads = new Map<Id, ForumThreadRecord>();
  private readonly forumMessages = new Map<Id, ForumMessageRecord[]>();
  private readonly forumVotes = new Map<Id, Map<Id, ForumVoteRecord>>();
  private readonly activityLog = new Map<Id, ActivityEntry[]>();
  private static readonly DEFAULT_REPORT_LIMIT = 20;
  private static readonly DEFAULT_ACTIVITY_LIMIT = 50;
  private static readonly MAX_ACTIVITY_ENTRIES = 500;

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
    const id = newId();
    const town: TownRecord = {
      id,
      name: trimmed,
      difficulty,
      createdAt: new Date(),
      game: new Game(difficultyConfig(difficulty), seedFromString(`town-${id}`)),
      membership: new Map(),
      closed: false,
      founderAccountId: null,
      bankPolicy: 'open',
      bankManagers: new Set<Id>(),
      queue: [],
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
    const wasEmpty = town.membership.size === 0;
    const citizen = town.game.addCitizen(citizenName);
    town.membership.set(accountId, citizen.id);
    if (wasEmpty && !town.founderAccountId) {
      town.founderAccountId = accountId;
    }
    // Un compte qui rejoint quitte la file d'attente s'il y était.
    const qi = town.queue.indexOf(accountId);
    if (qi !== -1) town.queue.splice(qi, 1);
    this.membershipJoinedAt.set(`${townId}|${accountId}`, new Date());
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
    // Retire de la file d'attente le cas échéant (compte non membre).
    const qi = town.queue.indexOf(accountId);
    if (qi !== -1) town.queue.splice(qi, 1);

    const citizenId = town.membership.get(accountId);
    if (!citizenId) {
      return { removedCitizenId: null, promoted: null };
    }
    town.game.removeCitizen(citizenId);
    town.membership.delete(accountId);
    town.bankManagers.delete(accountId);
    this.membershipJoinedAt.delete(`${townId}|${accountId}`);
    if (town.founderAccountId === accountId) {
      // Le fondateur part : on transfère le rôle au plus ancien membre restant.
      town.founderAccountId = town.membership.keys().next().value ?? null;
    }

    const promoted = await this.promoteFromQueue(town);
    return { removedCitizenId: citizenId, promoted };
  }

  /**
   * Promeut la tête de la file d'attente si une place est libre. Renvoie les
   * infos du compte promu (pour publication temps réel) ou `null`.
   */
  private async promoteFromQueue(
    town: TownRecord,
  ): Promise<LeaveTownResult['promoted']> {
    while (town.queue.length > 0 && town.membership.size < MAX_CITIZENS_PER_TOWN) {
      const nextAccountId = town.queue[0]!;
      // Compte déjà membre (cas limite) ou disparu → on l'évacue de la file.
      if (town.membership.has(nextAccountId)) {
        town.queue.shift();
        continue;
      }
      const account = this.accounts.get(nextAccountId);
      if (!account) {
        town.queue.shift();
        continue;
      }
      town.queue.shift();
      const citizenName = account.email.split('@')[0]!;
      const citizen = town.game.addCitizen(citizenName);
      town.membership.set(nextAccountId, citizen.id);
      this.membershipJoinedAt.set(`${town.id}|${nextAccountId}`, new Date());
      return { accountId: nextAccountId, citizenId: citizen.id, citizenName };
    }
    return null;
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
    town.queue.push(accountId);
    this.queuedAt.set(`${townId}|${accountId}`, new Date());
    return { position: town.queue.length, size: town.queue.length };
  }

  async leaveQueue(townId: Id, accountId: Id): Promise<void> {
    const town = this.towns.get(townId);
    if (!town) return;
    const i = town.queue.indexOf(accountId);
    if (i !== -1) town.queue.splice(i, 1);
    this.queuedAt.delete(`${townId}|${accountId}`);
  }

  async getQueue(townId: Id): Promise<TownQueueEntry[]> {
    const town = this.towns.get(townId);
    if (!town) return [];
    return town.queue.map((accountId, idx) => ({
      accountId,
      position: idx + 1,
      enqueuedAt: this.queuedAt.get(`${townId}|${accountId}`) ?? new Date(),
    }));
  }

  async setBankPolicy(townId: Id, policy: BankPolicy): Promise<void> {
    const town = this.towns.get(townId);
    if (!town) {
      throw new StoreError('town-not-found', 'Ville introuvable');
    }
    town.bankPolicy = policy;
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
    if (allowed) town.bankManagers.add(accountId);
    else town.bankManagers.delete(accountId);
  }

  async listAccountTowns(accountId: Id): Promise<AccountTownEntry[]> {
    const entries: AccountTownEntry[] = [];
    for (const town of this.towns.values()) {
      const citizenId = town.membership.get(accountId);
      if (!citizenId) continue;
      const status = town.game.status();
      const citizen = status.citizens.find((c) => c.id === citizenId);
      if (!citizen) continue;
      const joinedAt =
        this.membershipJoinedAt.get(`${town.id}|${accountId}`) ?? town.createdAt;
      entries.push({
        townId: town.id,
        townName: town.name,
        difficulty: town.difficulty,
        joinedAt,
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
    let owned = this.achievements.get(accountId);
    if (!owned) {
      owned = new Map();
      this.achievements.set(accountId, owned);
    }
    if (owned.has(achievementId)) return false;
    owned.set(achievementId, new Date());
    return true;
  }

  async listAccountAchievements(accountId: Id): Promise<AchievementUnlock[]> {
    const owned = this.achievements.get(accountId);
    if (!owned) return [];
    return [...owned.entries()]
      .map(([achievementId, unlockedAt]) => ({ achievementId, unlockedAt }))
      .sort((a, b) => a.unlockedAt.getTime() - b.unlockedAt.getTime());
  }

  async saveTown(_town: TownRecord): Promise<void> {
    // No-op : le `Game` est déjà mis à jour en place dans la Map.
  }

  async recordNightEvent(townId: Id, event: NightEventInput): Promise<void> {
    this.nightEvents.push({ townId, event, at: new Date() });
  }

  async recordNightReport(
    townId: Id,
    trigger: NightTrigger,
    report: NightReport,
  ): Promise<void> {
    const list = this.nightReports.get(townId) ?? [];
    list.unshift({ trigger, storedAt: new Date(), report });
    if (list.length > MemoryStore.DEFAULT_REPORT_LIMIT) {
      list.length = MemoryStore.DEFAULT_REPORT_LIMIT;
    }
    this.nightReports.set(townId, list);
  }

  async listNightReports(
    townId: Id,
    limit: number = MemoryStore.DEFAULT_REPORT_LIMIT,
  ): Promise<StoredNightReport[]> {
    const list = this.nightReports.get(townId) ?? [];
    return list.slice(0, Math.max(0, limit));
  }

  /* ---------------------------- Fin de partie ---------------------------- */

  async recordGameResult(townId: Id, result: GameResultInput): Promise<void> {
    const town = this.towns.get(townId);
    this.gameResults.set(townId, {
      townId,
      townName: town?.name ?? 'Ville inconnue',
      difficulty: result.difficulty,
      outcome: result.outcome,
      daysSurvived: result.daysSurvived,
      survivors: result.survivors,
      population: result.population,
      endedAt: new Date(),
    });
  }

  async listLeaderboard(limit = 20): Promise<LeaderboardEntry[]> {
    const safe = Math.max(0, Math.min(100, Math.trunc(limit)));
    return [...this.gameResults.values()]
      .sort(compareGameResults)
      .slice(0, safe)
      .map((entry, idx) => ({ ...entry, rank: idx + 1 }));
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
    const thread: ForumThreadRecord = {
      id: newId(),
      townId: input.townId,
      authorAccountId: input.authorAccountId,
      authorCitizenName: input.authorCitizenName,
      title,
      kind: input.kind,
      options,
      createdAt: new Date(),
      closesAt: input.closesAt ?? null,
      closed: false,
    };
    this.forumThreads.set(thread.id, thread);
    this.forumMessages.set(thread.id, []);
    this.forumVotes.set(thread.id, new Map());
    if (input.body && input.body.trim().length > 0) {
      await this.postForumMessage({
        townId: input.townId,
        threadId: thread.id,
        authorAccountId: input.authorAccountId,
        authorCitizenName: input.authorCitizenName,
        body: input.body,
      });
    }
    const detail = await this.getForumThread(input.townId, thread.id, input.authorAccountId);
    return detail!;
  }

  async listForumThreads(
    townId: Id,
    viewerAccountId?: Id,
  ): Promise<ForumThreadSummary[]> {
    const out: ForumThreadSummary[] = [];
    for (const thread of this.forumThreads.values()) {
      if (thread.townId !== townId) continue;
      out.push(this.summarizeThread(thread, viewerAccountId));
    }
    out.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return out;
  }

  async getForumThread(
    townId: Id,
    threadId: Id,
    viewerAccountId?: Id,
  ): Promise<ForumThreadDetail | undefined> {
    const thread = this.forumThreads.get(threadId);
    if (!thread || thread.townId !== townId) return undefined;
    this.maybeAutoClose(thread);
    const messages = (this.forumMessages.get(threadId) ?? []).slice();
    messages.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const tally = this.computeTally(thread, viewerAccountId);
    return {
      thread: this.summarizeThread(thread, viewerAccountId),
      messages,
      tally,
    };
  }

  async postForumMessage(input: {
    readonly townId: Id;
    readonly threadId: Id;
    readonly authorAccountId: Id;
    readonly authorCitizenName: string;
    readonly body: string;
  }): Promise<ForumMessageRecord> {
    const thread = this.forumThreads.get(input.threadId);
    if (!thread || thread.townId !== input.townId) {
      throw new StoreError('thread-not-found', 'Sujet introuvable');
    }
    this.maybeAutoClose(thread);
    if (thread.closed) {
      throw new StoreError('thread-closed', 'Ce sujet est fermé');
    }
    const body = input.body.trim();
    if (body.length < 1 || body.length > 1000) {
      throw new StoreError('message-body-invalid', 'Le message doit faire 1 à 1000 caractères');
    }
    const message: ForumMessageRecord = {
      id: newId(),
      threadId: input.threadId,
      townId: input.townId,
      authorAccountId: input.authorAccountId,
      authorCitizenName: input.authorCitizenName,
      body,
      createdAt: new Date(),
    };
    const list = this.forumMessages.get(input.threadId) ?? [];
    list.push(message);
    this.forumMessages.set(input.threadId, list);
    return message;
  }

  async castForumVote(input: {
    readonly townId: Id;
    readonly threadId: Id;
    readonly accountId: Id;
    readonly citizenName: string;
    readonly optionId: string;
  }): Promise<ForumVoteTally> {
    const thread = this.forumThreads.get(input.threadId);
    if (!thread || thread.townId !== input.townId) {
      throw new StoreError('thread-not-found', 'Sujet introuvable');
    }
    if (thread.kind !== 'vote') {
      throw new StoreError('vote-not-allowed', 'Ce sujet n\'est pas un vote');
    }
    this.maybeAutoClose(thread);
    if (thread.closed) {
      throw new StoreError('vote-closed', 'Le vote est clos');
    }
    if (!thread.options.some((o) => o.id === input.optionId)) {
      throw new StoreError('option-invalid', 'Option de vote invalide');
    }
    const votes = this.forumVotes.get(input.threadId) ?? new Map<Id, ForumVoteRecord>();
    votes.set(input.accountId, {
      threadId: input.threadId,
      accountId: input.accountId,
      citizenName: input.citizenName,
      optionId: input.optionId,
      castAt: new Date(),
    });
    this.forumVotes.set(input.threadId, votes);
    return this.computeTally(thread, input.accountId);
  }

  async closeForumThread(townId: Id, threadId: Id): Promise<ForumThreadSummary> {
    const thread = this.forumThreads.get(threadId);
    if (!thread || thread.townId !== townId) {
      throw new StoreError('thread-not-found', 'Sujet introuvable');
    }
    thread.closed = true;
    return this.summarizeThread(thread);
  }

  /* ---------------------------- Activité ---------------------------------- */

  async recordActivity(townId: Id, input: ActivityInput): Promise<ActivityEntry> {
    const town = this.towns.get(townId);
    if (!town) {
      throw new StoreError('town-not-found', 'Ville introuvable');
    }
    const entry: ActivityEntry = {
      id: newId(),
      townId,
      accountId: input.accountId ?? null,
      citizenId: input.citizenId ?? null,
      citizenName: input.citizenName ?? null,
      kind: input.kind,
      details: input.details ?? {},
      createdAt: new Date(),
    };
    const list = this.activityLog.get(townId) ?? [];
    list.unshift(entry);
    if (list.length > MemoryStore.MAX_ACTIVITY_ENTRIES) {
      list.length = MemoryStore.MAX_ACTIVITY_ENTRIES;
    }
    this.activityLog.set(townId, list);
    return entry;
  }

  async listActivity(
    townId: Id,
    limit: number = MemoryStore.DEFAULT_ACTIVITY_LIMIT,
  ): Promise<ActivityEntry[]> {
    const list = this.activityLog.get(townId) ?? [];
    return list.slice(0, Math.max(0, limit));
  }

  /* ---------------------------- Helpers forum ---------------------------- */

  private maybeAutoClose(thread: ForumThreadRecord): void {
    if (!thread.closed && thread.closesAt && thread.closesAt.getTime() <= Date.now()) {
      thread.closed = true;
    }
  }

  private summarizeThread(
    thread: ForumThreadRecord,
    viewerAccountId?: Id,
  ): ForumThreadSummary {
    const messages = this.forumMessages.get(thread.id) ?? [];
    const lastMessageAt = messages.length
      ? messages.reduce<Date>(
          (acc, m) => (m.createdAt.getTime() > acc.getTime() ? m.createdAt : acc),
          messages[0]!.createdAt,
        )
      : null;
    const votes = this.forumVotes.get(thread.id) ?? new Map<Id, ForumVoteRecord>();
    void viewerAccountId;
    return {
      ...thread,
      messageCount: messages.length,
      lastMessageAt,
      voteCount: votes.size,
    };
  }

  private computeTally(thread: ForumThreadRecord, viewerAccountId?: Id): ForumVoteTally {
    const votes = this.forumVotes.get(thread.id) ?? new Map<Id, ForumVoteRecord>();
    const counts: Record<string, number> = {};
    for (const opt of thread.options) counts[opt.id] = 0;
    let myChoice: string | null = null;
    for (const v of votes.values()) {
      counts[v.optionId] = (counts[v.optionId] ?? 0) + 1;
      if (viewerAccountId && v.accountId === viewerAccountId) {
        myChoice = v.optionId;
      }
    }
    return {
      threadId: thread.id,
      total: votes.size,
      counts,
      myChoice,
    };
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

  async ping(): Promise<void> {
    // In-memory : toujours sain tant que le process tourne.
  }

  async close(): Promise<void> {
    // Rien à fermer : aucune ressource externe.
  }
}
