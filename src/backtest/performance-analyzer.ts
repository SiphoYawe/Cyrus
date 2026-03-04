// PerformanceAnalyzer — computes institutional-grade performance metrics from backtest results

import { createLogger } from '../utils/logger.js';
import type {
  BacktestResult,
  EquityPoint,
  TradeRecord,
  PerformanceMetrics,
  BacktestReport,
  DrawdownPoint,
  HistogramBucket,
  MonthlyReturnEntry,
} from './types.js';

const logger = createLogger('performance-analyzer');

/**
 * PerformanceAnalyzer computes performance metrics and report data from a BacktestResult.
 *
 * Pure computation class: no side effects, no I/O, no state.
 * Takes a BacktestResult and produces PerformanceMetrics or a full BacktestReport.
 */
export class PerformanceAnalyzer {
  /** Annualized risk-free rate (e.g., 0.04 = 4%) */
  private readonly riskFreeRate: number;
  /** Annualization factor for returns (e.g., 365 for daily) */
  private readonly annualizationFactor: number;

  constructor(riskFreeRate: number = 0.04, annualizationFactor: number = 365) {
    this.riskFreeRate = riskFreeRate;
    this.annualizationFactor = annualizationFactor;
  }

  /**
   * Main entry point: compute all performance metrics from a BacktestResult.
   */
  analyze(result: BacktestResult): PerformanceMetrics {
    // Edge case: zero trades
    if (result.totalTrades === 0 || result.equityCurve.length < 2) {
      return this.zeroedMetrics(result);
    }

    const returns = this.calculateReturns(result.equityCurve);
    const totalReturn = this.calculateTotalReturn(result.initialCapital, result.finalPortfolioValue);
    const annualizedReturn = this.calculateAnnualizedReturn(totalReturn, result.startDate, result.endDate);
    const sharpeRatio = this.calculateSharpeRatio(returns, this.riskFreeRate);
    const sortinoRatio = this.calculateSortinoRatio(returns, this.riskFreeRate);
    const { maxDrawdown, maxDrawdownDuration } = this.calculateMaxDrawdown(result.equityCurve);
    const winRate = this.calculateWinRate(result.tradeLog);
    const profitFactor = this.calculateProfitFactor(result.tradeLog);
    const calmarRatio = this.calculateCalmarRatio(annualizedReturn, maxDrawdown);

    return {
      sharpeRatio,
      sortinoRatio,
      maxDrawdown,
      maxDrawdownDuration,
      winRate,
      profitFactor,
      calmarRatio,
      totalReturn,
      totalTrades: result.totalTrades,
      annualizedReturn,
    };
  }

  /**
   * Generate a full backtest report with chart data and summary table.
   */
  generateReport(result: BacktestResult): BacktestReport {
    const metrics = this.analyze(result);
    const drawdownCurveData = this.generateDrawdownCurve(result.equityCurve);
    const tradeDistribution = this.generateTradeDistribution(result.tradeLog);
    const monthlyReturns = this.generateMonthlyReturns(result.equityCurve);
    const summaryTable = this.generateSummaryTable(metrics);

    return {
      metrics,
      equityCurveData: [...result.equityCurve].sort((a, b) => a.timestamp - b.timestamp),
      drawdownCurveData,
      tradeDistribution,
      monthlyReturns,
      summaryTable,
    };
  }

  /**
   * Compute period-over-period returns from the equity curve.
   * Returns an array of fractional returns (e.g., 0.05 = 5% gain).
   */
  calculateReturns(equityCurve: EquityPoint[]): number[] {
    if (equityCurve.length < 2) return [];

    const returns: number[] = [];
    for (let i = 1; i < equityCurve.length; i++) {
      const prev = Number(equityCurve[i - 1].portfolioValue);
      const curr = Number(equityCurve[i].portfolioValue);
      if (prev === 0) {
        returns.push(0);
      } else {
        returns.push((curr - prev) / prev);
      }
    }
    return returns;
  }

