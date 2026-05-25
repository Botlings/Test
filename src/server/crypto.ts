/**
 * Primitives cryptographiques du serveur Hordes Revival.
 *
 * - Hash de mots de passe : Argon2id (hash-wasm, paramètres OWASP 2024).
 * - JWT d'accès : HMAC-SHA256 sur (header.payload), signature en base64url.
 * - Refresh tokens : 32 octets aléatoires, stockés hachés (SHA-256) en DB.
 *
 * Aucune dépendance vers le serveur HTTP : ces helpers sont purs et testables
 * en isolation.
 */
import { argon2id, argon2Verify } from 'hash-wasm';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Paramètres OWASP 2024 pour Argon2id côté serveur. */
const ARGON2_PARAMS = {
  parallelism: 1,
  iterations: 3,
  memorySize: 65536, // 64 MiB
  hashLength: 32,
} as const;

/**
 * Hashe un mot de passe en clair avec Argon2id.
 * Le sel est généré aléatoirement et inclus dans la chaîne encodée
 * (`$argon2id$v=19$m=...$...$...`) — le hash résultant peut être stocké tel
 * quel et passé à `verifyPassword` plus tard.
 */
export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(16);
  return argon2id({
    password: plain,
    salt,
    ...ARGON2_PARAMS,
    outputType: 'encoded',
  });
}

/** Vérifie un mot de passe contre un hash Argon2id encodé. */
export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  try {
    return await argon2Verify({ password: plain, hash });
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/*  JWT HS256                                                                 */
/* -------------------------------------------------------------------------- */

export interface JwtPayload {
  /** Sujet : identifiant de compte. */
  readonly sub: string;
  /** Émission (epoch seconds). */
  readonly iat: number;
  /** Expiration (epoch seconds). */
  readonly exp: number;
}

export class JwtError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JwtError';
  }
}

function base64urlEncode(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf
    .toString('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function base64urlDecode(input: string): Buffer {
  const padded = input + '='.repeat((4 - (input.length % 4)) % 4);
  return Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/** Signe un JWT HS256 sur un payload donné. */
export function signJwt(payload: JwtPayload, secret: string): string {
  const header = base64urlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64urlEncode(JSON.stringify(payload));
  const signingInput = `${header}.${body}`;
  const sig = base64urlEncode(createHmac('sha256', secret).update(signingInput).digest());
  return `${signingInput}.${sig}`;
}

/** Vérifie + décode un JWT. Lève `JwtError` si invalide ou expiré. */
export function verifyJwt(token: string, secret: string, now: number = Date.now()): JwtPayload {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new JwtError('JWT mal formé');
  }
  const [header, body, sig] = parts as [string, string, string];
  const expected = createHmac('sha256', secret).update(`${header}.${body}`).digest();
  const provided = base64urlDecode(sig);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw new JwtError('Signature JWT invalide');
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(base64urlDecode(body).toString('utf8'));
  } catch {
    throw new JwtError('Payload JWT illisible');
  }
  if (
    typeof decoded !== 'object' ||
    decoded === null ||
    typeof (decoded as Record<string, unknown>).sub !== 'string' ||
    typeof (decoded as Record<string, unknown>).iat !== 'number' ||
    typeof (decoded as Record<string, unknown>).exp !== 'number'
  ) {
    throw new JwtError('Payload JWT incomplet');
  }
  const payload = decoded as JwtPayload;
  const nowSeconds = Math.floor(now / 1000);
  if (payload.exp <= nowSeconds) {
    throw new JwtError('JWT expiré');
  }
  return payload;
}

/* -------------------------------------------------------------------------- */
/*  Refresh tokens opaques                                                    */
/* -------------------------------------------------------------------------- */

/** Génère un refresh token opaque (32 octets, base64url). */
export function generateRefreshToken(): string {
  return base64urlEncode(randomBytes(32));
}

/** Empreinte SHA-256 d'un refresh token, à stocker côté base. */
export function fingerprintToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
