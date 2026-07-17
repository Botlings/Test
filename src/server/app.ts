/**
 * Fabrique l'application Fastify de Hordes Revival.
 *
 * - Routes REST montées sous `/auth`, `/towns`, `/towns/:id/...`.
 * - Endpoint WebSocket `/ws?townId=<id>&token=<jwt>` qui pousse en temps
 *   réel tous les `ServerMessage` émis pour la ville.
 *
 * L'app n'écoute pas par elle-même : `main.ts` (ou un test d'intégration)
 * appelle `app.listen(...)` ou `app.inject(...)`. Les dépendances (store,
 * hub, secret) sont injectées pour faciliter les tests.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import cookiePlugin from '@fastify/cookie';
import websocketPlugin from '@fastify/websocket';
import type { WebSocket } from 'ws';
import { verifyJwt } from './crypto.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerTownRoutes } from './routes/towns.js';
import { registerActionRoutes } from './routes/actions.js';
import { registerForumRoutes } from './routes/forum.js';
import { registerGovernanceRoutes } from './routes/governance.js';
import { registerPlayerRoutes } from './routes/players.js';
import type { NightScheduler } from './night-scheduler.js';
import type { Store } from '../persistence/store.js';
import type { Id } from '../persistence/types.js';
import { RealtimeHub } from '../realtime/hub.js';
import { PresenceRegistry } from '../realtime/presence.js';
import type { ClientMessage, ServerMessage } from '../realtime/protocol.js';

export interface AppDeps {
  readonly store: Store;
  readonly hub: RealtimeHub;
  readonly jwtSecret: string;
  readonly accessTokenTtlSeconds?: number;
  readonly secureCookies?: boolean;
  readonly logger?: boolean;
  readonly scheduler?: NightScheduler;
  /** Registre de présence temps réel. Créé par défaut si non fourni. */
  readonly presence?: PresenceRegistry;
  /**
   * Période du heartbeat WebSocket (ping serveur → pong client) en
   * millisecondes. Une connexion qui n'a pas répondu au ping précédent est
   * purgée au tour suivant, ce qui libère sa présence. Défaut : 30 000 ms.
   * `0` désactive le heartbeat (utile pour certains tests).
   */
  readonly heartbeatIntervalMs?: number;
}

export interface BuiltApp {
  readonly app: FastifyInstance;
  readonly store: Store;
  readonly hub: RealtimeHub;
  readonly presence: PresenceRegistry;
  readonly scheduler?: NightScheduler;
}