  /**
   * Calculate annualized Sharpe ratio.
   * Formula: (meanReturn - riskFreeRate/periods) / stdDev(returns) * sqrt(annualizationFactor)
   *
   * Returns 0 for single return or zero std dev.
   */
  calculateSharpeRatio(returns: number[], riskFreeRate: number): number {
    if (returns.length < 2) return 0;

    const mean = this.mean(returns);
    const stdDev = this.stdDev(returns);

    if (stdDev === 0) return 0;

    const periodicRiskFree = riskFreeRate / this.annualizationFactor;
    const excessReturn = mean - periodicRiskFree;

    return (excessReturn / stdDev) * Math.sqrt(this.annualizationFactor);
  }

  /**
   * Calculate annualized Sortino ratio.
   * Same as Sharpe but denominator is downside deviation (only negative returns contribute).
   *
   * Returns 0 for single return or zero downside deviation.
   */
  calculateSortinoRatio(returns: number[], riskFreeRate: number): number {
    if (returns.length < 2) return 0;

    const mean = this.mean(returns);
    const periodicRiskFree = riskFreeRate / this.annualizationFactor;
    const excessReturn = mean - periodicRiskFree;

    const downsideDeviation = this.downsideDeviation(returns, periodicRiskFree);

    if (downsideDeviation === 0) return 0;

    return (excessReturn / downsideDeviation) * Math.sqrt(this.annualizationFactor);
  }

  /**
   * Calculate maximum drawdown and its duration.
   *
   * Max drawdown: (peak - trough) / peak — the largest peak-to-trough decline.
   * Duration: from drawdown start to recovery (or end of curve if no recovery), in milliseconds.
   */
  calculateMaxDrawdown(equityCurve: EquityPoint[]): {
    maxDrawdown: number;
    maxDrawdownDuration: number;
  } {
    if (equityCurve.length < 2) {
      return { maxDrawdown: 0, maxDrawdownDuration: 0 };
    }

    let peak = Number(equityCurve[0].portfolioValue);
    let peakTimestamp = equityCurve[0].timestamp;
    let maxDrawdown = 0;
    let maxDrawdownDuration = 0;

    // Track the current drawdown period
    let drawdownStartTimestamp = equityCurve[0].timestamp;
    let inDrawdown = false;

    for (let i = 1; i < equityCurve.length; i++) {
      const currentValue = Number(equityCurve[i].portfolioValue);
      const currentTimestamp = equityCurve[i].timestamp;

      if (currentValue >= peak) {
        // Recovered from drawdown or new peak
        if (inDrawdown) {
          const duration = currentTimestamp - drawdownStartTimestamp;
          if (duration > maxDrawdownDuration) {
            maxDrawdownDuration = duration;
          }
          inDrawdown = false;
        }
        peak = currentValue;
        peakTimestamp = currentTimestamp;
      } else {
        // In a drawdown
        if (!inDrawdown) {
          drawdownStartTimestamp = peakTimestamp;
          inDrawdown = true;
        }

        const drawdown = (peak - currentValue) / peak;
        if (drawdown > maxDrawdown) {
          maxDrawdown = drawdown;
        }
      }
    }

    // If still in drawdown at end of curve, count duration to end
    if (inDrawdown) {
      const duration = equityCurve[equityCurve.length - 1].timestamp - drawdownStartTimestamp;
      if (duration > maxDrawdownDuration) {
        maxDrawdownDuration = duration;
      }
    }

    return { maxDrawdown, maxDrawdownDuration };
  }

  /**
   * Calculate win rate: count of profitable trades / total trades.
   * Returns 0 for zero trades.
   */
  calculateWinRate(tradeLog: TradeRecord[]): number {
    if (tradeLog.length === 0) return 0;

    const winners = tradeLog.filter((t) => t.pnl > 0n).length;
    return winners / tradeLog.length;
  }

