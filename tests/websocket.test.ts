/**
 * Test d'intégration WebSocket : un joueur observe en temps réel les
 * actions d'un autre joueur dans la même ville (couverture AC 3.6).
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { buildApp } from '../src/server/app.js';
import { MemoryStore } from '../src/persistence/memory.js';
import { RealtimeHub } from '../src/realtime/hub.js';
import type { ServerMessage } from '../src/realtime/protocol.js';
import { bearer, TEST_SECRET, register } from './helpers/app.js';

interface TownState {
  id: string;
  yourCitizenId: string;
}

describe('WebSocket /ws — synchronisation temps réel', () => {
  let stop: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await stop?.();
    stop = undefined;
  });

  it('un client reçoit un snapshot initial puis les events de la ville', async () => {
    const store = new MemoryStore();
    const hub = new RealtimeHub();
    const { app } = await buildApp({
      store,
      hub,
      jwtSecret: TEST_SECRET,
      accessTokenTtlSeconds: 60 * 60,
      secureCookies: false,
    });
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const url = new URL(address);
    const port = Number(url.port) || (app.server.address() as AddressInfo).port;
    stop = async () => {
      await app.close();
    };

    const alice = await register(app, 'alice@hordes.test', 'password!1');
    const created = await app.inject({
      method: 'POST',
      url: '/towns',
      headers: bearer(alice.body.accessToken!),
      payload: { name: 'Aldebaran', difficulty: 'normal' },
    });
    const town = created.json() as TownState;
    const bob = await register(app, 'bob@hordes.test', 'password!1');
    await app.inject({
      method: 'POST',
      url: `/towns/${town.id}/join`,
      headers: bearer(bob.body.accessToken!),
    });
    const dash = await app.inject({
      method: 'GET',
      url: `/towns/${town.id}`,
      headers: bearer(bob.body.accessToken!),
    });
    const bobCitizenId = (dash.json() as TownState).yourCitizenId;

    // Alice s'abonne au WS de la ville.
    const wsUrl = `ws://127.0.0.1:${port}/ws?townId=${town.id}&token=${encodeURIComponent(
      alice.body.accessToken!,
    )}`;
    const received: ServerMessage[] = [];
    const ws = new WebSocket(wsUrl);
    ws.on('message', (raw) => {
      received.push(JSON.parse(String(raw)) as ServerMessage);
    });
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });
    // Petite latence pour recevoir le snapshot initial.
    await new Promise((r) => setTimeout(r, 50));

    // Bob agit → Alice doit recevoir un citizen.moved.
    await app.inject({
      method: 'POST',
      url: `/towns/${town.id}/citizens/${bobCitizenId}/action`,
      headers: bearer(bob.body.accessToken!),
      payload: { type: 'move', to: 'desert' },
    });
    await new Promise((r) => setTimeout(r, 50));

    ws.close();
    await new Promise((r) => setTimeout(r, 20));

    expect(received[0]?.type).toBe('town.snapshot');
    const moved = received.find((m): m is ServerMessage & { type: 'citizen.moved' } =>
      m.type === 'citizen.moved',
    );
    expect(moved).toBeTruthy();
    expect(moved?.citizenId).toBe(bobCitizenId);
    expect(moved?.to).toBe('desert');
  });

  it('purge une connexion morte via le heartbeat et repasse le citoyen hors-ligne', async () => {
    const store = new MemoryStore();
    const hub = new RealtimeHub();
    // Heartbeat court : deux tours suffisent à purger un socket muet.
    const { app } = await buildApp({
      store,
      hub,
      jwtSecret: TEST_SECRET,
      accessTokenTtlSeconds: 60 * 60,
      secureCookies: false,
      heartbeatIntervalMs: 40,
    });
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const port = Number(new URL(address).port) || (app.server.address() as AddressInfo).port;
    stop = async () => {
      await app.close();
    };

    const alice = await register(app, 'alice@hordes.test', 'password!1');
    const created = await app.inject({
      method: 'POST',
      url: '/towns',
      headers: bearer(alice.body.accessToken!),
      payload: { name: 'Aldebaran', difficulty: 'normal' },
    });
    const town = created.json() as TownState;
    const bob = await register(app, 'bob@hordes.test', 'password!1');
    await app.inject({
      method: 'POST',
      url: `/towns/${town.id}/join`,
      headers: bearer(bob.body.accessToken!),
    });
    const dash = await app.inject({
      method: 'GET',
      url: `/towns/${town.id}`,
      headers: bearer(bob.body.accessToken!),
    });
    const bobCitizenId = (dash.json() as TownState).yourCitizenId;

    const wsUrl = (token: string) =>
      `ws://127.0.0.1:${port}/ws?townId=${town.id}&token=${encodeURIComponent(token)}`;

    // Alice observe la présence.
    const seen: ServerMessage[] = [];
    const wsAlice = new WebSocket(wsUrl(alice.body.accessToken!));
    wsAlice.on('message', (raw) => seen.push(JSON.parse(String(raw)) as ServerMessage));
    await new Promise<void>((resolve, reject) => {
      wsAlice.on('open', () => resolve());
      wsAlice.on('error', reject);
    });

    // Bob se connecte : Alice doit le voir en ligne.
    const wsBob = new WebSocket(wsUrl(bob.body.accessToken!));
    await new Promise<void>((resolve, reject) => {
      wsBob.on('open', () => resolve());
      wsBob.on('error', reject);
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(
      seen.some(
        (m) => m.type === 'presence.update' && m.present === true && m.citizenId === bobCitizenId,
      ),
    ).toBe(true);

    // Simule une connexion morte : le socket de Bob est mis en pause et ne
    // répondra plus aux pings du serveur (comme un mobile passé en veille).
    wsBob.pause();

    // Après ~2 tours de heartbeat, le serveur purge le fantôme et Alice reçoit
    // la mise à jour de présence hors-ligne.
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('presence hors-ligne jamais reçue')),
        1000,
      );
      const check = () => {
        if (
          seen.some(
            (m) =>
              m.type === 'presence.update' && m.present === false && m.citizenId === bobCitizenId,
          )
        ) {
          clearTimeout(timeout);
          resolve();
        }
      };
      wsAlice.on('message', check);
      check();
    });

    wsAlice.close();
    wsBob.terminate();
    await new Promise((r) => setTimeout(r, 20));
  });

  it('refuse une connexion sans token', async () => {
    const store = new MemoryStore();
    const hub = new RealtimeHub();
    const { app } = await buildApp({
      store,
      hub,
      jwtSecret: TEST_SECRET,
      accessTokenTtlSeconds: 60 * 60,
      secureCookies: false,
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as AddressInfo).port;
    stop = async () => {
      await app.close();
    };

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const messages: unknown[] = [];
    ws.on('message', (raw) => messages.push(JSON.parse(String(raw))));
    await new Promise<void>((resolve) => {
      ws.on('close', () => resolve());
      ws.on('error', () => resolve());
    });
    expect(
      messages.some(
        (m) => typeof m === 'object' && m !== null && (m as { type?: string }).type === 'error',
      ),
    ).toBe(true);
  });
});
