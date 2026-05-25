import { describe, expect, it } from 'vitest';
import {
  fingerprintToken,
  generateRefreshToken,
  hashPassword,
  JwtError,
  signJwt,
  verifyJwt,
  verifyPassword,
} from '../src/server/crypto.js';

const SECRET = 'x'.repeat(32);

describe('hashPassword / verifyPassword (Argon2id)', () => {
  it('hashe en Argon2id et le hash vérifie le mot de passe d\'origine', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
  });

  it('rejette un mauvais mot de passe', async () => {
    const hash = await hashPassword('passw0rd!');
    expect(await verifyPassword('mauvais', hash)).toBe(false);
  });

  it('produit deux hashes différents pour le même mot de passe (sels aléatoires)', async () => {
    const h1 = await hashPassword('passw0rd!');
    const h2 = await hashPassword('passw0rd!');
    expect(h1).not.toBe(h2);
  });
});

describe('signJwt / verifyJwt (HS256)', () => {
  it('signe et vérifie un JWT valide', () => {
    const now = Math.floor(Date.now() / 1000);
    const token = signJwt({ sub: 'user-1', iat: now, exp: now + 60 }, SECRET);
    const payload = verifyJwt(token, SECRET);
    expect(payload.sub).toBe('user-1');
  });

  it('rejette un JWT signé avec un autre secret', () => {
    const now = Math.floor(Date.now() / 1000);
    const token = signJwt({ sub: 'user-1', iat: now, exp: now + 60 }, SECRET);
    expect(() => verifyJwt(token, 'y'.repeat(32))).toThrow(JwtError);
  });

  it('rejette un JWT expiré', () => {
    const now = Math.floor(Date.now() / 1000);
    const token = signJwt({ sub: 'user-1', iat: now - 120, exp: now - 60 }, SECRET);
    expect(() => verifyJwt(token, SECRET)).toThrow(/expiré/);
  });

  it('rejette un JWT mal formé', () => {
    expect(() => verifyJwt('not.a.jwt', SECRET)).toThrow(JwtError);
    expect(() => verifyJwt('only.two', SECRET)).toThrow(JwtError);
  });
});

describe('refresh tokens', () => {
  it('génère des tokens opaques uniques', () => {
    const a = generateRefreshToken();
    const b = generateRefreshToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(32);
  });

  it('produit une empreinte SHA-256 stable et déterministe', () => {
    const t = 'a-token';
    expect(fingerprintToken(t)).toBe(fingerprintToken(t));
    expect(fingerprintToken(t)).not.toBe(fingerprintToken('autre'));
  });
});
