/**
 * Protocole WebSocket entre le serveur de partie et les clients.
 *
 * Tout message échangé sur `/ws` est un objet JSON respectant
 * `ClientMessage` (montant) ou `ServerMessage` (descendant). Les types
 * sont volontairement discriminés sur `type` pour permettre un
 * `switch` exhaustif côté serveur **et** côté client.
 *
 * Ce fichier ne contient AUCUNE logique d'exécution : il est partagé tel
 * quel par les deux côtés et doit rester sans dépendances.
 */

import type { Location, NightReport } from '../domain/index.js';

/* -------------------------------------------------------------------------- */
/*  Messages serveur → client                                                 */
/* -------------------------------------------------------------------------- */

/** Snapshot complet de l'état d'une ville (envoyé à la connexion). */
export interface TownSnapshotMessage {
  readonly type: 'town.snapshot';
  readonly day: number;
  readonly phase: 'day' | 'night';
  readonly resources: Readonly<Record<string, number>>;
  readonly citizens: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly location: Location;
    readonly alive: boolean;
  }>;
}

/** Un citoyen vient de changer de case. */
export interface CitizenMovedMessage {
  readonly type: 'citizen.moved';
  readonly citizenId: string;
  readonly to: Location;
}

/** Un chantier vient d'être complété. */
export interface BuildCompletedMessage {
  readonly type: 'build.completed';
  readonly structureId: string;
  readonly defense: number;
}

/** La nuit commence — plus aucune action n'est possible. */
export interface NightStartMessage {
  readonly type: 'night.start';
  readonly day: number;
}

/**
 * Annonce l'horaire prévu de la prochaine résolution automatique. Permet au
 * client d'afficher un compte à rebours avant que la horde ne frappe.
 */
export interface NightScheduledMessage {
  readonly type: 'night.scheduled';
  readonly day: number;
  readonly scheduledFor: string;
}

/** La nuit est résolue : compte rendu envoyé à tous les joueurs. */
export interface NightReportMessage {
  readonly type: 'night.report';
  readonly day: number;
  readonly trigger: 'manual' | 'scheduler';
  readonly report: NightReport;
}

/** Message de chat émis par un joueur. */
export interface ChatBroadcastMessage {
  readonly type: 'chat.message';
  readonly from: string;
  readonly text: string;
  readonly at: string;
}

/** Erreur applicative renvoyée suite à une action invalide. */
export interface ServerErrorMessage {
  readonly type: 'error';
  readonly code: string;
  readonly message: string;
}

export type ServerMessage =
  | TownSnapshotMessage
  | CitizenMovedMessage
  | BuildCompletedMessage
  | NightStartMessage
  | NightScheduledMessage
  | NightReportMessage
  | ChatBroadcastMessage
  | ServerErrorMessage;

/* -------------------------------------------------------------------------- */
/*  Messages client → serveur                                                 */
/* -------------------------------------------------------------------------- */

/** Authentifie la connexion WS avec le JWT d'accès. */
export interface AuthMessage {
  readonly type: 'auth';
  readonly token: string;
}

/** Envoi d'un message de chat dans le canal de la ville. */
export interface ChatSendMessage {
  readonly type: 'chat.send';
  readonly text: string;
}

/** Heartbeat applicatif (en complément du ping WS protocolaire). */
export interface PingMessage {
  readonly type: 'ping';
}

export type ClientMessage = AuthMessage | ChatSendMessage | PingMessage;

/* -------------------------------------------------------------------------- */
/*  Helpers de garde                                                          */
/* -------------------------------------------------------------------------- */

const SERVER_TYPES = new Set<ServerMessage['type']>([
  'town.snapshot',
  'citizen.moved',
  'build.completed',
  'night.start',
  'night.scheduled',
  'night.report',
  'chat.message',
  'error',
]);

const CLIENT_TYPES = new Set<ClientMessage['type']>([
  'auth',
  'chat.send',
  'ping',
]);

export function isServerMessage(value: unknown): value is ServerMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    typeof (value as { type: unknown }).type === 'string' &&
    SERVER_TYPES.has((value as { type: ServerMessage['type'] }).type)
  );
}

export function isClientMessage(value: unknown): value is ClientMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    typeof (value as { type: unknown }).type === 'string' &&
    CLIENT_TYPES.has((value as { type: ClientMessage['type'] }).type)
  );
}