  /**
   * Calculate profit factor: gross profits / gross losses (absolute values).
   * Capped at 999 when there are no losses.
   * Returns 0 for zero trades.
   */
  calculateProfitFactor(tradeLog: TradeRecord[]): number {
    if (tradeLog.length === 0) return 0;

    let grossProfits = 0n;
    let grossLosses = 0n;

    for (const trade of tradeLog) {
      if (trade.pnl > 0n) {
        grossProfits += trade.pnl;
      } else if (trade.pnl < 0n) {
        grossLosses += -trade.pnl; // absolute value
      }
    }

    if (grossLosses === 0n) {
      return grossProfits > 0n ? 999 : 0;
    }

    return Number(grossProfits) / Number(grossLosses);
  }

  /**
   * Calculate Calmar ratio: annualized return / |max drawdown|.
   * Returns 0 if max drawdown is 0.
   */
  calculateCalmarRatio(annualizedReturn: number, maxDrawdown: number): number {
    if (maxDrawdown === 0) return 0;
    return annualizedReturn / Math.abs(maxDrawdown);
  }

  /**
   * Calculate total return as a fractional value.
   * (finalValue - initialCapital) / initialCapital
   */
  calculateTotalReturn(initialCapital: bigint, finalValue: bigint): number {
    if (initialCapital === 0n) return 0;
    return Number(finalValue - initialCapital) / Number(initialCapital);
  }

  /**
   * Generate a drawdown (underwater equity) curve.
   * For each point, computes (currentValue - peakValue) / peakValue.
   */
  generateDrawdownCurve(equityCurve: EquityPoint[]): DrawdownPoint[] {
    if (equityCurve.length === 0) return [];

    const sorted = [...equityCurve].sort((a, b) => a.timestamp - b.timestamp);
    const drawdownCurve: DrawdownPoint[] = [];
    let peak = Number(sorted[0].portfolioValue);

    for (const point of sorted) {
      const currentValue = Number(point.portfolioValue);
      if (currentValue > peak) {
        peak = currentValue;
      }

      const drawdown = peak === 0 ? 0 : (currentValue - peak) / peak;
      drawdownCurve.push({
        timestamp: point.timestamp,
        drawdown,
      });
    }

    return drawdownCurve;
  }

  /**
   * Generate trade P&L distribution histogram.
   * Buckets P&L percent values into equal-width bins.
   */
  generateTradeDistribution(tradeLog: TradeRecord[], bucketCount: number = 10): HistogramBucket[] {
    if (tradeLog.length === 0) return [];

    const pnlValues = tradeLog.map((t) => t.pnlPercent);
    const min = Math.min(...pnlValues);
    const max = Math.max(...pnlValues);

    // Handle case where all trades have the same P&L
    if (min === max) {
      return [{ rangeMin: min, rangeMax: max, count: tradeLog.length }];
    }

    const bucketWidth = (max - min) / bucketCount;
    const buckets: HistogramBucket[] = [];

    for (let i = 0; i < bucketCount; i++) {
      const rangeMin = min + i * bucketWidth;
      const rangeMax = i === bucketCount - 1 ? max : min + (i + 1) * bucketWidth;
      const count = pnlValues.filter((v) => {
        if (i === bucketCount - 1) {
          return v >= rangeMin && v <= rangeMax;
        }
        return v >= rangeMin && v < rangeMax;
      }).length;

      buckets.push({ rangeMin, rangeMax, count });
    }

    return buckets;
  }

