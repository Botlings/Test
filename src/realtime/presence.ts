/**
 * Registre de présence temps réel par ville.
 *
 * Suit, en mémoire process, quels comptes ont au moins une connexion WebSocket
 * ouverte sur une ville donnée. Un même compte peut ouvrir plusieurs onglets :
 * on compte les connexions et on ne considère le compte « parti » que lorsque
 * son compteur retombe à zéro (transitions present=true/false uniques).
 *
 * Aucune I/O : la présence est éphémère par nature et n'a pas vocation à être
 * persistée. Pour un déploiement multi-process, viser un seul process actif
 * par ville (sticky routing) — même hypothèse que le cache des `Game`.
 */
import type { Id } from '../persistence/types.js';

export interface PresenceTransition {
  /** Nombre de connexions de ce compte sur la ville APRÈS l'opération. */
  readonly connections: number;
  /**
   * `true` si l'opération a fait basculer le compte d'absent à présent
   * (premier onglet) ou de présent à absent (dernier onglet fermé). Sert à
   * n'émettre une `presence.update` que sur les transitions réelles.
   */
  readonly changed: boolean;
  /** Nombre de comptes distincts présents sur la ville après l'opération. */
  readonly onlineCount: number;
}

export class PresenceRegistry {
  /** townId → (accountId → nombre de connexions ouvertes). */
  private readonly byTown = new Map<Id, Map<Id, number>>();

  /** Enregistre une nouvelle connexion d'un compte sur une ville. */
  connect(townId: Id, accountId: Id): PresenceTransition {
    let accounts = this.byTown.get(townId);
    if (!accounts) {
      accounts = new Map();
      this.byTown.set(townId, accounts);
    }
    const previous = accounts.get(accountId) ?? 0;
    const connections = previous + 1;
    accounts.set(accountId, connections);
    return {
      connections,
      changed: previous === 0,
      onlineCount: accounts.size,
    };
  }

  /** Retire une connexion d'un compte. Nettoie les entrées vides. */
  disconnect(townId: Id, accountId: Id): PresenceTransition {
    const accounts = this.byTown.get(townId);
    if (!accounts) {
      return { connections: 0, changed: false, onlineCount: 0 };
    }
    const previous = accounts.get(accountId) ?? 0;
    if (previous <= 1) {
      accounts.delete(accountId);
      if (accounts.size === 0) this.byTown.delete(townId);
      return {
        connections: 0,
        changed: previous === 1,
        onlineCount: accounts.size,
      };
    }
    const connections = previous - 1;
    accounts.set(accountId, connections);
    return { connections, changed: false, onlineCount: accounts.size };
  }

  /** Liste des comptes actuellement présents sur une ville. */
  online(townId: Id): Id[] {
    const accounts = this.byTown.get(townId);
    return accounts ? [...accounts.keys()] : [];
  }

  /** Nombre de comptes distincts présents sur une ville. */
  onlineCount(townId: Id): number {
    return this.byTown.get(townId)?.size ?? 0;
  }

  /** `true` si le compte a au moins une connexion ouverte sur la ville. */
  isOnline(townId: Id, accountId: Id): boolean {
    return (this.byTown.get(townId)?.get(accountId) ?? 0) > 0;
  }
}
