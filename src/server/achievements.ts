/**
 * Attribution des hauts faits (achievements) côté serveur.
 *
 * Le catalogue et les règles de déblocage sont PURS (`domain/achievements.ts`).
 * Ce module fait le pont entre un événement de jeu (action de construction,
 * fouille, résolution de nuit) et la persistance idempotente du `Store`.
 *
 * Aucun `unlock` n'écrase un badge déjà acquis (le Store renvoie `false`) ; on
 * renvoie donc à l'appelant la liste des badges *nouvellement* débloqués, ce
 * qui permettra à terme de notifier le joueur sans le spammer.
 */
import type { Store } from '../persistence/store.js';
import type { Id } from '../persistence/types.js';
import {
  buildAchievements,
  nightAchievements,
  scavengeAchievements,
  type AchievementId,
} from '../domain/achievements.js';
import type { NightReport } from '../domain/index.js';
import type { TownRecord } from '../persistence/store.js';

/**
 * Débloque une liste de badges pour un compte et renvoie ceux qui étaient
 * réellement nouveaux. Tolérant aux pannes : une erreur de persistance sur un
 * badge n'interrompt pas le flux de jeu (les hauts faits sont un bonus, jamais
 * un point de blocage).
 */
export async function awardAchievements(
  store: Store,
  accountId: Id,
  ids: readonly AchievementId[],
): Promise<AchievementId[]> {
  const unlocked: AchievementId[] = [];
  for (const id of ids) {
    try {
      if (await store.unlockAchievement(accountId, id)) unlocked.push(id);
    } catch {
      // Un badge non enregistré ne doit jamais casser l'action du joueur.
    }
  }
  return unlocked;
}

/** Badge « Premier Bâtisseur » après une construction réussie. */
export function awardBuildAchievements(
  store: Store,
  accountId: Id,
): Promise<AchievementId[]> {
  return awardAchievements(store, accountId, buildAchievements());
}

/** Badge « Pilleur du Désert » après un butin rapporté du désert. */
export function awardScavengeAchievements(
  store: Store,
  accountId: Id,
  gained: { resource?: boolean; item?: boolean; event?: boolean },
): Promise<AchievementId[]> {
  return awardAchievements(store, accountId, scavengeAchievements(gained));
}

/**
 * Évalue et débloque les hauts faits de nuit pour chaque membre de la ville
 * dont le citoyen a survécu (Héros Nocturne, Survivant 7 jours, Sauveur de la
 * Ville). Parcourt la table de membership pour retrouver, compte par compte,
 * le devenir de son citoyen dans l'état d'après-nuit.
 */
export async function awardNightAchievements(
  store: Store,
  town: TownRecord,
  report: NightReport,
): Promise<void> {
  const citizens = town.game.status().citizens;
  for (const [accountId, citizenId] of town.membership.entries()) {
    const citizen = citizens.find((c) => c.id === citizenId);
    const ids = nightAchievements({
      nightDay: report.day,
      hordePower: report.hordePower,
      breached: report.breached,
      outcome: report.outcome,
      citizenAlive: !!citizen && citizen.alive,
    });
    if (ids.length > 0) await awardAchievements(store, accountId, ids);
  }
}
