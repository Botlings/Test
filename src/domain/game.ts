import { DEFAULT_CONFIG, type GameConfig } from './config.js';
import {
  getBuildingDef,
  isKnownBuildingId,
  sanitizeBuildingState,
  totalWallDefenseFromBuildings,
  totalWatchBonusFromBuildings,
  totalWaterPerDawnFromBuildings,
  type BuildingId,
  type BuildingState,
} from './buildings.js';
import {
  cloneDesertMap,
  dawnTickDesert,
  generateDesertMap,
  getZone,
  isAdjacent,
  isTown,
  mulberry32,
  sanitizeDesertMap,
  seedFromString,
  takeFromZone,
  type DesertMap,
  type DesertZone,
} from './desert.js';
import type {
  AttackWave,
  Citizen,
  Death,
  DeathSource,
  DefenseBreakdown,
  DeathsBySource,
  DesertSnapshot,
  GameStatus,
  Location,
  NightReport,
  Phase,
  ResourceBank,
  ResourceKind,
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
  /**
   * Défense « historique » des murs : `baseDefense` + somme des renforts
   * accumulés via l'action générique `build()`. Les bonus apportés par les
   * bâtiments du catalogue (`buildings`) sont *en plus* et calculés à la
   * volée, jamais inclus dans cette valeur stockée.
   */
  readonly townDefense: number;
  readonly bank: ResourceBank;
  readonly citizens: ReadonlyArray<Citizen>;
  readonly gameOver: boolean;
  readonly nextCitizenSeq: number;
  /**
   * Compteur d'instances par bâtiment construit. Optionnel pour la
   * rétro-compatibilité avec les snapshots écrits avant l'introduction du
   * catalogue.
   */
  readonly buildings?: BuildingState;
  /**
   * Carte du désert sérialisable (graine + zones). Optionnel pour la
   * rétro-compatibilité des snapshots antérieurs ; régénéré depuis la seed
   * (ou une seed de secours) si absent.
   */
  readonly desert?: DesertMap;
  /** Graine d'origine de la carte du désert (pour régénérer si besoin). */
  readonly desertSeed?: number;
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
  /** Compteur d'instances par bâtiment construit (catalogue `buildings.ts`). */
  private _buildings: Partial<Record<BuildingId, number>> = {};
  /** Graine de la carte du désert (stable pour une partie donnée). */
  private _desertSeed: number;
  /** Carte du désert vivante (mutée par les actions d'exploration). */
  private _desert: DesertMap;

  constructor(config: GameConfig = DEFAULT_CONFIG, desertSeed?: number) {
    this.config = config;
    this._townDefense = config.baseDefense;
    this._bank = { ...config.startingBank };
    this._desertSeed =
      typeof desertSeed === 'number' && Number.isFinite(desertSeed)
        ? desertSeed >>> 0
        : seedFromString(`hr-${Math.random()}-${Date.now()}`);
    this._desert = generateDesertMap(this._desertSeed, config.desert);
  }

  /** Reconstruit un moteur à partir d'un snapshot persisté. */
  static fromSnapshot(config: GameConfig, snapshot: GameSnapshot): Game {
    const seedFallback =
      typeof snapshot.desertSeed === 'number'
        ? (snapshot.desertSeed >>> 0)
        : seedFromString(`hr-snapshot-fallback`);
    const game = new Game(config, seedFallback);
    game._day = snapshot.day;
    game._phase = snapshot.phase;
    game._townDefense = snapshot.townDefense;
    game._bank.wood = snapshot.bank.wood;
    game._bank.metal = snapshot.bank.metal;
    game._bank.water = snapshot.bank.water;
    game._gameOver = snapshot.gameOver;
    game.nextCitizenSeq = snapshot.nextCitizenSeq;
    for (const c of snapshot.citizens) {
      const position =
        c.position && typeof c.position.x === 'number' && typeof c.position.y === 'number'
          ? { x: c.position.x, y: c.position.y }
          : null;
      const canteen =
        typeof c.waterCanteen === 'number' && Number.isFinite(c.waterCanteen)
          ? Math.max(0, Math.trunc(c.waterCanteen))
          : config.desert.canteenCapacity;
      game._citizens.push({
        ...c,
        position,
        waterCanteen: Math.min(config.desert.canteenCapacity, canteen),
      });
    }
    game._buildings = { ...sanitizeBuildingState(snapshot.buildings ?? {}) };
    game._desert = sanitizeDesertMap(snapshot.desert, seedFallback);
    return game;
  }

  /** Exporte un snapshot sérialisable de l'état courant. */
  snapshot(): GameSnapshot {
    return {
      day: this._day,
      phase: this._phase,
      townDefense: this._townDefense,
      bank: { ...this._bank },
      citizens: this._citizens.map((c) => ({
        ...c,
        position: c.position ? { x: c.position.x, y: c.position.y } : null,
      })),
      gameOver: this._gameOver,
      nextCitizenSeq: this.nextCitizenSeq,
      buildings: { ...this._buildings },
      desert: cloneDesertMap(this._desert),
      desertSeed: this._desertSeed,
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
      position: null,
      waterCanteen: this.config.desert.canteenCapacity,
    };
    this._citizens.push(citizen);
    return citizen;
  }

  /**
   * Déplace un citoyen entre la ville et la première zone du désert (cas
   * « gateway »). Conservé pour rétro-compatibilité avec les anciens clients
   * qui ne connaissent pas la grille de zones : envoyer le citoyen au désert
   * sans préciser de coordonnées le place automatiquement sur la zone
   * d'entrée la plus proche disponible, et le revenir le ramène en ville.
   * Pour un déplacement précis, utiliser `moveToZone()`.
   */
  setLocation(citizenId: string, location: Location): void {
    this.assertPlayable();
    const citizen = this.requireAliveCitizen(citizenId);
    if (location === 'town') {
      citizen.location = 'town';
      citizen.position = null;
      return;
    }
    if (citizen.location === 'desert' && citizen.position) {
      // Déjà dans le désert — pas de changement.
      return;
    }
    const gateway = this.firstAvailableGateway();
    if (!gateway) {
      throw new GameRuleError('Aucune zone d\'entrée disponible autour de la ville.');
    }
    this.enterZone(citizen, gateway);
  }

  /**
   * Déplace un citoyen vers une zone adjacente à sa position courante (ou
   * vers la ville). Coûte `desert.moveActionPointCost` PA. Permet la
   * navigation en grille dans le désert.
   */
  moveToZone(citizenId: string, target: { x: number; y: number }): { discovered: boolean } {
    this.assertPlayable();
    const citizen = this.requireAliveCitizen(citizenId);
    const { x, y } = target;
    if (!Number.isInteger(x) || !Number.isInteger(y)) {
      throw new GameRuleError('Coordonnées de zone invalides.');
    }

    const currentX = citizen.position ? citizen.position.x : 0;
    const currentY = citizen.position ? citizen.position.y : 0;
    if (!isAdjacent(currentX, currentY, x, y)) {
      throw new GameRuleError('Vous ne pouvez vous déplacer que vers une case adjacente.');
    }

    if (isTown(x, y)) {
      this.spendActionPoints(citizen, this.config.desert.moveActionPointCost);
      citizen.location = 'town';
      citizen.position = null;
      return { discovered: false };
    }

    const zone = getZone(this._desert, x, y);
    if (!zone) {
      throw new GameRuleError('Cette case n\'existe pas (hors carte).');
    }
    this.spendActionPoints(citizen, this.config.desert.moveActionPointCost);
    return this.enterZone(citizen, zone);
  }

  private enterZone(citizen: Citizen, zone: DesertZone): { discovered: boolean } {
    citizen.location = 'desert';
    citizen.position = { x: zone.x, y: zone.y };
    const discovered = !zone.discovered;
    if (discovered) zone.discovered = true;
    return { discovered };
  }

  private firstAvailableGateway(): DesertZone | undefined {
    const candidates: Array<[number, number]> = [
      [1, 0],
      [0, 1],
      [-1, 0],
      [0, -1],
      [1, 1],
      [-1, 1],
      [1, -1],
      [-1, -1],
    ];
    for (const [x, y] of candidates) {
      const zone = getZone(this._desert, x, y);
      if (zone) return zone;
    }
    return undefined;
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
   * Érige une instance d'un bâtiment du catalogue (`buildings.ts`). Coûte
   * des points d'action et des ressources spécifiques au bâtiment. Le bonus
   * défensif/utilitaire est immédiatement effectif (visible dans le prochain
   * `status()`, intégré à la prochaine nuit et à la prochaine aube).
   */
  constructBuilding(citizenId: string, buildingId: string): { count: number; townDefense: number } {
    this.assertPlayable();
    const def = getBuildingDef(buildingId);
    if (!def || !isKnownBuildingId(buildingId)) {
      throw new GameRuleError(`Bâtiment inconnu : ${buildingId}.`);
    }
    const citizen = this.requireAliveCitizen(citizenId);
    if (citizen.location !== 'town') {
      throw new GameRuleError('Seul un citoyen présent en ville peut construire.');
    }
    const currentCount = this._buildings[def.id] ?? 0;
    if (currentCount >= def.maxCount) {
      throw new GameRuleError(
        `Limite atteinte pour « ${def.name} » (${def.maxCount} max).`,
      );
    }
    if (
      this._bank.wood < def.cost.wood ||
      this._bank.metal < def.cost.metal
    ) {
      throw new GameRuleError(
        `Ressources insuffisantes pour bâtir « ${def.name} » (coût : ${def.cost.wood} bois, ${def.cost.metal} métal).`,
      );
    }
    this.spendActionPoints(citizen, def.actionPointCost);
    this._bank.wood -= def.cost.wood;
    this._bank.metal -= def.cost.metal;
    const nextCount = currentCount + 1;
    this._buildings[def.id] = nextCount;
    return { count: nextCount, townDefense: this.totalWallDefense() };
  }

  /**
   * Une action de fouille : le citoyen, dans le désert, dépense des points
   * d'action pour rapporter des ressources à la banque de la ville.
   *
   * Si le citoyen est positionné sur une zone précise de la carte (le cas
   * normal depuis l'introduction de la grille), on délègue à `scavengeZone`
   * qui tire l'objet depuis le stock de la zone. Sinon (compat ancien client
   * sans coordonnées), on applique l'ancien rendement forfaitaire.
   */
  scavenge(citizenId: string): { picked?: ResourceKind; legacy: boolean } {
    this.assertPlayable();
    const citizen = this.requireAliveCitizen(citizenId);
    if (citizen.location !== 'desert') {
      throw new GameRuleError('Il faut être dans le désert pour fouiller.');
    }
    if (citizen.position) {
      const result = this.scavengeZoneInternal(citizen);
      return { ...(result.picked ? { picked: result.picked } : {}), legacy: false };
    }
    // Compat : pas de position connue → rendement forfaitaire historique.
    this.spendActionPoints(citizen, this.config.scavengeActionPointCost);
    const yieldBank = this.config.scavengeYield;
    this._bank.wood += yieldBank.wood;
    this._bank.metal += yieldBank.metal;
    this._bank.water += yieldBank.water;
    return { legacy: true };
  }

  /**
   * Fouille la zone précise où le citoyen est positionné. Coût : PA + 1 unité
   * de gourde personnelle. Interdit si la zone est infestée de zombies (il
   * faut les chasser d'abord). Renvoie la ressource récoltée ou `undefined`
   * si la zone est désormais vide.
   */
  scavengeZone(citizenId: string): { picked?: ResourceKind; zoneLoot: { wood: number; metal: number; water: number } } {
    this.assertPlayable();
    const citizen = this.requireAliveCitizen(citizenId);
    if (citizen.location !== 'desert' || !citizen.position) {
      throw new GameRuleError('Il faut être dans une zone du désert pour fouiller.');
    }
    return this.scavengeZoneInternal(citizen);
  }

  private scavengeZoneInternal(citizen: Citizen): {
    picked?: ResourceKind;
    zoneLoot: { wood: number; metal: number; water: number };
  } {
    const pos = citizen.position!;
    const zone = getZone(this._desert, pos.x, pos.y);
    if (!zone) {
      throw new GameRuleError('La zone du citoyen est introuvable sur la carte.');
    }
    if (zone.zombies > 0) {
      throw new GameRuleError('Des zombies errants empêchent toute fouille ici — chassez-les.');
    }
    if (citizen.waterCanteen <= 0) {
      throw new GameRuleError('La gourde est vide : rentrez en ville pour la remplir.');
    }
    this.spendActionPoints(citizen, this.config.scavengeActionPointCost);
    citizen.waterCanteen = Math.max(0, citizen.waterCanteen - 1);
    const rng = mulberry32(seedFromString(`scav-${this._desertSeed}-${zone.x}-${zone.y}-${this._day}-${citizen.id}`));
    const picked = takeFromZone(rng, zone);
    if (picked) {
      this._bank[picked] += 1;
    }
    return {
      ...(picked ? { picked } : {}),
      zoneLoot: { ...zone.loot },
    };
  }

  /**
   * Chasse un zombie errant présent dans la zone courante du citoyen. Coûte
   * `desert.fightActionPointCost` PA et retire un zombie de la zone. Avec une
   * probabilité `fightFatalityChance` (déterministe via Rng seedé), le combat
   * tourne mal et le citoyen périt.
   */
  fightZombie(citizenId: string): { remainingZombies: number; citizenAlive: boolean } {
    this.assertPlayable();
    const citizen = this.requireAliveCitizen(citizenId);
    if (citizen.location !== 'desert' || !citizen.position) {
      throw new GameRuleError('Il faut être dans une zone du désert pour combattre.');
    }
    const zone = getZone(this._desert, citizen.position.x, citizen.position.y);
    if (!zone) {
      throw new GameRuleError('Zone introuvable.');
    }
    if (zone.zombies <= 0) {
      throw new GameRuleError('Aucun zombie à chasser ici.');
    }
    this.spendActionPoints(citizen, this.config.desert.fightActionPointCost);
    zone.zombies = Math.max(0, zone.zombies - 1);
    const fatality = this.config.desert.fightFatalityChance;
    let citizenAlive = true;
    if (fatality > 0) {
      const rng = mulberry32(seedFromString(`fight-${this._desertSeed}-${zone.x}-${zone.y}-${this._day}-${citizen.id}`));
      if (rng.next() < fatality) {
        this.kill(citizen, 'tué par un zombie errant lors d\'un combat');
        citizenAlive = false;
      }
    }
    return { remainingZombies: zone.zombies, citizenAlive };
  }

  /**
   * Clôt la journée : verrouille les portes, résout l'assaut de la horde,
   * puis fait lever le jour suivant (gestion de la soif et des points
   * d'action). Renvoie le compte rendu détaillé de la nuit.
   *
   * Algorithme :
   *   1. Les citoyens restés dans le désert sont dévorés en premier.
   *    2. La défense totale = murs (`townDefense`) + faction (citoyens en
   *       ville × `watchDefensePerCitizen`).
   *   3. La horde frappe en trois vagues (poids `hordeWaveWeights`). Si la
   *      somme dépasse la défense, le surplus déborde sur les habitants.
   *   4. Le débordement total tue `ceil(overflow / killThreshold)` citoyens
   *      abrités : d'abord les guetteurs (tombés en faction), puis les
   *      réfugiés (écrasés lors de la percée).
   */
  endDay(): NightReport {
    this.assertPlayable();
    const resolvedAt = new Date().toISOString();
    this._phase = 'night';

    const deaths: Death[] = [];
    const hordePower = this.hordePower(this._day);

    // 1. Désert : carnage immédiat.
    for (const citizen of this._citizens) {
      if (citizen.alive && citizen.location === 'desert') {
        this.kill(citizen, 'dévoré dans le désert');
        deaths.push(this.toDeath(citizen, 'desert'));
      }
    }

    // 2. Calcul de la défense composite (avant que les pertes ne tombent).
    const watcherCount = this._citizens.filter(
      (c) => c.alive && c.location === 'town',
    ).length;
    const buildingsWallBonus = totalWallDefenseFromBuildings(this._buildings);
    const buildingsWatchBonus = totalWatchBonusFromBuildings(this._buildings);
    const walls = this._townDefense + buildingsWallBonus;
    const watchers =
      watcherCount * (this.config.watchDefensePerCitizen + buildingsWatchBonus);
    const defense: DefenseBreakdown = {
      walls,
      watchers,
      watcherCount,
      buildingsWallBonus,
      buildingsWatchBonus,
      total: walls + watchers,
    };

    // 3. Décomposition de l'assaut en trois vagues.
    const waves = this.splitWaves(hordePower, defense.total);

    // 4. Calcul des décès sur la base du débordement total.
    const overflow = Math.max(0, hordePower - defense.total);
    const breached = overflow > 0;
    if (breached) {
      const victimsCount = Math.ceil(overflow / this.config.killThreshold);
      const sheltered = this._citizens.filter(
        (c) => c.alive && c.location === 'town',
      );
      // Les premiers à tomber sont les guetteurs sur les remparts ; au-delà
      // de la moitié des pertes, les réfugiés massés derrière les portes
      // sont à leur tour atteints. Sans bonus de garde (ni config, ni tour
      // de guet), personne n'est officiellement « en faction » : toutes
      // les pertes sont alors "breach".
      const watchPerCitizen =
        this.config.watchDefensePerCitizen + buildingsWatchBonus;
      const watchersAvailable = watchPerCitizen > 0 ? watcherCount : 0;
      const maxWatchDeaths = Math.min(
        watchersAvailable,
        Math.ceil(victimsCount / 2),
      );
      for (let i = 0; i < victimsCount && i < sheltered.length; i++) {
        const victim = sheltered[i]!;
        if (i < maxWatchDeaths) {
          this.kill(victim, 'tombé en faction sur les remparts');
          deaths.push(this.toDeath(victim, 'watch'));
        } else {
          this.kill(victim, 'tué lors de la percée de la horde');
          deaths.push(this.toDeath(victim, 'breach'));
        }
      }
    }

    const survivorsAfterNight = this.aliveCount;
    if (survivorsAfterNight === 0) {
      this._gameOver = true;
      return this.buildReport({
        nightDay: this._day,
        hordePower,
        defense,
        waves,
        overflow,
        breached,
        deaths,
        survivors: 0,
        gameOver: true,
        resolvedAt,
      });
    }

    // 5. L'aube se lève : nouveau jour, soif et recharge des points d'action.
    const nightDay = this._day;
    this.dawn(deaths);

    const survivors = this.aliveCount;
    this._gameOver = survivors === 0;
    return this.buildReport({
      nightDay,
      hordePower,
      defense,
      waves,
      overflow,
      breached,
      deaths,
      survivors,
      gameOver: this._gameOver,
      resolvedAt,
    });
  }

  /**
   * Découpe l'attaque de la horde en trois vagues déterministes. La défense
   * (walls + faction) est supposée se ré-armer entre deux vagues — les
   * vagues servent à raconter le déroulé au joueur. La somme des `attack`
   * vaut toujours exactement `hordePower`.
   */
  private splitWaves(hordePower: number, totalDefense: number): AttackWave[] {
    const weights = this.config.hordeWaveWeights;
    const attacks: number[] = [];
    let assigned = 0;
    for (let i = 0; i < weights.length - 1; i++) {
      const a = Math.round(hordePower * weights[i]!);
      attacks.push(a);
      assigned += a;
    }
    attacks.push(Math.max(0, hordePower - assigned));
    return attacks.map((attack, idx) => {
      const absorbed = Math.min(attack, totalDefense);
      return {
        index: idx + 1,
        attack,
        absorbed,
        overflow: attack - absorbed,
      };
    });
  }

  private buildReport(input: {
    nightDay: number;
    hordePower: number;
    defense: DefenseBreakdown;
    waves: AttackWave[];
    overflow: number;
    breached: boolean;
    deaths: Death[];
    survivors: number;
    gameOver: boolean;
    resolvedAt: string;
  }): NightReport {
    const counts: Record<DeathSource, number> = {
      desert: 0,
      watch: 0,
      breach: 0,
      dehydration: 0,
    };
    for (const d of input.deaths) {
      counts[d.source] += 1;
    }
    const deathsBySource: DeathsBySource = counts;
    return {
      day: input.nightDay,
      hordePower: input.hordePower,
      townDefense: input.defense.total,
      defense: input.defense,
      waves: input.waves,
      overflow: input.overflow,
      breached: input.breached,
      deaths: input.deaths,
      deathsBySource,
      survivors: input.survivors,
      gameOver: input.gameOver,
      resolvedAt: input.resolvedAt,
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
      townDefense: this.totalWallDefense(),
      bank: { ...this._bank },
      citizens: this._citizens.map((c) => ({
        ...c,
        position: c.position ? { x: c.position.x, y: c.position.y } : null,
      })),
      aliveCount: this.aliveCount,
      hordePowerTonight: this.hordePower(this._day),
      gameOver: this._gameOver,
      buildings: { ...this._buildings } as Record<string, number>,
      desert: this.desertSnapshot(),
    };
  }

  /** Vue publique de la carte (zones triées). */
  desertSnapshot(): DesertSnapshot {
    const zones = Object.values(this._desert.zones)
      .slice()
      .sort((a, b) => (a.y !== b.y ? a.y - b.y : a.x - b.x))
      .map((z) => ({
        x: z.x,
        y: z.y,
        distance: z.distance,
        terrain: z.terrain,
        loot: { ...z.loot },
        zombies: z.zombies,
        discovered: z.discovered,
      }));
    return { radius: this._desert.radius, zones };
  }

  /** Référence interne de la carte (utilisée par les tests). */
  desertMap(): DesertMap {
    return this._desert;
  }

  /** Lit une zone de la carte (utile aux routes API). */
  getDesertZone(x: number, y: number): DesertZone | undefined {
    return getZone(this._desert, x, y);
  }

  /** Compteurs courants des bâtiments construits (immutables côté appelant). */
  buildings(): BuildingState {
    return { ...this._buildings };
  }

  /** Total `walls` opposés à la horde : base + build() + bonus bâtiments. */
  totalWallDefense(): number {
    return this._townDefense + totalWallDefenseFromBuildings(this._buildings);
  }

  get day(): number {
    return this._day;
  }

  get phase(): Phase {
    return this._phase;
  }

  /** Défense exposée (murs + bonus bâtiments). */
  get townDefense(): number {
    return this.totalWallDefense();
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
    // Production passive d'eau par les puits : ravitaillement matinal de la
    // banque, AVANT que les citoyens ne boivent. Permet à un puits opérationnel
    // d'éviter la déshydratation.
    const waterProduced = totalWaterPerDawnFromBuildings(this._buildings);
    if (waterProduced > 0) {
      this._bank.water += waterProduced;
    }
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
          deaths.push(this.toDeath(citizen, 'dehydration'));
        } else {
          // Un citoyen assoiffé n'a la force que de la moitié de ses actions.
          citizen.actionPoints = Math.floor(this.config.startingActionPoints / 2);
        }
      }
      // Les survivants de retour en ville remplissent leur gourde au robinet
      // commun, dans la limite de la capacité (la gourde ne pompe pas la banque
      // — c'est l'« eau personnelle de la veille » qui reste).
      if (citizen.alive && citizen.location === 'town') {
        citizen.waterCanteen = this.config.desert.canteenCapacity;
      }
    }
    // La carte du désert respire : nouveaux zombies, repop ponctuel de loot.
    dawnTickDesert(this._desert, this._day);
  }

  private kill(citizen: Citizen, cause: string): void {
    citizen.alive = false;
    citizen.actionPoints = 0;
    citizen.causeOfDeath = cause;
  }

  private toDeath(citizen: Citizen, source: DeathSource): Death {
    return {
      citizenId: citizen.id,
      name: citizen.name,
      cause: citizen.causeOfDeath ?? 'cause inconnue',
      source,
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
