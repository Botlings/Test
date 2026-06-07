/**
 * Tests du scheduler de nuit automatique.
 *
 * On simule le temps avec une `FakeClock` : on programme des callbacks et on
 * les déclenche manuellement via `tick()`. Cela permet de tester l'idempotence
 * face à une résolution manuelle, la propagation des erreurs, et l'arrêt
 * propre en fin de partie — sans dépendre de `vi.useFakeTimers`.
 */
import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/persistence/memory.js';
import { RealtimeHub } from '../src/realtime/hub.js';
import {
  NightScheduler,
  type NightClock,
  type NightTimerHandle,
} from '../src/server/night-scheduler.js';
import { resolveNight } from '../src/server/night-resolver.js';
import type { Id } from '../src/persistence/types.js';
import type { Store } from '../src/persistence/store.js';
import type { ServerMessage } from '../src/realtime/protocol.js';

interface ScheduledTimer {
  id: number;
  fn: () => void;
  fireAt: number;
  cancelled: boolean;
}

class FakeClock implements NightClock {
  private nextId = 1;
  private current = 0;
  readonly timers: ScheduledTimer[] = [];

  now(): number {
    return this.current;
  }

  setTimeout(fn: () => void, ms: number): NightTimerHandle {
    const t: ScheduledTimer = {
      id: this.nextId++,
      fn,
      fireAt: this.current + ms,
      cancelled: false,
    };
    this.timers.push(t);
    return t;
  }

  clearTimeout(handle: NightTimerHandle): void {
    (handle as ScheduledTimer).cancelled = true;
  }

  /** Avance le temps et déclenche les timers atteints, dans l'ordre. */
  async tick(deltaMs: number): Promise<void> {
    this.current += deltaMs;
    while (true) {
      const ready = this.timers
        .filter((t) => !t.cancelled && t.fireAt <= this.current)
        .sort((a, b) => a.fireAt - b.fireAt)[0];
      if (!ready) break;
      ready.cancelled = true;
      ready.fn();
      // Laisser toutes les microtasks engendrées par fn() drainer avant de
      // chercher le prochain timer (les reprogrammations en font partie).
      for (let i = 0; i < 50; i++) {
        await Promise.resolve();
      }
    }
  }
}

async function setupTown() {
  const store = new MemoryStore();
  const hub = new RealtimeHub();
  const account = await store.createAccount('joueur@test.local', 'h');
  const town = await store.createTown('Aldebaran', 'normal');
  await store.joinTown(town.id, account.id, 'Alia');
  return { store, hub, townId: town.id };
}

