import { describe, expect, it } from 'vitest';
import {
  loadServerConfig,
  ServerConfigError,
} from '../src/server/config.js';

const VALID_SECRET = 'x'.repeat(32);

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: 'postgres://localhost/hordes',
    REDIS_URL: 'redis://localhost:6379',
    JWT_SECRET: VALID_SECRET,
    ...overrides,
  } as NodeJS.ProcessEnv;
}

describe('loadServerConfig', () => {
  it('charge une configuration valide avec les valeurs par défaut', () => {
    const cfg = loadServerConfig(env());
    expect(cfg.port).toBe(3000);
    expect(cfg.host).toBe('127.0.0.1');
    expect(cfg.env).toBe('development');
    expect(cfg.databaseUrl).toBe('postgres://localhost/hordes');
    expect(cfg.redisUrl).toBe('redis://localhost:6379');
    expect(cfg.jwtSecret).toBe(VALID_SECRET);
  });

  it('lit PORT, HOST et NODE_ENV depuis l\'environnement', () => {
    const cfg = loadServerConfig(
      env({ PORT: '8080', HOST: '0.0.0.0', NODE_ENV: 'production' }),
    );
    expect(cfg.port).toBe(8080);
    expect(cfg.host).toBe('0.0.0.0');
    expect(cfg.env).toBe('production');
  });

  it('rejette un PORT non numérique', () => {
    expect(() => loadServerConfig(env({ PORT: 'abc' }))).toThrow(
      ServerConfigError,
    );
  });

  it('rejette un PORT hors plage', () => {
    expect(() => loadServerConfig(env({ PORT: '70000' }))).toThrow(
      ServerConfigError,
    );
  });

  it('rejette un NODE_ENV inconnu', () => {
    expect(() => loadServerConfig(env({ NODE_ENV: 'staging' }))).toThrow(
      ServerConfigError,
    );
  });

  it('exige DATABASE_URL', () => {
    expect(() =>
      loadServerConfig(env({ DATABASE_URL: undefined })),
    ).toThrow(/DATABASE_URL/);
  });

  it('exige REDIS_URL', () => {
    expect(() =>
      loadServerConfig(env({ REDIS_URL: undefined })),
    ).toThrow(/REDIS_URL/);
  });

  it('rejette un JWT_SECRET trop court', () => {
    expect(() =>
      loadServerConfig(env({ JWT_SECRET: 'court' })),
    ).toThrow(/JWT_SECRET/);
  });
});
