// Stat Arb Store Slice — types, helpers, and integration with the Store singleton

// --- String literal unions (no enums) ---

export type StatArbDirection = 'long_pair' | 'short_pair';
export type StatArbSignalSource = 'native' | 'telegram' | 'external';
export type StatArbExitReason =
  | 'mean_reversion'
  | 'time_stop'
  | 'stoploss'
  | 'telegram_close'
  | 'manual';
export type StatArbPositionStatus = 'active' | 'closed';

// --- Interfaces ---

export interface StatArbPair {
  readonly tokenA: string;
  readonly tokenB: string;
  readonly key: string;
}

export interface StatArbSignal {
  readonly signalId: string;
  readonly pair: StatArbPair;
  readonly direction: StatArbDirection;
  readonly zScore: number;
  readonly correlation: number;
  readonly halfLifeHours: number;
  readonly hedgeRatio: number;
  readonly recommendedLeverage: number;
  readonly source: StatArbSignalSource;
  readonly timestamp: number;
  consumed: boolean;
  readonly expiresAt: number;
}

export interface StatArbExitSignal {
  readonly signalId: string;
  readonly positionId: string;
  readonly pair: StatArbPair;
  readonly reason: StatArbExitReason;
  readonly zScore: number;
  readonly elapsedHours: number;
  readonly halfLifeHours: number;
  readonly timestamp: number;
}

export interface StatArbLeg {
  readonly symbol: string;
  readonly side: 'long' | 'short';
  readonly size: number;
  readonly entryPrice: number;
  currentPrice: number;
  unrealizedPnl: number;
  funding: number;
  orderId?: string;
}

export interface StatArbPosition {
  readonly positionId: string;
  readonly pair: StatArbPair;
  readonly direction: StatArbDirection;
  readonly hedgeRatio: number;
  readonly leverage: number;
  readonly legA: StatArbLeg;
  readonly legB: StatArbLeg;
  readonly openTimestamp: number;
  readonly halfLifeHours: number;
  combinedPnl: number;
  accumulatedFunding: number;
  marginUsed: number;
  totalFees: number;
  readonly status: StatArbPositionStatus;
  readonly signalSource: StatArbSignalSource;
  closeReason?: StatArbExitReason;
  closeTimestamp?: number;
  closePnl?: number;
}

export interface StatArbCloseData {
  readonly reason: StatArbExitReason;
  readonly closeTimestamp: number;
  readonly closePnl: number;
  readonly legAClosePrice: number;
  readonly legBClosePrice: number;
}

export interface SignalCountStats {
  readonly total: number;
  readonly pending: number;
  readonly consumed: number;
  readonly expired: number;
}

// --- Event name constants ---

export const STAT_ARB_SIGNAL_EVENT = 'stat_arb_signal' as const;
export const STAT_ARB_POSITION_OPENED_EVENT = 'stat_arb_position_opened' as const;
export const STAT_ARB_POSITION_CLOSED_EVENT = 'stat_arb_position_closed' as const;
export const STAT_ARB_EXIT_SIGNAL_EVENT = 'stat_arb_exit_signal' as const;

// --- Helper utilities ---

/**
 * Create canonical pair key with alphabetical sorting.
 * Ensures "BTC-ETH" and "ETH-BTC" produce the same key.
 */
export function createPairKey(tokenA: string, tokenB: string): string {
  const sorted = [tokenA, tokenB].sort();
  return `${sorted[0]}-${sorted[1]}`;
}

/**
 * Parse a composite pair key back into token pair.
 */
export function parsePairKey(key: string): { tokenA: string; tokenB: string } {
  const idx = key.indexOf('-');
  if (idx === -1) {
    throw new Error(`Invalid pair key: ${key}`);
  }
  return { tokenA: key.slice(0, idx), tokenB: key.slice(idx + 1) };
}

/**
 * Check if a signal has expired.
 */
export function isSignalExpired(signal: StatArbSignal): boolean {
  return Date.now() > signal.expiresAt;
}

/**
 * Check if combined P&L has breached the stoploss threshold.
 */
export function calculateStoplossBreached(
  position: StatArbPosition,
  stoplossPercent: number,
): boolean {
  if (position.marginUsed <= 0) return false;
  return position.combinedPnl / position.marginUsed < -stoplossPercent;
}
