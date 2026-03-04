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

// --- Performance Analytics & Optimization Types (Story 8.2) ---

/**
 * Computed performance metrics from a backtest run.
 * All fractional values (e.g., 0.15 = 15%).
 */
export interface PerformanceMetrics {
  readonly sharpeRatio: number;
  readonly sortinoRatio: number;
  /** Fractional, positive (e.g., 0.12 = 12% drawdown) */
  readonly maxDrawdown: number;
  /** Duration of the max drawdown period in milliseconds */
  readonly maxDrawdownDuration: number;
  /** Fractional win rate (e.g., 0.7 = 70%) */
  readonly winRate: number;
  /** Gross profits / gross losses. Capped at 999 when no losses. */
  readonly profitFactor: number;
  /** Annualized return / max drawdown */
  readonly calmarRatio: number;
  /** Fractional total return (e.g., 0.25 = 25%) */
  readonly totalReturn: number;
  readonly totalTrades: number;
  /** Fractional annualized return */
  readonly annualizedReturn: number;
}

/**
 * Full backtest report with metrics and chart data.
 */
export interface BacktestReport {
  readonly metrics: PerformanceMetrics;
  readonly equityCurveData: EquityPoint[];
  readonly drawdownCurveData: DrawdownPoint[];
  readonly tradeDistribution: HistogramBucket[];
  readonly monthlyReturns: MonthlyReturnEntry[];
  readonly summaryTable: Record<string, string | number>;
}

/**
 * A single point on the drawdown (underwater) curve.
 */
export interface DrawdownPoint {
  readonly timestamp: number;
  /** Fractional drawdown, negative (e.g., -0.05 = -5% below peak) */
  readonly drawdown: number;
}

/**
 * A single bucket in a histogram (e.g., trade P&L distribution).
 */
export interface HistogramBucket {
  readonly rangeMin: number;
  readonly rangeMax: number;
  readonly count: number;
}

/**
 * A single entry in the monthly returns matrix.
 */
export interface MonthlyReturnEntry {
  readonly year: number;
  readonly month: number;
  /** Fractional return for this month */
  readonly return: number;
}

/**
 * Parameter grid for optimization: maps parameter names to arrays of candidate values.
 */
export type ParameterGrid = Record<string, number[]>;

/**
 * Result of an optimization run (grid search or walk-forward).
 */
export interface OptimizationResult {
  readonly parameterSets: RankedParameterSet[];
  readonly totalCombinations: number;
  readonly durationMs: number;
  readonly bestSharpe: number;
  readonly overfittingWarnings: OverfittingWarning[];
}

/**
 * A ranked parameter set from optimization results.
 */
export interface RankedParameterSet {
  readonly rank: number;
  readonly parameters: Record<string, number>;
  readonly inSampleMetrics: PerformanceMetrics;
  readonly outOfSampleMetrics?: PerformanceMetrics;
  readonly overfitting: boolean;
}

/**
 * Warning when a parameter set shows overfitting behavior.
 */
export interface OverfittingWarning {
  readonly parameters: Record<string, number>;
  readonly inSampleSharpe: number;
  readonly outOfSampleSharpe: number;
  /** Fractional Sharpe drop (e.g., 0.6 = 60% degradation) */
  readonly sharpeDrop: number;
}

/**
 * Configuration for walk-forward optimization.
 */
export interface WalkForwardConfig {
  /** Fractional ratio of in-sample data (e.g., 0.7 = 70% training) */
  readonly inSampleRatio: number;
  /** Number of walk-forward windows */
  readonly windowCount: number;
  /** If true, in-sample always starts from the beginning (expanding window) */
  readonly anchoredStart: boolean;
}
