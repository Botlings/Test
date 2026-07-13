/**
 * Routes d'authentification : inscription, connexion, rafraîchissement, déconnexion.
 *
 * Tous les endpoints renvoient le même contrat d'erreur métier :
 *   { error: { code: string, message: string } }
 * Codes HTTP : 400 pour validation, 401 pour identifiants invalides, 409 pour
 * email déjà utilisé, 500 pour erreur serveur.
 */
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth-guard.js';
import type { Store } from '../../persistence/store.js';
import type { Id } from '../../persistence/types.js';
import { buildAchievements as buildProfileAchievements } from '../profile.js';
import {
  fingerprintToken,
  generateRefreshToken,
  hashPassword,
  signJwt,
  verifyPassword,
} from '../crypto.js';

interface AuthDeps {
  readonly store: Store;
  readonly jwtSecret: string;
  readonly accessTokenTtlSeconds: number;
  readonly secureCookies: boolean;
}

/** Validation minimale de format email (RFC 5322 simplifié). */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LEN = 8;
const REFRESH_COOKIE = 'hr_refresh';

function badRequest(code: string, message: string) {
  return { status: 400 as const, body: { error: { code, message } } };
}

function emitAccessToken(accountId: Id, jwtSecret: string, ttlSeconds: number): string {
  const now = Math.floor(Date.now() / 1000);
  return signJwt({ sub: accountId, iat: now, exp: now + ttlSeconds }, jwtSecret);
}

