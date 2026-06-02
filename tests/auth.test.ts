import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeTestApp, register, login } from './helpers/app.js';

describe('POST /auth/register', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('crée un compte, renvoie userId + accessToken, pose un cookie refresh httpOnly', async () => {
    const built = await makeTestApp();
    app = built.app;
    const res = await register(built.app, 'alia@hordes.test', 'password!1');
    expect(res.status).toBe(201);
    expect(res.body.userId).toMatch(/[0-9a-f-]{36}/);
    expect(res.body.email).toBe('alia@hordes.test');
    expect(res.body.accessToken).toBeTruthy();
    const refresh = res.cookies.find((c) => c.name === 'hr_refresh');
    expect(refresh).toBeDefined();
    expect(refresh?.value.length).toBeGreaterThan(20);
    // Le hash en DB ne doit pas contenir le mot de passe en clair.
    const account = (await built.store.findAccountByEmail('alia@hordes.test'))!;
    expect(account.passwordHash).not.toContain('password!1');
    expect(account.passwordHash).toMatch(/^\$argon2id\$/);
  });

  it('rejette un email invalide', async () => {
    const built = await makeTestApp();
    app = built.app;
    const res = await register(built.app, 'pas-un-email', 'password!1');
    expect(res.status).toBe(400);
    expect((res.body.error as { code: string }).code).toBe('email-invalid');
  });

  it('rejette un mot de passe < 8 caractères', async () => {
    const built = await makeTestApp();
    app = built.app;
    const res = await register(built.app, 'a@b.com', 'court');
    expect(res.status).toBe(400);
    expect((res.body.error as { code: string }).code).toBe('password-too-short');
  });

  it('renvoie 409 si l\'email est déjà utilisé', async () => {
    const built = await makeTestApp();
    app = built.app;
    await register(built.app, 'dup@hordes.test', 'password!1');
    const res = await register(built.app, 'dup@hordes.test', 'password!1');
    expect(res.status).toBe(409);
    expect((res.body.error as { code: string }).code).toBe('email-taken');
  });
});

describe('POST /auth/login', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('renvoie un accessToken pour des identifiants valides', async () => {
    const built = await makeTestApp();
    app = built.app;
    await register(built.app, 'alia@hordes.test', 'password!1');
    const res = await login(built.app, 'alia@hordes.test', 'password!1');
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
  });

  it('renvoie 401 sur identifiants invalides (mauvais mot de passe)', async () => {
    const built = await makeTestApp();
    app = built.app;
    await register(built.app, 'alia@hordes.test', 'password!1');
    const res = await login(built.app, 'alia@hordes.test', 'wrong-pwd');
    expect(res.status).toBe(401);
    expect((res.body.error as { code: string }).code).toBe('invalid-credentials');
  });

  it('renvoie 401 sur un compte inexistant', async () => {
    const built = await makeTestApp();
    app = built.app;
    const res = await login(built.app, 'inconnu@hordes.test', 'password!1');
    expect(res.status).toBe(401);
  });
});

describe('POST /auth/refresh', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('rotation du refresh token : émet un nouvel accessToken et invalide l\'ancien refresh', async () => {
    const built = await makeTestApp();
    app = built.app;
    const reg = await register(built.app, 'alia@hordes.test', 'password!1');
    const refresh = reg.cookies.find((c) => c.name === 'hr_refresh')!;
    const ok = await built.app.inject({
      method: 'POST',
      url: '/auth/refresh',
      cookies: { hr_refresh: refresh.value },
    });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as { accessToken?: string }).accessToken).toBeTruthy();
    // Replay du même refresh token → 401 (consommé une seule fois).
    const replay = await built.app.inject({
      method: 'POST',
      url: '/auth/refresh',
      cookies: { hr_refresh: refresh.value },
    });
    expect(replay.statusCode).toBe(401);
  });

  it('renvoie 401 sans cookie', async () => {
    const built = await makeTestApp();
    app = built.app;
    const res = await built.app.inject({ method: 'POST', url: '/auth/refresh' });
    expect(res.statusCode).toBe(401);
  });
});
