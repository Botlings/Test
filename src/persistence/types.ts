/**
 * Types des entités persistées (Postgres). Le schéma Drizzle réel sera
 * introduit en même temps que la dépendance `drizzle-orm`. En attendant,
 * ces interfaces fixent la forme des données et servent de contrat aux
 * couches `server/` et `realtime/`.
 */

import type { Location } from '../domain/index.js';

/** Identifiant opaque (UUID v4) côté domaine. */
export type Id = string & { readonly __brand: 'Id' };

export interface AccountRow {
  readonly id: Id;
  readonly email: string;
  readonly passwordHash: string;
  readonly createdAt: Date;
}

export interface TownRow {
  readonly id: Id;
  readonly name: string;
  readonly day: number;
  readonly phase: 'day' | 'night';
  readonly createdAt: Date;
  readonly endedAt: Date | null;
}

export interface CitizenRow {
  readonly id: Id;
  readonly townId: Id;
  readonly accountId: Id | null;
  readonly name: string;
  readonly location: Location;
  readonly alive: boolean;
  readonly thirstDays: number;
}

export interface NightEventRow {
  readonly id: Id;
  readonly townId: Id;
  readonly day: number;
  readonly attackers: number;
  readonly defense: number;
  readonly breached: boolean;
  readonly deaths: number;
  readonly createdAt: Date;
}