export function registerAuthRoutes(app: FastifyInstance, deps: AuthDeps): void {
  const { store, jwtSecret, accessTokenTtlSeconds, secureCookies } = deps;

  const issueSession = async (
    accountId: Id,
  ): Promise<{ accessToken: string; refreshToken: string }> => {
    const accessToken = emitAccessToken(accountId, jwtSecret, accessTokenTtlSeconds);
    const refreshToken = generateRefreshToken();
    await store.createSession(fingerprintToken(refreshToken), accountId);
    return { accessToken, refreshToken };
  };

  const setRefreshCookie = (reply: import('fastify').FastifyReply, refreshToken: string): void => {
    reply.setCookie(REFRESH_COOKIE, refreshToken, {
      httpOnly: true,
      sameSite: 'lax',
      secure: secureCookies,
      path: '/auth',
      maxAge: 30 * 24 * 60 * 60,
    });
  };

  /* --------------------------- /auth/register ----------------------------- */
  app.post('/auth/register', async (request, reply) => {
    const body = request.body as { email?: unknown; password?: unknown } | undefined;
    const email = typeof body?.email === 'string' ? body.email.trim() : '';
    const password = typeof body?.password === 'string' ? body.password : '';

    if (!EMAIL_RE.test(email)) {
      const err = badRequest('email-invalid', 'Adresse email invalide');
      return reply.code(err.status).send(err.body);
    }
    if (password.length < MIN_PASSWORD_LEN) {
      const err = badRequest(
        'password-too-short',
        `Le mot de passe doit contenir au moins ${MIN_PASSWORD_LEN} caractères`,
      );
      return reply.code(err.status).send(err.body);
    }
    if (await store.findAccountByEmail(email)) {
      return reply.code(409).send({
        error: { code: 'email-taken', message: 'Cet email est déjà utilisé' },
      });
    }

    const passwordHash = await hashPassword(password);
    const account = await store.createAccount(email, passwordHash);
    const { accessToken, refreshToken } = await issueSession(account.id);
    setRefreshCookie(reply, refreshToken);
    return reply.code(201).send({
      userId: account.id,
      email: account.email,
      accessToken,
      expiresIn: accessTokenTtlSeconds,
    });
  });

  /* ---------------------------- /auth/login ------------------------------- */
  app.post('/auth/login', async (request, reply) => {
    const body = request.body as { email?: unknown; password?: unknown } | undefined;
    const email = typeof body?.email === 'string' ? body.email.trim() : '';
    const password = typeof body?.password === 'string' ? body.password : '';
    if (!email || !password) {
      const err = badRequest('credentials-required', 'Email et mot de passe requis');
      return reply.code(err.status).send(err.body);
    }

    const account = await store.findAccountByEmail(email);
    if (!account) {
      return reply.code(401).send({
        error: { code: 'invalid-credentials', message: 'Identifiants invalides' },
      });
    }
    const ok = await verifyPassword(password, account.passwordHash);
    if (!ok) {
      return reply.code(401).send({
        error: { code: 'invalid-credentials', message: 'Identifiants invalides' },
      });
    }
    const { accessToken, refreshToken } = await issueSession(account.id);
    setRefreshCookie(reply, refreshToken);
    return reply.code(200).send({
      userId: account.id,
      email: account.email,
      accessToken,
      expiresIn: accessTokenTtlSeconds,
    });
  });

  /* --------------------------- /auth/refresh ------------------------------ */
  app.post('/auth/refresh', async (request, reply) => {
    const cookies = (request.cookies ?? {}) as Record<string, string | undefined>;
    const refreshToken = cookies[REFRESH_COOKIE];
    if (!refreshToken) {
      return reply.code(401).send({
        error: { code: 'no-refresh-token', message: 'Aucun refresh token' },
      });
    }
    const session = await store.consumeSession(fingerprintToken(refreshToken));
    if (!session) {
      return reply.code(401).send({
        error: { code: 'invalid-refresh-token', message: 'Refresh token invalide ou expiré' },
      });
    }
    const { accessToken, refreshToken: rotated } = await issueSession(session.accountId);
    setRefreshCookie(reply, rotated);
    return reply.code(200).send({ accessToken, expiresIn: accessTokenTtlSeconds });
  });

  /* --------------------------- /auth/logout ------------------------------- */
  app.post('/auth/logout', async (request, reply) => {
    const cookies = (request.cookies ?? {}) as Record<string, string | undefined>;
    const refreshToken = cookies[REFRESH_COOKIE];
    if (refreshToken) {
      await store.revokeSession(fingerprintToken(refreshToken));
    }
    reply.clearCookie(REFRESH_COOKIE, { path: '/auth' });
    return reply.code(204).send();
  });

  /* ----------------------------- /auth/me --------------------------------- */
  /**
   * Renvoie le profil du compte authentifié : identité + statistiques agrégées
   * sur l'ensemble des villes auxquelles il a participé.
   */
  app.get('/auth/me', async (request, reply) => {
    const accountId = requireAuth(request, reply, { jwtSecret });
    if (!accountId) return;
    const account = await store.getAccount(accountId);
    if (!account) {
      return reply.code(401).send({
        error: { code: 'account-not-found', message: 'Compte introuvable' },
      });
    }
    const history = await store.listAccountTowns(accountId);
    const aliveGames = history.filter((h) => h.citizen.alive).length;
    const totalGames = history.length;
    const victories = history.filter((h) => h.outcome === 'victory').length;
    const bestDay = history.reduce((acc, h) => Math.max(acc, h.currentDay), 0);
    const achievements = await buildProfileAchievements(store, accountId);
    return reply.code(200).send({
      userId: account.id,
      email: account.email,
      createdAt: account.createdAt.toISOString(),
      stats: {
        totalGames,
        aliveGames,
        deathsCount: totalGames - aliveGames,
        bestDay,
      },
      victories,
      achievements,
      achievementCount: achievements.filter((a) => a.unlocked).length,
    });
  });

  /* ----------------------- /auth/me/achievements -------------------------- */
  /**
   * Catalogue complet des hauts faits, enrichi de l'état de déblocage du
   * compte authentifié (badge obtenu ou non, date). Alimente l'onglet
   * « Hauts faits » du profil.
   */
  app.get('/auth/me/achievements', async (request, reply) => {
    const accountId = requireAuth(request, reply, { jwtSecret });
    if (!accountId) return;
    const achievements = await buildProfileAchievements(store, accountId);
    return reply.code(200).send({
      achievements,
      unlockedCount: achievements.filter((a) => a.unlocked).length,
      total: achievements.length,
    });
  });

  /* ------------------------- /auth/me/history ----------------------------- */
  /**
   * Liste détaillée des villes jouées par le compte, des plus récentes aux
   * plus anciennes. Chaque entrée décrit le devenir du citoyen et l'état
   * de la partie au moment de la requête.
   */
  app.get('/auth/me/history', async (request, reply) => {
    const accountId = requireAuth(request, reply, { jwtSecret });
    if (!accountId) return;
    const history = await store.listAccountTowns(accountId);
    return reply.code(200).send({
      history: history.map((h) => ({
        townId: h.townId,
        townName: h.townName,
        difficulty: h.difficulty,
        joinedAt: h.joinedAt.toISOString(),
        currentDay: h.currentDay,
        phase: h.phase,
        outcome: h.outcome,
        gameOver: h.gameOver,
        closed: h.closed,
        citizen: h.citizen,
      })),
    });
  });
}
