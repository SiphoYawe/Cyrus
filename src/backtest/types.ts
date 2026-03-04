// Backtest configuration and result types

/**
 * Fee model for simulated trades during backtesting.
 * All percent values are fractional (e.g., 0.003 = 0.3%).
 */
export interface FeeModel {
  readonly bridgeFeePercent: number;
  readonly gasEstimateUsd: number;
  readonly dexFeePercent: number;
}

/**
 * Configuration for a backtest run.
 */
export interface BacktestConfig {
  readonly strategyName: string;
  /** Unix timestamp in milliseconds */
  readonly startDate: number;
  /** Unix timestamp in milliseconds */
  readonly endDate: number;
  /** Initial capital in token smallest units (bigint) */
  readonly initialCapital: bigint;
  /** Milliseconds between ticks */
  readonly tickInterval: number;
  /** Fractional slippage, default 0.005 (0.5%) */
  readonly slippage: number;
  /** Simulated bridge delay in milliseconds */
  readonly bridgeDelayMs: number;
  /** Fee model for simulated trades */
  readonly feeModel: FeeModel;
  /** Initial token address for capital denomination */
  readonly initialToken?: string;
  /** Initial chain ID for capital denomination */
  readonly initialChainId?: number;
  /** Seed for deterministic slippage calculation */
  readonly seed?: number;
}

/**
 * A single point on the equity curve.
 */
export interface EquityPoint {
  readonly timestamp: number;
  /** Portfolio value in token smallest units */
  readonly portfolioValue: bigint;
}

/**
 * A recorded trade during backtesting.
 */
export interface TradeRecord {
  readonly id: string;
  readonly entryTimestamp: number;
  readonly exitTimestamp: number;
  readonly fromToken: string;
  readonly toToken: string;
  readonly fromChain: number;
  readonly toChain: number;
  readonly entryPrice: number;
  readonly exitPrice: number;
  readonly amount: bigint;
  readonly fillPrice: number;
  readonly fees: bigint;
  readonly pnl: bigint;
  readonly pnlPercent: number;
}

/**
 * Result of a completed backtest run.
 */
export interface BacktestResult {
  readonly startDate: number;
  readonly endDate: number;
  readonly initialCapital: bigint;
  readonly finalPortfolioValue: bigint;
  readonly equityCurve: EquityPoint[];
  readonly tradeLog: TradeRecord[];
  readonly totalTrades: number;
  readonly durationMs: number;
}

/**
 * A single historical data point for price/volume/apy data.
 */
export interface HistoricalDataPoint {
  readonly timestamp: number;
  readonly token: string;
  readonly chainId: number;
  readonly price: number;
  readonly volume: number;
  readonly apy?: number;
}
