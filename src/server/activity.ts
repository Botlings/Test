/**
 * Helper applicatif d'écriture du journal d'activité d'une ville.
 *
 * Centralise deux choses qui doivent toujours aller ensemble :
 *   - persistance de l'entrée via `Store.recordActivity`,
 *   - publication temps réel d'un `activity.recorded` sur le hub.
 *
 * Utilisé par les routes (`towns`, `actions`, `forum`) et par le résolveur
 * de nuit. Ne lève pas d'erreur : un échec de journalisation ne doit pas
 * faire échouer l'action métier qui vient d'aboutir.
 */
import type { Store, ActivityInput } from '../persistence/store.js';
import type { Id } from '../persistence/types.js';
import type { RealtimeHub } from '../realtime/hub.js';

export async function publishActivity(
  store: Store,
  hub: RealtimeHub,
  townId: Id,
  input: ActivityInput,
): Promise<void> {
  try {
    const entry = await store.recordActivity(townId, input);
    hub.publish(townId, { type: 'activity.recorded', entry });
  } catch {
    // Une perte d'entrée d'audit ne doit pas casser l'action joueur.
  }
}
