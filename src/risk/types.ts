// Risk management types — used across all risk engine components

// --- Triple Barrier types (Story 3.1) ---

export type BarrierCloseReason =
  | 'stop-loss'
  | 'take-profit'
  | 'time-limit'
  | 'trailing-stop'
  | 'custom-stoploss'
  | 'gas-ceiling'
  | 'slippage-threshold'
  | 'bridge-timeout';

export interface TrailingStopConfig {
  readonly enabled: boolean;
  readonly activationPrice: number;
  readonly trailingDelta: number;
}

export interface CrossChainBarrierConfig {
  readonly gasCeiling: number; // max gas cost in USD
  readonly slippageThreshold: number; // max fractional slippage (e.g. 0.03 = 3%)
  readonly bridgeTimeout: number; // max bridge time in seconds
}

export interface BarrierConfig {
  readonly stopLoss: number; // negative fractional (e.g. -0.02 = -2%)
  readonly takeProfit: number; // positive fractional (e.g. 0.05 = 5%)
  readonly timeLimit: number; // seconds
  readonly trailingStop?: TrailingStopConfig;
  readonly crossChainBarriers?: CrossChainBarrierConfig;
}

export type BarrierResult =
  | { readonly type: 'hold' }
  | { readonly type: 'close'; readonly reason: BarrierCloseReason; readonly details: string };

// Transfer plan for cross-chain barrier evaluation
export interface TransferPlan {
  readonly estimatedGasCostUsd: number;
  readonly estimatedSlippage: number;
  readonly estimatedBridgeTimeSeconds: number;
}

// --- Portfolio Tier types (Story 3.2) ---

export type PortfolioTier = 'safe' | 'growth' | 'degen' | 'reserve';

export interface TierConfig {
  readonly tier: PortfolioTier;
  readonly targetPercent: number;
  readonly tolerance: number; // e.g. 0.03 = ±3%
  readonly minPercent: number;
  readonly maxPercent: number;
}

export type TierStatus = 'balanced' | 'overweight' | 'underweight';

export interface TierAllocation {
  readonly tier: PortfolioTier;
  readonly targetPercent: number;
  readonly actualPercent: number;
  readonly actualValueUsd: number;
  readonly deviation: number; // actual - target
  readonly status: TierStatus;
}

export interface PortfolioSnapshot {
  readonly totalValueUsd: number;
  readonly tiers: TierAllocation[];
  readonly timestamp: number;
  readonly hasStalePrices: boolean;
}

export interface RebalancingSuggestion {
  readonly fromTier: PortfolioTier;
  readonly toTier: PortfolioTier;
  readonly amountUsd: number;
  readonly reason: string;
}

// --- Kelly Criterion types (Story 3.3) ---

export interface PositionSizeInput {
  readonly winProbability: number; // 0-1
  readonly payoffRatio: number; // > 0
  readonly tierAvailableCapital: number; // USD
  readonly maxPositionSizeUsd: number;
  readonly kellyFraction: number; // e.g. 0.5 for half-Kelly, 1.0 for full-Kelly
}

export type PositionSizeCap = 'none' | 'safety-cap' | 'max-position-size' | 'rejected';

export interface PositionSizeResult {
  readonly recommendedSizeUsd: number;
  readonly kellyFractionRaw: number;
  readonly kellyFractionApplied: number;
  readonly cappedBy: PositionSizeCap;
  readonly reason: string;
}

// --- Circuit Breaker types (Story 3.4) ---

export interface CircuitBreakerConfig {
  readonly activationThreshold: number; // negative fractional (e.g. -0.10 = -10%)
  readonly resetThreshold: number; // negative fractional (e.g. -0.05 = -5%)
  readonly aggressiveMode: boolean;
  readonly enabled: boolean;
}

export interface CircuitBreakerState {
  active: boolean;
  peakPortfolioValueUsd: number;
  currentDrawdown: number; // fractional, always <= 0
  activatedAt: number | null;
  lastEvaluatedAt: number;
}

export type CircuitBreakerEventType =
  | 'circuit_breaker_activated'
  | 'circuit_breaker_deactivated';

export interface CircuitBreakerEvent {
  readonly type: CircuitBreakerEventType;
  readonly drawdown: number;
  readonly peakValue: number;
  readonly currentValue: number;
  readonly timestamp: number;
}

// --- Risk Dial types (Story 3.5) ---

export type RiskDialLevel = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

export interface RiskDialTierAllocation {
  readonly safe: number;
  readonly growth: number;
  readonly degen: number;
  readonly reserve: number;
}