export async function buildApp(deps: AppDeps): Promise<BuiltApp> {
  const {
    store,
    hub,
    jwtSecret,
    accessTokenTtlSeconds = 15 * 60,
    secureCookies = false,
    logger = false,
    scheduler,
    presence = new PresenceRegistry(),
    heartbeatIntervalMs = 30_000,
  } = deps;

  const app = Fastify({ logger });
  await app.register(cookiePlugin);
  await app.register(websocketPlugin);

  // Heartbeat WebSocket : sans lui, une connexion coupée brutalement (réseau
  // mobile perdu, veille, onglet tué sans handshake de fermeture TCP) laisse un
  // socket « à moitié ouvert » — l'événement `close` n'arrive jamais et le
  // citoyen resterait « en ligne » en fantôme, faussant l'indicateur de
  // présence et le compteur d'occupation de la ville. On sonde donc chaque
  // socket : `sawPong=false` signifie « n'a pas répondu au ping précédent » →
  // on termine la connexion, ce qui déclenche `close` → purge de la présence.
  // Les navigateurs répondent automatiquement au ping protocolaire ; seules les
  // connexions réellement mortes sont purgées.
  const sawPong = new WeakMap<WebSocket, boolean>();
  if (heartbeatIntervalMs > 0) {
    const timer = setInterval(() => {
      for (const client of app.websocketServer.clients) {
        const socket = client as WebSocket;
        if (sawPong.get(socket) === false) {
          socket.terminate();
          continue;
        }
        sawPong.set(socket, false);
        try {
          socket.ping();
        } catch {
          // Socket en cours de fermeture : ignoré, il sera purgé au tour suivant.
        }
      }
    }, heartbeatIntervalMs);
    // Ne pas maintenir le process (ni la boucle de test) en vie pour ce timer.
    timer.unref?.();
    app.addHook('onClose', async () => clearInterval(timer));
  }

  // Sondes de santé.
  //   - /health/live  : process vivant (utilisé par Docker HEALTHCHECK et Render)
  //   - /health/ready : le process est prêt à servir (DB joignable)
  //   - /health       : alias de /health/live (rétro-compat)
  const startedAt = new Date();
  // Les sondes sont publiques et consommées en cross-origin par la page de
  // statut statique (GitHub Pages → hordesrevival.com/status). On expose donc
  // `Access-Control-Allow-Origin: *` à la main, comme `GET /leaderboard` ;
  // lecture seule, aucune donnée sensible, pas de cookies.
  app.get('/health', async (_request, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
    return { status: 'ok', uptimeMs: Date.now() - startedAt.getTime() };
  });
  app.get('/health/live', async (_request, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
    return {
      status: 'ok',
      uptimeMs: Date.now() - startedAt.getTime(),
    };
  });
  app.get('/health/ready', async (_request, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
    try {
      await store.ping();
      return { status: 'ok', store: 'ready' };
    } catch (err) {
      reply.code(503);
      return {
        status: 'unavailable',
        store: 'unreachable',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  registerAuthRoutes(app, { store, jwtSecret, accessTokenTtlSeconds, secureCookies });
  registerTownRoutes(app, { store, jwtSecret, hub, scheduler, presence });
  registerActionRoutes(app, { store, jwtSecret, hub, scheduler });
  registerForumRoutes(app, { store, jwtSecret, hub });
  registerGovernanceRoutes(app, { store, jwtSecret, hub, presence });
  registerPlayerRoutes(app, { store });

  app.get('/ws', { websocket: true }, (socket: WebSocket, request) => {
    // Vivant tant qu'il n'a pas manqué un pong (voir le heartbeat plus haut).
    sawPong.set(socket, true);
    socket.on('pong', () => sawPong.set(socket, true));
    const url = new URL(request.url, 'http://localhost');
    const token = url.searchParams.get('token');
    const townId = url.searchParams.get('townId') as Id | null;
    if (!token || !townId) {
      socket.send(
        JSON.stringify({
          type: 'error',
          code: 'ws-params-missing',
          message: 'token et townId requis',
        } satisfies ServerMessage),
      );
      socket.close();
      return;
    }
    let accountId: Id;
    try {
      accountId = verifyJwt(token, jwtSecret).sub as Id;
    } catch (err) {
      socket.send(
        JSON.stringify({
          type: 'error',
          code: 'ws-auth-invalid',
          message: err instanceof Error ? err.message : 'Token invalide',
        } satisfies ServerMessage),
      );
      socket.close();
      return;
    }

    void (async () => {
      const town = await store.getTown(townId);
      if (!town || !town.membership.has(accountId)) {
        socket.send(
          JSON.stringify({
            type: 'error',
            code: 'ws-not-a-citizen',
            message: 'Vous devez être citoyen de cette ville',
          } satisfies ServerMessage),
        );
        socket.close();
        return;
      }
      const citizenId = town.membership.get(accountId) ?? null;
      const citizenName =
        town.game.status().citizens.find((c) => c.id === citizenId)?.name ?? null;

      // Snapshot initial de l'état de la ville.
      const status = town.game.status();
      socket.send(
        JSON.stringify({
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
        } satisfies ServerMessage),
      );

      // Instantané de présence : qui est connecté en ce moment.
      socket.send(
        JSON.stringify({
          type: 'presence.snapshot',
          online: presence.online(townId).map((id) => ({
            accountId: id,
            citizenId: town.membership.get(id) ?? null,
          })),
          onlineCount: presence.onlineCount(townId),
        } satisfies ServerMessage),
      );

      const unsubscribe = hub.subscribe(townId, (msg) => {
        if (socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify(msg));
        }
      });

      // Enregistre la connexion et notifie les autres si c'est le premier onglet.
      const arrival = presence.connect(townId, accountId);
      if (arrival.changed) {
        hub.publish(townId, {
          type: 'presence.update',
          accountId,
          citizenId,
          present: true,
          onlineCount: arrival.onlineCount,
        });
      }

      // Messages montants : chat de ville + heartbeat applicatif.
      socket.on('message', (raw: unknown) => {
        // Tout trafic montant atteste que la connexion est vivante.
        sawPong.set(socket, true);
        let parsed: unknown;
        try {
          parsed = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (typeof parsed !== 'object' || parsed === null) return;
        const msg = parsed as ClientMessage;
        if (msg.type === 'chat.send') {
          const text = typeof msg.text === 'string' ? msg.text.trim() : '';
          if (text.length === 0 || text.length > 500) return;
          hub.publish(townId, {
            type: 'chat.message',
            from: citizenName ?? 'Inconnu',
            text,
            at: new Date().toISOString(),
          });
        }
        // 'ping' / 'auth' : no-op (auth déjà faite via la query string).
      });

      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        unsubscribe();
        const departure = presence.disconnect(townId, accountId);
        if (departure.changed) {
          hub.publish(townId, {
            type: 'presence.update',
            accountId,
            citizenId,
            present: false,
            onlineCount: departure.onlineCount,
          });
        }
      };
      socket.on('close', release);
      socket.on('error', release);
    })();
  });

  return { app, store, hub, presence, scheduler };
}
