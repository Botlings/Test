/**
 * Helper de tests : construit une app Fastify isolée avec store + hub en
 * mémoire, expose des raccourcis pour register / login / parser un cookie
 * Set-Cookie de refresh token.
 */
import { buildApp } from '../../src/server/app.js';
import { MemoryStore } from '../../src/persistence/memory.js';
import { RealtimeHub } from '../../src/realtime/hub.js';

export const TEST_SECRET = 't'.repeat(32);

export async function makeTestApp() {
  const store = new MemoryStore();
  const hub = new RealtimeHub();
  const { app } = await buildApp({
    store,
    hub,
    jwtSecret: TEST_SECRET,
    accessTokenTtlSeconds: 60 * 60,
    secureCookies: false,
  });
  await app.ready();
  return { app, store, hub };
}

/** Inscrit un utilisateur et renvoie son access token + cookie. */
export async function register(
  app: Awaited<ReturnType<typeof makeTestApp>>['app'],
  email: string,
  password: string,
) {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: { email, password },
  });
  return {
    status: res.statusCode,
    body: res.json() as { userId?: string; email?: string; accessToken?: string; error?: unknown },
    cookies: res.cookies as Array<{ name: string; value: string; path?: string }>,
  };
}

export async function login(
  app: Awaited<ReturnType<typeof makeTestApp>>['app'],
  email: string,
  password: string,
) {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password },
  });
  return {
    status: res.statusCode,
    body: res.json() as { userId?: string; email?: string; accessToken?: string; error?: unknown },
    cookies: res.cookies as Array<{ name: string; value: string; path?: string }>,
  };
}

export function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}
