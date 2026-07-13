/**
 * Routes des actions de jeu (Jour 1 et au-delà) :
 *   POST /towns/:townId/citizens/:citizenId/action
 *   POST /towns/:townId/night
 *   GET  /buildings/catalog
 *
 * Le corps d'une action discrimine sur `type` :
 *   { type: 'move',         to: 'town' | 'desert' }      — gateway legacy
 *   { type: 'move-zone',    x: number, y: number }       — déplacement précis
 *   { type: 'scavenge' }                                  — fouille zone courante
 *   { type: 'scavenge-zone' }                             — alias explicite
 *   { type: 'fight' }                                     — chasse un zombie
 *   { type: 'loot-event' }                                — pille l'événement de zone
 *   { type: 'build'        }                              — renfort générique (legacy)
 *   { type: 'construct',    buildingId: BuildingId }      — bâtiment du catalogue
 *
 * Toute mutation publie un événement sur le hub temps réel ; la résolution
 * de nuit est protégée par `store.nightLock` (sémantique NX-EX).
 */
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth-guard.js';
import { GameRuleError } from '../../domain/game.js';
import {
  BUILDING_CATALOG,
  getBuildingDef,
  isKnownBuildingId,
} from '../../domain/buildings.js';
import { ITEM_CATALOG } from '../../domain/items.js';
import { NIGHT_THREAT_CATALOG } from '../../domain/zombies.js';
import type { Location } from '../../domain/types.js';
import { StoreError, canSpendBank, type Store } from '../../persistence/store.js';
import type { Id } from '../../persistence/types.js';
import type { RealtimeHub } from '../../realtime/hub.js';
import type { NightScheduler } from '../night-scheduler.js';
import { publishTownSnapshot, resolveNight } from '../night-resolver.js';
import { publishActivity } from '../activity.js';

interface ActionsDeps {
  readonly store: Store;
  readonly jwtSecret: string;
  readonly hub: RealtimeHub;
  readonly scheduler?: NightScheduler;
}

const LOCATIONS: ReadonlySet<Location> = new Set(['town', 'desert']);

