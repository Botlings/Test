/**
 * Bus d'événements temps-réel par ville.
 *
 * Le `RealtimeHub` est un EventEmitter in-process : les routes HTTP poussent
 * un `ServerMessage` après chaque mutation, le serveur WS (`server/app.ts`)
 * souscrit et relaie aux clients connectés à une ville donnée.
 *
 * Pas d'I/O ici — la diffusion réseau est gérée par la couche WebSocket.
 */
import { EventEmitter } from 'node:events';
import type { ServerMessage } from './protocol.js';

export class RealtimeHub {
  private readonly emitter = new EventEmitter();

  /** Souscrit aux messages d'une ville. Renvoie un désabonneur. */
  subscribe(townId: string, listener: (msg: ServerMessage) => void): () => void {
    this.emitter.on(townId, listener);
    return () => this.emitter.off(townId, listener);
  }

  /** Diffuse un message à tous les abonnés d'une ville. */
  publish(townId: string, message: ServerMessage): void {
    this.emitter.emit(townId, message);
  }
}