  /**
   * Generate monthly returns from the equity curve.
   * Computes the return for each calendar month.
   */
  generateMonthlyReturns(equityCurve: EquityPoint[]): MonthlyReturnEntry[] {
    if (equityCurve.length < 2) return [];

    const sorted = [...equityCurve].sort((a, b) => a.timestamp - b.timestamp);

    // Group equity points by year-month
    const monthlyData = new Map<string, { first: bigint; last: bigint }>();

    for (const point of sorted) {
      const date = new Date(point.timestamp);
      const year = date.getUTCFullYear();
      const month = date.getUTCMonth() + 1; // 1-indexed
      const key = `${year}-${month}`;

      const existing = monthlyData.get(key);
      if (!existing) {
        monthlyData.set(key, { first: point.portfolioValue, last: point.portfolioValue });
      } else {
        existing.last = point.portfolioValue;
      }
    }

    const entries: MonthlyReturnEntry[] = [];
    for (const [key, data] of monthlyData) {
      const [yearStr, monthStr] = key.split('-');
      const year = Number(yearStr);
      const month = Number(monthStr);
      const returnVal = data.first === 0n
        ? 0
        : Number(data.last - data.first) / Number(data.first);

      entries.push({ year, month, return: returnVal });
    }

    // Sort by year then month
    entries.sort((a, b) => a.year !== b.year ? a.year - b.year : a.month - b.month);

    return entries;
  }

  /**
   * Generate a summary table with human-readable labels and formatted values.
   */
  generateSummaryTable(metrics: PerformanceMetrics): Record<string, string | number> {
    return {
      'Sharpe Ratio': Number(metrics.sharpeRatio.toFixed(2)),
      'Sortino Ratio': Number(metrics.sortinoRatio.toFixed(2)),
      'Max Drawdown': `${(metrics.maxDrawdown * -100).toFixed(1)}%`,
      'Max Drawdown Duration (days)': Number((metrics.maxDrawdownDuration / 86400000).toFixed(1)),
      'Win Rate': `${(metrics.winRate * 100).toFixed(1)}%`,
      'Profit Factor': Number(metrics.profitFactor.toFixed(2)),
      'Calmar Ratio': Number(metrics.calmarRatio.toFixed(2)),
      'Total Return': `${(metrics.totalReturn * 100).toFixed(2)}%`,
      'Total Trades': metrics.totalTrades,
      'Annualized Return': `${(metrics.annualizedReturn * 100).toFixed(2)}%`,
    };
  }

  // --- Private helper methods ---

  /**
   * Return zeroed metrics for edge cases (zero trades, insufficient data).
   */
  private zeroedMetrics(result: BacktestResult): PerformanceMetrics {
    const totalReturn = this.calculateTotalReturn(result.initialCapital, result.finalPortfolioValue);
    return {
      sharpeRatio: 0,
      sortinoRatio: 0,
      maxDrawdown: 0,
      maxDrawdownDuration: 0,
      winRate: 0,
      profitFactor: 0,
      calmarRatio: 0,
      totalReturn,
      totalTrades: 0,
      annualizedReturn: 0,
    };
  }

  /**
   * Calculate annualized return from total return and date range.
   */
  private calculateAnnualizedReturn(totalReturn: number, startDate: number, endDate: number): number {
    const durationMs = endDate - startDate;
    if (durationMs <= 0) return 0;

    const years = durationMs / (365.25 * 24 * 60 * 60 * 1000);
    if (years <= 0) return 0;

    // Compound annualization: (1 + totalReturn)^(1/years) - 1
    const base = 1 + totalReturn;
    if (base <= 0) return -1; // total loss or worse
    return Math.pow(base, 1 / years) - 1;
  }

  /** Arithmetic mean of an array of numbers. */
  private mean(values: number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((sum, v) => sum + v, 0) / values.length;
  }

  /** Population standard deviation. */
  private stdDev(values: number[]): number {
    if (values.length < 2) return 0;
    const avg = this.mean(values);
    const squaredDiffs = values.map((v) => (v - avg) ** 2);
    return Math.sqrt(squaredDiffs.reduce((sum, v) => sum + v, 0) / values.length);
  }

  /**
   * Downside deviation — sqrt of mean of squared negative deviations from target.
   * Only returns below the target contribute.
   */
  private downsideDeviation(returns: number[], target: number): number {
    const downsideSquared = returns.map((r) => {
      const diff = r - target;
      return diff < 0 ? diff * diff : 0;
    });

    const meanDownside = downsideSquared.reduce((sum, v) => sum + v, 0) / returns.length;
    return Math.sqrt(meanDownside);
  }
}
