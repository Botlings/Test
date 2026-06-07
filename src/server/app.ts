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
import type { NightScheduler } from './night-scheduler.js';
import type { Store } from '../persistence/store.js';
import type { Id } from '../persistence/types.js';
import { RealtimeHub } from '../realtime/hub.js';
import type { ServerMessage } from '../realtime/protocol.js';

export interface AppDeps {
  readonly store: Store;
  readonly hub: RealtimeHub;
  readonly jwtSecret: string;
  readonly accessTokenTtlSeconds?: number;
  readonly secureCookies?: boolean;
  readonly logger?: boolean;
  readonly scheduler?: NightScheduler;
}

export interface BuiltApp {
  readonly app: FastifyInstance;
  readonly store: Store;
  readonly hub: RealtimeHub;
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
  } = deps;

  const app = Fastify({ logger });
  await app.register(cookiePlugin);
  await app.register(websocketPlugin);

  // Sondes de santé.
  //   - /health/live  : process vivant (utilisé par Docker HEALTHCHECK et Render)
  //   - /health/ready : le process est prêt à servir (DB joignable)
  //   - /health       : alias de /health/live (rétro-compat)
  const startedAt = new Date();
  app.get('/health', async () => ({ status: 'ok', uptimeMs: Date.now() - startedAt.getTime() }));
  app.get('/health/live', async () => ({
    status: 'ok',
    uptimeMs: Date.now() - startedAt.getTime(),
  }));
  app.get('/health/ready', async (_request, reply) => {
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
  registerTownRoutes(app, { store, jwtSecret, hub, scheduler });
  registerActionRoutes(app, { store, jwtSecret, hub, scheduler });

  app.get('/ws', { websocket: true }, (socket: WebSocket, request) => {
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

      // Snapshot initial
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

      const unsubscribe = hub.subscribe(townId, (msg) => {
        if (socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify(msg));
        }
      });
      socket.on('close', unsubscribe);
      socket.on('error', unsubscribe);
    })();
  });

  return { app, store, hub, scheduler };
}
