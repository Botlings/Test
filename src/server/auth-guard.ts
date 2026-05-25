/**
 * Garde d'authentification commun aux routes protégées.
 *
 * Lit le header `Authorization: Bearer <jwt>`, vérifie le JWT, et renvoie
 * l'identifiant de compte. Si le JWT est absent ou invalide, la fonction
 * écrit une 401 sur `reply` et renvoie `null` ; le handler appelant doit
 * alors `return` immédiatement.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { JwtError, verifyJwt } from './crypto.js';
import type { Id } from '../persistence/types.js';

export interface AuthGuardDeps {
  readonly jwtSecret: string;
}

export function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: AuthGuardDeps,
): Id | null {
  const header = request.headers.authorization;
  if (!header || !header.toLowerCase().startsWith('bearer ')) {
    reply.code(401).send({ error: { code: 'auth-required', message: 'Token d\'accès requis' } });
    return null;
  }
  const token = header.slice('bearer '.length).trim();
  try {
    const payload = verifyJwt(token, deps.jwtSecret);
    return payload.sub as Id;
  } catch (err) {
    const message = err instanceof JwtError ? err.message : 'Token invalide';
    reply.code(401).send({ error: { code: 'auth-invalid', message } });
    return null;
  }
}