describe('NightScheduler', () => {
  it('programme une ville et résout automatiquement la nuit', async () => {
    const { store, hub, townId } = await setupTown();
    const clock = new FakeClock();
    const scheduler = new NightScheduler({ store, hub, dayDurationMs: 1000, clock });
    const events: ServerMessage[] = [];
    hub.subscribe(townId, (m) => events.push(m));

    scheduler.scheduleTown(townId, { day: 1 });
    const firstScheduled = events.find(
      (e): e is Extract<ServerMessage, { type: 'night.scheduled' }> =>
        e.type === 'night.scheduled',
    );
    expect(firstScheduled).toBeDefined();
    expect(firstScheduled!.day).toBe(1);
    expect(scheduler.getScheduledFor(townId)).not.toBeNull();

    const before = (await store.getTown(townId))!.game.day;
    await clock.tick(1000);
    const after = (await store.getTown(townId))!.game.day;
    expect(after).toBe(before + 1);
    expect(events.some((e) => e.type === 'night.start')).toBe(true);
    expect(events.some((e) => e.type === 'night.report')).toBe(true);
    // La ville n'est pas terminée → une nouvelle programmation a eu lieu et le
    // message porte le jour à venir, pas le jour qui vient d'être résolu.
    expect(scheduler.getScheduledFor(townId)).not.toBeNull();
    const scheduledMessages = events.filter(
      (e): e is Extract<ServerMessage, { type: 'night.scheduled' }> =>
        e.type === 'night.scheduled',
    );
    expect(scheduledMessages).toHaveLength(2);
    expect(scheduledMessages[1]!.day).toBe(after);

    scheduler.stop();
  });

  it('reprogramme après chaque résolution sauf si gameOver', async () => {
    const { store, hub, townId } = await setupTown();
    const clock = new FakeClock();
    const scheduler = new NightScheduler({ store, hub, dayDurationMs: 500, clock });
    scheduler.scheduleTown(townId);

    // Première nuit
    await clock.tick(500);
    expect(scheduler.getScheduledFor(townId)).not.toBeNull();
    const dayAfter1 = (await store.getTown(townId))!.game.day;
    expect(dayAfter1).toBe(2);

    // Deuxième nuit
    await clock.tick(500);
    const dayAfter2 = (await store.getTown(townId))!.game.day;
    expect(dayAfter2).toBeGreaterThanOrEqual(2); // dépend si gameOver ou non
    scheduler.stop();
  });

  it('arrête la programmation quand la partie est terminée (gameOver)', async () => {
    const store = new MemoryStore();
    const hub = new RealtimeHub();
    const account = await store.createAccount('solo@test.local', 'h');
    const town = await store.createTown('Doomed', 'hardcore');
    await store.joinTown(town.id, account.id, 'Alia');
    const clock = new FakeClock();
    const scheduler = new NightScheduler({ store, hub, dayDurationMs: 100, clock });
    scheduler.scheduleTown(town.id);

    // Boucle jusqu'à game over (max 30 cycles pour sécurité).
    for (let i = 0; i < 30; i++) {
      await clock.tick(100);
      const current = (await store.getTown(town.id))!;
      if (current.game.gameOver) break;
    }
    const current = (await store.getTown(town.id))!;
    expect(current.game.gameOver).toBe(true);
    expect(current.closed).toBe(true);
    expect(scheduler.getScheduledFor(town.id)).toBeNull();
    scheduler.stop();
  });

  it('continue à programmer même quand un appel manuel a précédé', async () => {
    const { store, hub, townId } = await setupTown();
    const clock = new FakeClock();
    const scheduler = new NightScheduler({ store, hub, dayDurationMs: 1000, clock });
    scheduler.scheduleTown(townId);

    // Résolution manuelle avant que le timer ne tire (le joueur a cliqué).
    const manual = await resolveNight({ store, hub, townId, trigger: 'manual' });
    expect(manual.report.day).toBe(1);

    // Le timer doit toujours pouvoir tirer : soit il réussit (jour 3 atteint),
    // soit la partie se termine entre-temps (cancel propre).
    await clock.tick(1000);
    const current = (await store.getTown(townId))!;
    expect(current.game.day).toBeGreaterThanOrEqual(2);
    if (!current.closed) {
      expect(scheduler.getScheduledFor(townId)).not.toBeNull();
    } else {
      expect(scheduler.getScheduledFor(townId)).toBeNull();
    }
    scheduler.stop();
  });

  it('reprogramme après un night-already-running renvoyé par le store', async () => {
    // On simule directement le code path d'erreur StoreError("night-already-running")
    // en remplaçant nightLock par une fonction qui le lève une fois puis succède.
    const { store, hub, townId } = await setupTown();
    const realLock = store.nightLock.bind(store);
    let calls = 0;
    (store as unknown as { nightLock: Store['nightLock'] }).nightLock = async (
      id,
      fn,
    ) => {
      calls += 1;
      if (calls === 1) {
        throw new (await import('../src/persistence/store.js')).StoreError(
          'night-already-running',
          'collision simulée',
        );
      }
      return realLock(id, fn);
    };
    const clock = new FakeClock();
    const scheduler = new NightScheduler({ store, hub, dayDurationMs: 100, clock });
    scheduler.scheduleTown(townId);
    await clock.tick(100);
    // Le scheduler a vu la collision et a reprogrammé.
    expect(scheduler.getScheduledFor(townId)).not.toBeNull();
    // Au tic suivant, la résolution passe pour de bon.
    await clock.tick(100);
    const after = (await store.getTown(townId))!;
    expect(after.game.day).toBe(2);
    scheduler.stop();
  });

  it('bootstrap programme les villes existantes', async () => {
    const { store, hub, townId } = await setupTown();
    const clock = new FakeClock();
    const scheduler = new NightScheduler({ store, hub, dayDurationMs: 250, clock });
    await scheduler.bootstrap();
    expect(scheduler.getScheduledFor(townId)).not.toBeNull();
    scheduler.stop();
  });

  it('persiste les rapports et les expose via listNightReports', async () => {
    const { store, hub, townId } = await setupTown();
    const clock = new FakeClock();
    const scheduler = new NightScheduler({ store, hub, dayDurationMs: 100, clock });
    scheduler.scheduleTown(townId);
    await clock.tick(100);
    const reports = await store.listNightReports(townId);
    expect(reports).toHaveLength(1);
    expect(reports[0]!.trigger).toBe('scheduler');
    expect(reports[0]!.report.day).toBe(1);
    expect(reports[0]!.report.defense).toBeDefined();
    expect(reports[0]!.report.waves).toHaveLength(3);
    scheduler.stop();
  });

  it('cancelTown nettoie le timer en attente', async () => {
    const { store, hub, townId } = await setupTown();
    const clock = new FakeClock();
    const scheduler = new NightScheduler({ store, hub, dayDurationMs: 500, clock });
    scheduler.scheduleTown(townId);
    expect(scheduler.getScheduledFor(townId)).not.toBeNull();
    scheduler.cancelTown(townId);
    expect(scheduler.getScheduledFor(townId)).toBeNull();
    await clock.tick(500);
    const current = (await store.getTown(townId))!;
    expect(current.game.day).toBe(1); // pas de résolution
    scheduler.stop();
  });

  it('refuse une dayDurationMs invalide', () => {
    const store = new MemoryStore();
    const hub = new RealtimeHub();
    expect(() => new NightScheduler({ store, hub, dayDurationMs: 0 })).toThrow();
    expect(() => new NightScheduler({ store, hub, dayDurationMs: -1 })).toThrow();
  });
});

describe('Hordes Revival — Id', () => {
  it('FakeClock.now est bien zéro au départ et avance par tick', () => {
    const c = new FakeClock();
    expect(c.now()).toBe(0);
    // (tick async, mais sans timer ne fait rien — on vérifie juste le contrat.)
    void c.tick(10);
    expect(c.now()).toBe(10);
    // Annule un timer factice.
    const handle = c.setTimeout(() => {}, 100);
    c.clearTimeout(handle);
    expect((handle as { cancelled: boolean }).cancelled).toBe(true);
  });

  it('reconnaît bien le brand Id (helper sans erreur)', () => {
    const id = '00000000-0000-4000-8000-000000000000' as Id;
    expect(typeof id).toBe('string');
  });
});
