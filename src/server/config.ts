/**
 * Lecture et validation des variables d'environnement du serveur Fastify.
 *
 * Aucun fallback "magique" : si une variable obligatoire manque, le serveur
 * refuse de démarrer. Les variables sont lues une seule fois au boot via
 * `loadServerConfig()` et passées par injection partout ailleurs (pas de
 * `process.env` dispersé dans le code).
 */

export interface ServerConfig {
  /** Port HTTP d'écoute du serveur Fastify. */
  readonly port: number;
  /** Interface d'écoute (`0.0.0.0` en conteneur, `127.0.0.1` en local). */
  readonly host: string;
  /** URL PostgreSQL (source de vérité). */
  readonly databaseUrl: string;
  /** URL Redis (sessions, locks, pub/sub). */
  readonly redisUrl: string;
  /** Secret de signature des JWT d'accès (≥ 32 octets). */
  readonly jwtSecret: string;
  /** Environnement d'exécution : `development`, `test`, `production`. */
  readonly env: 'development' | 'test' | 'production';
}

export class ServerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServerConfigError';
  }
}

const REQUIRED_VARS = [
  'DATABASE_URL',
  'REDIS_URL',
  'JWT_SECRET',
] as const;

function requireString(
  env: NodeJS.ProcessEnv,
  key: (typeof REQUIRED_VARS)[number],
): string {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') {
    throw new ServerConfigError(
      `Variable d'environnement manquante : ${key}`,
    );
  }
  return raw;
}

function parsePort(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new ServerConfigError(`PORT invalide : ${raw}`);
  }
  return parsed;
}

function parseEnv(raw: string | undefined): ServerConfig['env'] {
  switch (raw) {
    case undefined:
    case '':
    case 'development':
      return 'development';
    case 'test':
      return 'test';
    case 'production':
      return 'production';
    default:
      throw new ServerConfigError(`NODE_ENV invalide : ${raw}`);
  }
}

/**
 * Construit la configuration serveur à partir de `process.env`.
 * Lève `ServerConfigError` si une variable obligatoire est absente ou invalide.
 */
export function loadServerConfig(
  env: NodeJS.ProcessEnv = process.env,
): ServerConfig {
  const jwtSecret = requireString(env, 'JWT_SECRET');
  if (jwtSecret.length < 32) {
    throw new ServerConfigError(
      'JWT_SECRET doit faire au moins 32 caractères',
    );
  }
  return {
    port: parsePort(env['PORT'], 3000),
    host: env['HOST'] ?? '127.0.0.1',
    databaseUrl: requireString(env, 'DATABASE_URL'),
    redisUrl: requireString(env, 'REDIS_URL'),
    jwtSecret,
    env: parseEnv(env['NODE_ENV']),
  };
}
