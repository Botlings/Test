import { DEFAULT_CONFIG, type GameConfig } from './config.js';
import type {
  Citizen,
  Death,
  GameStatus,
  Location,
  NightReport,
  Phase,
  ResourceBank,
} from './types.js';

/** Erreur levée lorsqu'une action de jeu est invalide dans l'état courant. */
export class GameRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GameRuleError';
  }
}

/**
 * Snapshot sérialisable de l'état complet d'une partie. Utilisé par la
 * couche persistence (Postgres) pour sauvegarder / restaurer un `Game`
 * sans dépendre de la représentation interne (champs privés) du moteur.
 */
export interface GameSnapshot {
  readonly day: number;
  readonly phase: Phase;
  readonly townDefense: number;
  readonly bank: ResourceBank;
  readonly citizens: ReadonlyArray<Citizen>;
  readonly gameOver: boolean;
  readonly nextCitizenSeq: number;
}

/**
 * Moteur de jeu déterministe d'une partie de Hordes Revival.
 *
 * Une partie commence au jour 1, en phase `day`. Les citoyens fouillent le
 * désert et construisent les défenses, puis `endDay()` résout l'assaut
 * nocturne de la horde et fait passer la ville à l'aube suivante.
 */
export class Game {
  private readonly config: GameConfig;
  private _day = 1;
  private _phase: Phase = 'day';
  private _townDefense: number;
  private readonly _bank: ResourceBank;
  private readonly _citizens: Citizen[] = [];
  private _gameOver = false;
  private nextCitizenSeq = 1;

  constructor(config: GameConfig = DEFAULT_CONFIG) {
    this.config = config;
    this._townDefense = config.baseDefense;
    this._bank = { ...config.startingBank };
  }

  /** Reconstruit un moteur à partir d'un snapshot persisté. */
  static fromSnapshot(config: GameConfig, snapshot: GameSnapshot): Game {
    const game = new Game(config);
    game._day = snapshot.day;
    game._phase = snapshot.phase;
    game._townDefense = snapshot.townDefense;
    game._bank.wood = snapshot.bank.wood;
    game._bank.metal = snapshot.bank.metal;
    game._bank.water = snapshot.bank.water;
    game._gameOver = snapshot.gameOver;
    game.nextCitizenSeq = snapshot.nextCitizenSeq;
    for (const c of snapshot.citizens) {
      game._citizens.push({ ...c });
    }
    return game;
  }

  /** Exporte un snapshot sérialisable de l'état courant. */
  snapshot(): GameSnapshot {
    return {
      day: this._day,
      phase: this._phase,
      townDefense: this._townDefense,
      bank: { ...this._bank },
      citizens: this._citizens.map((c) => ({ ...c })),
      gameOver: this._gameOver,
      nextCitizenSeq: this.nextCitizenSeq,
    };
  }

  /** Ajoute un citoyen à la ville et renvoie l'entité créée. */
  addCitizen(name: string): Citizen {
    if (this._gameOver) {
      throw new GameRuleError('La partie est terminée : impossible d\'ajouter un citoyen.');
    }
    if (name.trim().length === 0) {
      throw new GameRuleError('Le nom d\'un citoyen ne peut pas être vide.');
    }
    const citizen: Citizen = {
      id: `c${this.nextCitizenSeq++}`,
      name: name.trim(),
      alive: true,
      location: 'town',
      actionPoints: this.config.startingActionPoints,
      consecutiveThirstDays: 0,
    };
    this._citizens.push(citizen);
    return citizen;
  }

  /**
   * Déplace un citoyen entre la ville et le désert. Gratuit, mais possible
   * uniquement de jour : la nuit, les portes de la ville sont closes.
   */
  setLocation(citizenId: string, location: Location): void {
    this.assertPlayable();
    const citizen = this.requireAliveCitizen(citizenId);
    citizen.location = location;
  }

  /**
   * Une action de construction : le citoyen dépense des points d'action et
   * des ressources de la banque pour renforcer durablement la ville.
   */
  build(citizenId: string): void {
    this.assertPlayable();
    const citizen = this.requireAliveCitizen(citizenId);
    if (citizen.location !== 'town') {
      throw new GameRuleError('Seul un citoyen présent en ville peut construire.');
    }
    const { buildActionPointCost, buildResourceCost, defensePerBuildAction } = this.config;
    this.spendActionPoints(citizen, buildActionPointCost);
    if (this._bank.wood < buildResourceCost.wood || this._bank.metal < buildResourceCost.metal) {
      throw new GameRuleError('Ressources insuffisantes dans la banque pour construire.');
    }
    this._bank.wood -= buildResourceCost.wood;
    this._bank.metal -= buildResourceCost.metal;
    this._townDefense += defensePerBuildAction;
  }

  /**
   * Une action de fouille : le citoyen, dans le désert, dépense des points
   * d'action pour rapporter des ressources à la banque de la ville.
   */
  scavenge(citizenId: string): void {
    this.assertPlayable();
    const citizen = this.requireAliveCitizen(citizenId);
    if (citizen.location !== 'desert') {
      throw new GameRuleError('Il faut être dans le désert pour fouiller.');
    }
    this.spendActionPoints(citizen, this.config.scavengeActionPointCost);
    const yieldBank = this.config.scavengeYield;
    this._bank.wood += yieldBank.wood;
    this._bank.metal += yieldBank.metal;
    this._bank.water += yieldBank.water;
  }

