import { describe, expect, it } from 'vitest';
import {
  isClientMessage,
  isServerMessage,
} from '../src/realtime/protocol.js';

describe('isServerMessage', () => {
  it('accepte un message serveur connu', () => {
    expect(
      isServerMessage({ type: 'night.start', day: 3 }),
    ).toBe(true);
  });

  it('refuse un message dont le type est inconnu', () => {
    expect(isServerMessage({ type: 'unknown' })).toBe(false);
  });

  it('refuse une valeur non-objet', () => {
    expect(isServerMessage(null)).toBe(false);
    expect(isServerMessage('night.start')).toBe(false);
    expect(isServerMessage(42)).toBe(false);
  });
});

describe('isClientMessage', () => {
  it('accepte un message client connu', () => {
    expect(isClientMessage({ type: 'auth', token: 'jwt' })).toBe(true);
    expect(isClientMessage({ type: 'chat.send', text: 'salut' })).toBe(true);
    expect(isClientMessage({ type: 'ping' })).toBe(true);
  });

  it('refuse un type serveur côté client', () => {
    expect(isClientMessage({ type: 'night.start', day: 1 })).toBe(false);
  });

  it('refuse un objet sans champ type', () => {
    expect(isClientMessage({ token: 'jwt' })).toBe(false);
  });
});
