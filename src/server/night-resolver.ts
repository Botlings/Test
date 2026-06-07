/**
 * Résolution d'une nuit (Jalon 1) — extrait pour être partagé entre l'API
 * REST (`POST /towns/:townId/night`) et le scheduler automatique
 * (`night-scheduler.ts`).
 *
 * Le résolveur :
 *   - acquiert le lock NX-EX `nightLock` du store,
 *   - vérifie l'état de la ville (existe, non close, en phase `day`),
 *   - publie `night.start`, exécute `endDay()`, persiste l'état,
 *   - journalise l'événement et le rapport détaillé,
 *   - diffuse `night.report` et un nouveau `town.snapshot`.
 *
 * Toute erreur métier sort sous forme de `StoreError` ou `GameRuleError`,
 * laissant le soin à l'appelant (route HTTP ou scheduler) de gérer le code
 * de réponse / le re-scheduling.
 */
import { StoreError, type Store, type TownRecord } from '../persistence/store.js';
import type { Id } from '../persistence/types.js';
import type { RealtimeHub } from '../realtime/hub.js';
import type { NightReport } from '../domain/index.js';
import type { ServerMessage } from '../realtime/protocol.js';
import { publishActivity } from './activity.js';

export type NightTrigger = 'manual' | 'scheduler';

export interface NightResolveDeps {
  readonly store: Store;
  readonly hub: RealtimeHub;
  readonly townId: Id;
  readonly trigger: NightTrigger;
}

export interface NightResolveResult {
  readonly report: NightReport;
}

export function publishTownSnapshot(hub: RealtimeHub, town: TownRecord): void {
  const status = town.game.status();
  hub.publish(town.id, {
    type: 'town.snapshot',
    day: status.day,
    phase: status.phase,
    resources: { ...status.bank },
    citizens: status.citizens.map((c) => ({
      id: c.id,
      name: c.name,
      location: c.location,
      alive: c.alive,
    })),
  } satisfies ServerMessage);
}

export async function resolveNight(
  deps: NightResolveDeps,
): Promise<NightResolveResult> {
  const { store, hub, townId, trigger } = deps;
  const report = await store.nightLock(townId, async () => {
    const current = await store.getTown(townId);
    if (!current) {
      throw new StoreError('town-not-found', 'Ville introuvable');
    }
    if (current.closed) {
      throw new StoreError('town-closed', 'Cette ville est terminée');
    }
    if (current.game.status().phase !== 'day') {
      throw new StoreError('night-already-running', 'La nuit est déjà en cours');
    }
    hub.publish(townId, { type: 'night.start', day: current.game.day });

    const out = current.game.endDay();
    if (out.gameOver) {
      current.closed = true;
    }
    await store.saveTown(current);
    await store.recordNightEvent(townId, {
      day: out.day,
      attackers: out.hordePower,
      defense: out.townDefense,
      breached: out.breached,
      deaths: out.deaths.length,
    });
    await store.recordNightReport(townId, trigger, out);

    hub.publish(townId, {
      type: 'night.report',
      day: out.day,
      trigger,
      report: out,
    });
    publishTownSnapshot(hub, current);

    // Journal d'activité : la nuit elle-même + chaque décès individuel.
    await publishActivity(store, hub, townId, {
      accountId: null,
      citizenId: null,
      citizenName: null,
      kind: 'night.resolved',
      details: {
        day: out.day,
        hordePower: out.hordePower,
        defense: out.townDefense,
        deaths: out.deaths.length,
        breached: out.breached,
        survivors: out.survivors,
        gameOver: out.gameOver,
        trigger,
      },
    });
    for (const death of out.deaths) {
      await publishActivity(store, hub, townId, {
        accountId: null,
        citizenId: death.citizenId,
        citizenName: death.name,
        kind: 'citizen.died',
        details: { cause: death.cause, source: death.source, day: out.day },
      });
    }
    return out;
  });
  return { report };
}