export function registerActionRoutes(app: FastifyInstance, deps: ActionsDeps): void {
  const { store, jwtSecret, hub, scheduler } = deps;

  /* ------------------------ GET /buildings/catalog ------------------------- */
  // Public (pas de requireAuth) — un client non connecté peut afficher la
  // grille des bâtiments en page d'accueil pour communiquer sur le jeu.
  app.get('/buildings/catalog', async (_request, reply) => {
    return reply.code(200).send({
      buildings: BUILDING_CATALOG.map((b) => ({
        id: b.id,
        name: b.name,
        description: b.description,
        icon: b.icon,
        cost: b.cost,
        itemCost: b.itemCost ?? {},
        actionPointCost: b.actionPointCost,
        wallDefense: b.wallDefense,
        watchBonusPerCitizen: b.watchBonusPerCitizen,
        waterPerDawn: b.waterPerDawn,
        hordeDeterrence: b.hordeDeterrence,
        casualtyReduction: b.casualtyReduction,
        maxCount: b.maxCount,
      })),
    });
  });

  /* ------------------------- GET /items/catalog ---------------------------- */
  // Public : la grille des objets récupérables du désert (outils, vivres,
  // matériaux rares) alimente la page vitrine et l'aide en jeu.
  app.get('/items/catalog', async (_request, reply) => {
    return reply.code(200).send({
      items: ITEM_CATALOG.map((it) => ({
        id: it.id,
        name: it.name,
        description: it.description,
        icon: it.icon,
        category: it.category,
        rarity: it.rarity,
        minDistance: it.minDistance,
        rations: it.rations,
      })),
    });
  });

  /* ------------------------ GET /zombies/catalog --------------------------- */
  // Public : le bestiaire des zombies spéciaux de l'assaut nocturne.
  app.get('/zombies/catalog', async (_request, reply) => {
    return reply.code(200).send({
      threats: NIGHT_THREAT_CATALOG.map((z) => ({
        kind: z.kind,
        name: z.name,
        icon: z.icon,
        description: z.description,
      })),
    });
  });

  /* ----------- POST /towns/:townId/citizens/:citizenId/action -------------- */
  app.post('/towns/:townId/citizens/:citizenId/action', async (request, reply) => {
    const accountId = requireAuth(request, reply, { jwtSecret });
    if (!accountId) return;
    const params = request.params as { townId?: string; citizenId?: string };
    const townId = params.townId as Id | undefined;
    const citizenId = params.citizenId;
    if (!townId || !citizenId) {
      return reply.code(400).send({
        error: { code: 'params-missing', message: 'townId et citizenId requis' },
      });
    }
    const town = await store.getTown(townId);
    if (!town) {
      return reply.code(404).send({
        error: { code: 'town-not-found', message: 'Ville introuvable' },
      });
    }
    if (town.closed) {
      return reply.code(409).send({
        error: { code: 'town-closed', message: 'Cette ville est terminée' },
      });
    }
    const ownerCitizenId = town.membership.get(accountId);
    if (!ownerCitizenId || ownerCitizenId !== citizenId) {
      return reply.code(403).send({
        error: { code: 'not-your-citizen', message: 'Vous ne pouvez agir que pour votre citoyen' },
      });
    }

    const body = request.body as
      | {
          type?: unknown;
          to?: unknown;
          buildingId?: unknown;
          x?: unknown;
          y?: unknown;
        }
      | undefined;
    const actionType = typeof body?.type === 'string' ? body.type : '';
    const statusBefore = town.game.status();
    const citizenBefore = statusBefore.citizens.find((c) => c.id === citizenId);
    const citizenName = citizenBefore?.name ?? citizenId;
    try {
      switch (actionType) {
        case 'move': {
          const to = body?.to;
          if (typeof to !== 'string' || !LOCATIONS.has(to as Location)) {
            return reply.code(400).send({
              error: { code: 'location-invalid', message: 'Destination invalide (town | desert)' },
            });
          }
          town.game.setLocation(citizenId, to as Location);
          await store.saveTown(town);
          hub.publish(townId, { type: 'citizen.moved', citizenId, to: to as Location });
          await publishActivity(store, hub, townId, {
            accountId,
            citizenId,
            citizenName,
            kind: 'citizen.move',
            details: { to: to as Location },
          });
          break;
        }
        case 'scavenge': {
          const bankBefore = { ...statusBefore.bank };
          const scav = town.game.scavenge(citizenId);
          await store.saveTown(town);
          publishTownSnapshot(hub, town);
          const bankAfter = town.game.status().bank;
          const gained: Record<string, number> = {};
          for (const k of Object.keys(bankAfter) as Array<keyof typeof bankAfter>) {
            const delta = bankAfter[k] - (bankBefore[k] ?? 0);
            if (delta !== 0) gained[k] = delta;
          }
          if (scav.foundItem) gained.item = 1;
          await publishActivity(store, hub, townId, {
            accountId,
            citizenId,
            citizenName,
            kind: 'citizen.scavenge',
            details: { ...gained, foundItem: scav.foundItem ?? null },
          });
          break;
        }
        case 'build': {
          // La construction puise dans la banque commune : soumise au régime
          // d'accès (open = tous, restricted = fondateur + gestionnaires).
          if (!canSpendBank(town, accountId)) {
            return reply.code(403).send({
              error: {
                code: 'bank-restricted',
                message: 'La banque est en accès restreint : seuls le fondateur et les gestionnaires peuvent construire',
              },
            });
          }
          town.game.build(citizenId);
          await store.saveTown(town);
          publishTownSnapshot(hub, town);
          const defense = town.game.status().townDefense;
          hub.publish(townId, {
            type: 'build.completed',
            structureId: `${townId}-build-${Date.now()}`,
            defense,
          });
          await publishActivity(store, hub, townId, {
            accountId,
            citizenId,
            citizenName,
            kind: 'citizen.build',
            details: { defense },
          });
          break;
        }
        case 'construct': {
          const buildingId = body?.buildingId;
          if (typeof buildingId !== 'string' || !isKnownBuildingId(buildingId)) {
            return reply.code(400).send({
              error: { code: 'building-unknown', message: 'Bâtiment inconnu' },
            });
          }
          if (!canSpendBank(town, accountId)) {
            return reply.code(403).send({
              error: {
                code: 'bank-restricted',
                message: 'La banque est en accès restreint : seuls le fondateur et les gestionnaires peuvent construire',
              },
            });
          }
          const result = town.game.constructBuilding(citizenId, buildingId);
          await store.saveTown(town);
          publishTownSnapshot(hub, town);
          const def = getBuildingDef(buildingId)!;
          hub.publish(townId, {
            type: 'build.completed',
            structureId: `${townId}-${buildingId}-${result.count}`,
            defense: result.townDefense,
          });
          await publishActivity(store, hub, townId, {
            accountId,
            citizenId,
            citizenName,
            kind: 'citizen.construct',
            details: {
              buildingId,
              buildingName: def.name,
              count: result.count,
              defense: result.townDefense,
            },
          });
          break;
        }
        case 'move-zone': {
          const x = body?.x;
          const y = body?.y;
          if (typeof x !== 'number' || typeof y !== 'number'
              || !Number.isInteger(x) || !Number.isInteger(y)) {
            return reply.code(400).send({
              error: { code: 'coords-invalid', message: 'x et y doivent être des entiers' },
            });
          }
          const { discovered } = town.game.moveToZone(citizenId, { x, y });
          await store.saveTown(town);
          publishTownSnapshot(hub, town);
          hub.publish(townId, {
            type: 'citizen.exploring',
            citizenId,
            x,
            y,
            discovered,
          });
          await publishActivity(store, hub, townId, {
            accountId,
            citizenId,
            citizenName,
            kind: 'citizen.explore',
            details: { x, y, discovered },
          });
          break;
        }
        case 'scavenge-zone': {
          const result = town.game.scavengeZone(citizenId);
          await store.saveTown(town);
          publishTownSnapshot(hub, town);
          const picked = result.picked ?? null;
          await publishActivity(store, hub, townId, {
            accountId,
            citizenId,
            citizenName,
            kind: 'citizen.scavenge-zone',
            details: { picked, foundItem: result.foundItem ?? null },
          });
          break;
        }
        case 'fight': {
          const result = town.game.fightZombie(citizenId);
          await store.saveTown(town);
          publishTownSnapshot(hub, town);
          await publishActivity(store, hub, townId, {
            accountId,
            citizenId,
            citizenName,
            kind: 'citizen.fight',
            details: {
              remainingZombies: result.remainingZombies,
              survived: result.citizenAlive,
              nestDestroyed: result.nestDestroyed,
              reward: result.reward ?? null,
            },
          });
          break;
        }
        case 'loot-event': {
          const result = town.game.lootEvent(citizenId);
          await store.saveTown(town);
          publishTownSnapshot(hub, town);
          await publishActivity(store, hub, townId, {
            accountId,
            citizenId,
            citizenName,
            kind: 'citizen.loot-event',
            details: {
              event: result.kind,
              wood: result.gained.wood,
              metal: result.gained.metal,
              water: result.gained.water,
            },
          });
          break;
        }
        default:
          return reply.code(400).send({
            error: {
              code: 'action-unknown',
              message: 'Type d\'action inconnu (move, move-zone, scavenge, scavenge-zone, fight, loot-event, build, construct)',
            },
          });
      }
    } catch (err) {
      if (err instanceof GameRuleError) {
        return reply.code(409).send({
          error: { code: 'rule-violation', message: err.message },
        });
      }
      throw err;
    }

    const status = town.game.status();
    return reply.code(200).send({
      ok: true,
      citizen: status.citizens.find((c) => c.id === citizenId),
      bank: status.bank,
      townDefense: status.townDefense,
      buildings: status.buildings,
      items: status.items,
      threatsTonight: status.threatsTonight,
      desert: status.desert,
      day: status.day,
      phase: status.phase,
    });
  });

  /* ------------------------- POST /towns/:townId/night --------------------- */
  app.post('/towns/:townId/night', async (request, reply) => {
    const accountId = requireAuth(request, reply, { jwtSecret });
    if (!accountId) return;
    const params = request.params as { townId?: string };
    const townId = params.townId as Id | undefined;
    if (!townId) {
      return reply.code(400).send({
        error: { code: 'town-id-missing', message: 'Identifiant de ville manquant' },
      });
    }
    const town = await store.getTown(townId);
    if (!town) {
      return reply.code(404).send({
        error: { code: 'town-not-found', message: 'Ville introuvable' },
      });
    }
    if (!town.membership.has(accountId)) {
      return reply.code(403).send({
        error: { code: 'not-a-citizen', message: 'Vous devez être citoyen de cette ville' },
      });
    }
    try {
      const { report } = await resolveNight({
        store,
        hub,
        townId,
        trigger: 'manual',
      });
      if (scheduler) {
        if (report.gameOver) {
          scheduler.cancelTown(townId);
        } else {
          scheduler.scheduleTown(townId, { day: town.game.day });
        }
      }
      return reply.code(200).send({ report });
    } catch (err) {
      if (err instanceof StoreError) {
        const code = err.code === 'town-not-found' ? 404 : 409;
        return reply.code(code).send({ error: { code: err.code, message: err.message } });
      }
      if (err instanceof GameRuleError) {
        return reply.code(409).send({
          error: { code: 'rule-violation', message: err.message },
        });
      }
      throw err;
    }
  });
}
