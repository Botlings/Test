/**
 * Sondes de santé exposées au load-balancer (Render), au HEALTHCHECK Docker,
 * à UptimeRobot et à la page de statut publique. On verrouille :
 *   - les codes HTTP (200 quand sain, 503 quand le store est injoignable) ;
 *   - la forme du JSON (mots-clés cherchés par les monitors) ;
 *   - les en-têtes CORS, car la page de statut statique lit ces sondes en
 *     cross-origin (GitHub Pages → API).
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/server/app.js';
import { MemoryStore } from '../src/persistence/memory.js';
import { RealtimeHub } from '../src/realtime/hub.js';
import { TEST_SECRET, makeTestApp } from './helpers/app.js';

describe('Sondes de santé', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('GET /health/live renvoie 200, status ok et un uptime numérique', async () => {
    const built = await makeTestApp();
    app = built.app;
    const res = await app.inject({ method: 'GET', url: '/health/live' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string; uptimeMs: number };
    expect(body.status).toBe('ok');
    expect(typeof body.uptimeMs).toBe('number');
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });

  it('GET /health/ready renvoie 200 + store:ready quand la BDD répond', async () => {
    const built = await makeTestApp();
    app = built.app;
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string; store: string };
    expect(body.status).toBe('ok');
    expect(body.store).toBe('ready');
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });

  it('GET /health (alias) renvoie 200 + CORS', async () => {
    const built = await makeTestApp();
    app = built.app;
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { status: string }).status).toBe('ok');
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });

  it('GET /health/ready renvoie 503 + store:unreachable si le store échoue', async () => {
    const store = new MemoryStore();
    // Simule une BDD injoignable : ping() rejette.
    store.ping = async () => {
      throw new Error('connection refused');
    };
    const built = await buildApp({
      store,
      hub: new RealtimeHub(),
      jwtSecret: TEST_SECRET,
      accessTokenTtlSeconds: 3600,
      secureCookies: false,
    });
    app = built.app;
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(503);
    const body = res.json() as { status: string; store: string; error: string };
    expect(body.status).toBe('unavailable');
    expect(body.store).toBe('unreachable');
    expect(body.error).toContain('connection refused');
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });
});
