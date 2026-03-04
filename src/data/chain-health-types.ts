// Chain health types for Story 8.4 — Predictive Chain Migration

// Airdrop indicator types
export type AirdropIndicatorType =
  | 'tge'
  | 'governance-launch'
  | 'points-program'
  | 'token-distribution';

export interface AirdropIndicator {
  readonly type: AirdropIndicatorType;
  readonly protocol: string;
  readonly detectedAt: number;
  readonly confidence: number; // 0-1
}

// TVL history entry
export interface TvlHistoryEntry {
  readonly timestamp: number;
  readonly value: number;
}

// Chain metrics — raw data collected per chain
export interface ChainMetrics {
  readonly chainId: number;
  readonly chainName: string;
  tvl: number; // USD
  tvlHistory: TvlHistoryEntry[]; // rolling 30 days
  tvlInflowRate7d: number; // fractional, e.g., 0.10 = 10%
  tvlOutflowRate3d: number; // fractional
  protocolCount: number;
  newProtocolsPerWeek: number;
  uniqueActiveAddresses: number;
  activeAddressGrowthRate: number; // fractional
  bridgeVolumeUsd: number; // 7-day aggregate via LI.FI
  chainAgeDays: number;
  airdropIndicators: AirdropIndicator[];
  lastUpdated: number; // epoch ms
}

// Health score components — each normalized to 0-100
export interface HealthScoreComponents {
  readonly tvlGrowth: number; // 0-100
  readonly protocolDiversity: number; // 0-100
  readonly developerActivity: number; // 0-100
  readonly bridgeVolume: number; // 0-100
  readonly chainAgeFactor: number; // 0-100
}

// Risk level — string literal union, not enum
export type RiskLevel = 'low' | 'medium' | 'high';

// Chain health score — computed from metrics
export interface ChainHealthScore {
  readonly chainId: number;
  readonly chainName: string;
  readonly overallScore: number; // 0-100
  readonly components: HealthScoreComponents;
  readonly riskLevel: RiskLevel;
  readonly isEmerging: boolean;
  cyrusExposurePercent: number;
  readonly lastScored: number;
}

// Migration plan status — string literal union, not enum
export type MigrationPlanStatus =
  | 'pending'
  | 'executing'
  | 'active'
  | 'exit-triggered'
  | 'exited'
  | 'expired';

// Target protocol info for migration
export interface TargetProtocol {
  readonly protocol: string;
  readonly apy: number;
  readonly tvl: number;
}

// Migration plan — describes a capital migration to an emerging chain
export interface MigrationPlan {
  readonly id: string;
  readonly sourceChainIds: number[];
  readonly destinationChainId: number;
  readonly capitalPercent: number; // fractional
  readonly estimatedAmountUsd: number;
  readonly targetProtocols: TargetProtocol[];
  readonly estimatedBridgeCostUsd: number;
  readonly estimatedBridgeTimeSeconds: number;
  readonly timeLimitBarrierDays: number; // default 14
  readonly healthScoreAtCreation: number;
  status: MigrationPlanStatus;
  readonly createdAt: number;
}

// ChainScout configuration
export interface ChainScoutConfig {
  readonly tvlInflowThreshold: number; // default 0.10 = 10%
  readonly tvlOutflowExitThreshold: number; // default 0.05 = 5%
  readonly deploymentScoreThreshold: number; // default 70
  readonly capitalMigrationPercent: number; // default 0.05 = 5%
  readonly timeLimitDays: number; // default 14
  readonly updateIntervalMs: number; // default 3600000 (1 hour)
  readonly establishedChains: number[]; // default [1, 42161, 8453] (ETH, ARB, Base)
}

// Health score weights
export const HEALTH_SCORE_WEIGHTS = {
  tvlGrowth: 0.30,
  protocolDiversity: 0.20,
  developerActivity: 0.20,
  bridgeVolume: 0.20,
  chainAgeFactor: 0.10,
} as const;

// Default configuration
export const DEFAULT_CHAIN_SCOUT_CONFIG: ChainScoutConfig = {
  tvlInflowThreshold: 0.10,
  tvlOutflowExitThreshold: 0.05,
  deploymentScoreThreshold: 70,
  capitalMigrationPercent: 0.05,
  timeLimitDays: 14,
  updateIntervalMs: 3_600_000,
  establishedChains: [1, 42161, 8453],
};
