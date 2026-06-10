export { Game, GameRuleError, type GameSnapshot } from './game.js';
export { DEFAULT_CONFIG, type GameConfig } from './config.js';
export {
  BUILDING_CATALOG,
  getBuildingDef,
  isKnownBuildingId,
  sanitizeBuildingState,
  totalWallDefenseFromBuildings,
  totalWatchBonusFromBuildings,
  totalWaterPerDawnFromBuildings,
  type BuildingCost,
  type BuildingDef,
  type BuildingId,
  type BuildingState,
} from './buildings.js';
export type {
  AttackWave,
  Citizen,
  Death,
  DeathSource,
  DeathsBySource,
  DefenseBreakdown,
  GameOutcome,
  GameStatus,
  Location,
  NightReport,
  Phase,
  ResourceBank,
  ResourceKind,
} from './types.js';
