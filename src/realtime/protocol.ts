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

import type { GameOutcome, Location, NightReport } from '../domain/index.js';
import type {
  ActivityEntry,
  ForumMessageRecord,
  ForumThreadSummary,
  ForumVoteTally,
} from '../persistence/store.js';

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

/** Un citoyen vient d'arriver dans une zone du désert (avec ou sans découverte). */
export interface CitizenExploringMessage {
  readonly type: 'citizen.exploring';
  readonly citizenId: string;
  readonly x: number;
  readonly y: number;
  readonly discovered: boolean;
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

/**
 * La partie est terminée : victoire (la ville a tenu le nombre de nuits
 * requis) ou défaite (la ville est tombée). Émis juste après la résolution
 * de la nuit décisive, en complément du `night.report`.
 */
export interface GameOverMessage {
  readonly type: 'game.over';
  readonly outcome: Exclude<GameOutcome, 'ongoing'>;
  /** Nuit décisive (numéro de jour). */
  readonly day: number;
  /** Nuits effectivement survécues par la ville. */
  readonly daysSurvived: number;
  /** Citoyens encore en vie à la fin. */
  readonly survivors: number;
}

/** Message de chat émis par un joueur. */
export interface ChatBroadcastMessage {
  readonly type: 'chat.message';
  readonly from: string;
  readonly text: string;
  readonly at: string;
}

/** Un sujet du forum vient d'être créé. */
export interface ForumThreadCreatedMessage {
  readonly type: 'forum.thread.created';
  readonly thread: ForumThreadSummary;
}

/** Un sujet du forum vient d'être clos (manuellement ou à échéance). */
export interface ForumThreadClosedMessage {
  readonly type: 'forum.thread.closed';
  readonly threadId: string;
}

/** Un nouveau message a été posté dans un sujet. */
export interface ForumMessagePostedMessage {
  readonly type: 'forum.message.posted';
  readonly threadId: string;
  readonly message: ForumMessageRecord;
}

/** Un vote a été (re)posé : nouveau tally. */
export interface ForumVoteCastMessage {
  readonly type: 'forum.vote.cast';
  readonly threadId: string;
  readonly tally: ForumVoteTally;
}

/** Une nouvelle entrée d'activité a été enregistrée. */
export interface ActivityRecordedMessage {
  readonly type: 'activity.recorded';
  readonly entry: ActivityEntry;
}

/** Un membre présent dans la liste de présence temps réel. */
export interface PresenceMember {
  readonly accountId: string;
  /** Citoyen contrôlé par ce compte dans la ville (null si non encore résolu). */
  readonly citizenId: string | null;
}

/**
 * Instantané de présence envoyé à la connexion : qui est connecté en ce
 * moment dans la ville. Complète le `town.snapshot` (qui liste tous les
 * citoyens, présents ou non).
 */
export interface PresenceSnapshotMessage {
  readonly type: 'presence.snapshot';
  readonly online: ReadonlyArray<PresenceMember>;
  readonly onlineCount: number;
}

/** Un habitant vient de se connecter ou de se déconnecter. */
export interface PresenceUpdateMessage {
  readonly type: 'presence.update';
  readonly accountId: string;
  readonly citizenId: string | null;
  readonly present: boolean;
  readonly onlineCount: number;
}

/** Le régime d'accès à la banque commune a changé. */
export interface BankPolicyMessage {
  readonly type: 'bank.policy';
  readonly policy: 'open' | 'restricted';
  /** Nom du citoyen qui a changé le régime. */
  readonly by: string;
}

/**
 * La gouvernance de la ville a changé (élection ouverte/close, nouveau maire,
 * couvre-feu, motion d'exil ouverte/résolue). Signal léger et non
 * personnalisé : le client rafraîchit sa vue via `GET /towns/:id/governance`
 * (qui inclut ses propres votes). `reason` sert au feedback (toast/journal).
 */
export interface GovernanceUpdatedMessage {
  readonly type: 'governance.updated';
  readonly reason:
    | 'election.opened'
    | 'mayor.elected'
    | 'curfew'
    | 'exile.opened'
    | 'exile.passed'
    | 'exile.rejected'
    | 'vote';
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
  | CitizenExploringMessage
  | BuildCompletedMessage
  | NightStartMessage
  | NightScheduledMessage
  | NightReportMessage
  | GameOverMessage
  | ChatBroadcastMessage
  | ForumThreadCreatedMessage
  | ForumThreadClosedMessage
  | ForumMessagePostedMessage
  | ForumVoteCastMessage
  | ActivityRecordedMessage
  | PresenceSnapshotMessage
  | PresenceUpdateMessage
  | BankPolicyMessage
  | GovernanceUpdatedMessage
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
  'citizen.exploring',
  'build.completed',
  'night.start',
  'night.scheduled',
  'night.report',
  'game.over',
  'chat.message',
  'forum.thread.created',
  'forum.thread.closed',
  'forum.message.posted',
  'forum.vote.cast',
  'activity.recorded',
  'presence.snapshot',
  'presence.update',
  'bank.policy',
  'governance.updated',
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