  /**
   * Clôt la journée : verrouille les portes, résout l'assaut de la horde,
   * puis fait lever le jour suivant (gestion de la soif et des points
   * d'action). Renvoie le compte rendu de la nuit.
   */
  endDay(): NightReport {
    this.assertPlayable();
    this._phase = 'night';

    const deaths: Death[] = [];
    const hordePower = this.hordePower(this._day);

    // Les citoyens restés dans le désert sont sans défense face à la horde.
    for (const citizen of this._citizens) {
      if (citizen.alive && citizen.location === 'desert') {
        this.kill(citizen, 'dévoré dans le désert');
        deaths.push(this.toDeath(citizen));
      }
    }

    // La horde frappe les murs. Si elle déborde la défense, des citoyens
    // abrités meurent, proportionnellement au débordement.
    const breached = hordePower > this._townDefense;
    if (breached) {
      const overflow = hordePower - this._townDefense;
      const victimsCount = Math.ceil(overflow / this.config.killThreshold);
      const shelteredAlive = this._citizens.filter(
        (c) => c.alive && c.location === 'town',
      );
      for (let i = 0; i < victimsCount && i < shelteredAlive.length; i++) {
        const victim = shelteredAlive[i]!;
        this.kill(victim, 'tué lors de la percée de la horde');
        deaths.push(this.toDeath(victim));
      }
    }

    const survivorsAfterNight = this.aliveCount;
    if (survivorsAfterNight === 0) {
      this._gameOver = true;
      return {
        day: this._day,
        hordePower,
        townDefense: this._townDefense,
        breached,
        deaths,
        survivors: 0,
        gameOver: true,
      };
    }

    // L'aube se lève : nouveau jour, gestion de la soif et des points d'action.
    const nightDay = this._day;
    this.dawn(deaths);

    const survivors = this.aliveCount;
    this._gameOver = survivors === 0;
    return {
      day: nightDay,
      hordePower,
      townDefense: this._townDefense,
      breached,
      deaths,
      survivors,
      gameOver: this._gameOver,
    };
  }

  /** Puissance d'attaque de la horde pour un jour donné. */
  hordePower(day: number): number {
    return this.config.hordeBaseAttack + this.config.hordeGrowthPerDay * (day - 1);
  }

  /** État public complet de la partie. */
  status(): GameStatus {
    return {
      day: this._day,
      phase: this._phase,
      townDefense: this._townDefense,
      bank: { ...this._bank },
      citizens: this._citizens.map((c) => ({ ...c })),
      aliveCount: this.aliveCount,
      hordePowerTonight: this.hordePower(this._day),
      gameOver: this._gameOver,
    };
  }

  get day(): number {
    return this._day;
  }

  get phase(): Phase {
    return this._phase;
  }

  get townDefense(): number {
    return this._townDefense;
  }

  get gameOver(): boolean {
    return this._gameOver;
  }

  /** Nombre de citoyens actuellement en vie. */
  get aliveCount(): number {
    return this._citizens.filter((c) => c.alive).length;
  }

  /** Fait lever le jour suivant : soif, déshydratation et recharge des PA. */
  private dawn(deaths: Death[]): void {
    this._day += 1;
    this._phase = 'day';
    for (const citizen of this._citizens) {
      if (!citizen.alive) {
        continue;
      }
      if (this._bank.water > 0) {
        this._bank.water -= 1;
        citizen.consecutiveThirstDays = 0;
        citizen.actionPoints = this.config.startingActionPoints;
      } else {
        citizen.consecutiveThirstDays += 1;
        if (citizen.consecutiveThirstDays >= 2) {
          this.kill(citizen, 'mort de déshydratation');
          deaths.push(this.toDeath(citizen));
        } else {
          // Un citoyen assoiffé n'a la force que de la moitié de ses actions.
          citizen.actionPoints = Math.floor(this.config.startingActionPoints / 2);
        }
      }
    }
  }

  private kill(citizen: Citizen, cause: string): void {
    citizen.alive = false;
    citizen.actionPoints = 0;
    citizen.causeOfDeath = cause;
  }

  private toDeath(citizen: Citizen): Death {
    return {
      citizenId: citizen.id,
      name: citizen.name,
      cause: citizen.causeOfDeath ?? 'cause inconnue',
    };
  }

  private spendActionPoints(citizen: Citizen, cost: number): void {
    if (citizen.actionPoints < cost) {
      throw new GameRuleError(
        `${citizen.name} n'a pas assez de points d'action (${citizen.actionPoints}/${cost}).`,
      );
    }
    citizen.actionPoints -= cost;
  }

  private requireAliveCitizen(citizenId: string): Citizen {
    const citizen = this._citizens.find((c) => c.id === citizenId);
    if (!citizen) {
      throw new GameRuleError(`Citoyen introuvable : ${citizenId}.`);
    }
    if (!citizen.alive) {
      throw new GameRuleError(`${citizen.name} est mort et ne peut plus agir.`);
    }
    return citizen;
  }

  private assertPlayable(): void {
    if (this._gameOver) {
      throw new GameRuleError('La partie est terminée.');
    }
    if (this._phase !== 'day') {
      throw new GameRuleError('Action impossible : ce n\'est pas la phase de jour.');
    }
  }
}
