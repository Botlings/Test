/**
 * Scheduler de résolution automatique des nuits.
 *
 * Chaque ville possède un timer qui, au bout de `dayDurationMs`, déclenche
 * `resolveNight(townId, 'scheduler')`. Le timer se réamorce tant que la
 * partie n'est pas terminée. Le lock NX-EX du store assure l'idempotence
 * vis-à-vis d'une résolution manuelle concurrente : si l'API joueur a
 * tranché plus vite, le scheduler reçoit `night-already-running` et
 * reprogramme proprement.
 *
 * Tous les accès au temps passent par `NightClock` afin d'être moquables
 * dans les tests (les `setTimeout` natifs sont injectés par défaut).
 *
 * Le scheduler n'est pas distribué : en horizontal scaling, on viendra
 * verrouiller le tic via Redis. Hors scope du jalon 1 (cf. README persistence).
 */
import type { Store } from '../persistence/store.js';
import { StoreError } from '../persistence/store.js';
import type { Id } from '../persistence/types.js';
import type { RealtimeHub } from '../realtime/hub.js';
import { resolveNight } from './night-resolver.js';

/** Abstraction du temps — facilite les tests sans `vi.useFakeTimers`. */
export interface NightClock {
  setTimeout(fn: () => void, ms: number): NightTimerHandle;
  clearTimeout(handle: NightTimerHandle): void;
  now(): number;
}

export type NightTimerHandle = unknown;

/** Implémentation par défaut (système). */
export const SYSTEM_CLOCK: NightClock = {
  setTimeout(fn, ms) {
    return setTimeout(fn, ms);
  },
  clearTimeout(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
  now() {
    return Date.now();
  },
};

export interface NightSchedulerLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

const SILENT_LOGGER: NightSchedulerLogger = {
  info() {
    /* noop */
  },
  warn() {
    /* noop */
  },
  error() {
    /* noop */
  },
};

export interface NightSchedulerOptions {
  readonly store: Store;
  readonly hub: RealtimeHub;
  /** Durée d'une journée de jeu en millisecondes. */
  readonly dayDurationMs: number;
  readonly clock?: NightClock;
  readonly logger?: NightSchedulerLogger;
}

interface ScheduledNight {
  handle: NightTimerHandle;
  scheduledFor: number;
}

export class NightScheduler {
  private readonly store: Store;
  private readonly hub: RealtimeHub;
  private readonly dayDurationMs: number;
  private readonly clock: NightClock;
  private readonly logger: NightSchedulerLogger;
  private readonly entries = new Map<Id, ScheduledNight>();
  private stopped = false;

  constructor(opts: NightSchedulerOptions) {
    if (!Number.isFinite(opts.dayDurationMs) || opts.dayDurationMs <= 0) {
      throw new Error('NightScheduler: dayDurationMs doit être strictement positif');
    }
    this.store = opts.store;
    this.hub = opts.hub;
    this.dayDurationMs = opts.dayDurationMs;
    this.clock = opts.clock ?? SYSTEM_CLOCK;
    this.logger = opts.logger ?? SILENT_LOGGER;
  }

  /** Programme toutes les villes encore actives au démarrage du serveur. */
  async bootstrap(): Promise<void> {
    const towns = await this.store.listOngoingTowns();
    for (const town of towns) {
      this.scheduleTown(town.id, { silent: true });
    }
    this.logger.info(
      `NightScheduler: ${towns.length} ville(s) programmée(s), cycle = ${this.dayDurationMs} ms`,
    );
  }

  /** (Re)programme une ville : annule le timer précédent puis en pose un nouveau. */
  scheduleTown(
    townId: Id,
    opts: { silent?: boolean; day?: number } = {},
  ): void {
    if (this.stopped) return;
    this.cancelTown(townId);
    const scheduledFor = this.clock.now() + this.dayDurationMs;
    const handle = this.clock.setTimeout(() => {
      void this.runNight(townId);
    }, this.dayDurationMs);
    this.entries.set(townId, { handle, scheduledFor });
    if (!opts.silent) {
      this.hub.publish(townId, {
        type: 'night.scheduled',
        day: opts.day ?? 0,
        scheduledFor: new Date(scheduledFor).toISOString(),
      });
    }
  }

  /** Annule la programmation d'une ville (partie terminée, fermeture, etc.). */
  cancelTown(townId: Id): void {
    const entry = this.entries.get(townId);
    if (entry) {
      this.clock.clearTimeout(entry.handle);
      this.entries.delete(townId);
    }
  }

  /** Horodatage prévu (ms epoch) de la prochaine résolution, ou `null`. */
  getScheduledFor(townId: Id): number | null {
    return this.entries.get(townId)?.scheduledFor ?? null;
  }

  /** Stoppe tous les timers (à appeler au shutdown du process). */
  stop(): void {
    this.stopped = true;
    for (const entry of this.entries.values()) {
      this.clock.clearTimeout(entry.handle);
    }
    this.entries.clear();
  }

  /**
   * Exécute la résolution de nuit. Le `setTimeout` consomme l'entrée puis,
   * selon le verdict (gameOver ou non), on reprogramme ou on coupe.
   */
  private async runNight(townId: Id): Promise<void> {
    this.entries.delete(townId);
    try {
      const { report } = await resolveNight({
        store: this.store,
        hub: this.hub,
        townId,
        trigger: 'scheduler',
      });
      if (report.gameOver) {
        this.cancelTown(townId);
        this.logger.info(`NightScheduler: ville ${townId} terminée (jour ${report.day}).`);
        return;
      }
      // `report.day` est la nuit qui vient d'être résolue ; le timer porte donc
      // sur la nuit du jour suivant.
      this.scheduleTown(townId, { day: report.day + 1 });
    } catch (err) {
      if (err instanceof StoreError) {
        if (err.code === 'town-closed' || err.code === 'town-not-found') {
          this.logger.info(
            `NightScheduler: arrêt pour ${townId} (${err.code}).`,
          );
          return;
        }
        if (err.code === 'night-already-running') {
          this.logger.warn(
            `NightScheduler: collision avec une résolution manuelle pour ${townId}, reprogrammation.`,
          );
          this.scheduleTown(townId);
          return;
        }
      }
      this.logger.error(
        `NightScheduler: échec sur ${townId} — ${
          err instanceof Error ? err.message : String(err)
        }. Reprogrammation.`,
      );
      this.scheduleTown(townId);
    }
  }
}
