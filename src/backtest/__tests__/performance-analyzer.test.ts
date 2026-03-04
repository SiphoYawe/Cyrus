import { describe, it, expect, beforeEach } from 'vitest';
import { PerformanceAnalyzer } from '../performance-analyzer.js';
import { Store } from '../../core/store.js';
import type {
  BacktestResult,
  EquityPoint,
  TradeRecord,
} from '../types.js';

// --- Test helpers ---

function makeEquityCurve(values: number[], startTimestamp: number = 0, intervalMs: number = 86400000): EquityPoint[] {
  return values.map((v, i) => ({
    timestamp: startTimestamp + i * intervalMs,
    portfolioValue: BigInt(Math.round(v * 1e6)), // scale to USDC-like units
  }));
}

function makeTrade(overrides: Partial<TradeRecord> & { pnl: bigint; pnlPercent: number }): TradeRecord {
  return {
    id: `trade-${Math.random().toString(36).slice(2, 8)}`,
    entryTimestamp: 0,
    exitTimestamp: 86400000,
    fromToken: '0xusdc',
    toToken: '0xweth',
    fromChain: 1,
    toChain: 1,
    entryPrice: 1.0,
    exitPrice: 1.1,
    amount: 1000000n,
    fillPrice: 1.1,
    fees: 1000n,
    ...overrides,
  };
}

function makeBacktestResult(overrides: Partial<BacktestResult> = {}): BacktestResult {
  const defaultEquityCurve = makeEquityCurve([100, 105, 110, 108, 115]);
  return {
    startDate: 0,
    endDate: 4 * 86400000,
    initialCapital: BigInt(100 * 1e6),
    finalPortfolioValue: BigInt(115 * 1e6),
    equityCurve: defaultEquityCurve,
    tradeLog: [],
    totalTrades: 0,
    durationMs: 1000,
    ...overrides,
  };
}

describe('PerformanceAnalyzer', () => {
  let analyzer: PerformanceAnalyzer;

  beforeEach(() => {
    Store.getInstance().reset();
    analyzer = new PerformanceAnalyzer(0.04, 365);
  });

  // --- Sharpe Ratio ---

  describe('calculateSharpeRatio', () => {
    it('should calculate Sharpe ratio with known return series', () => {
      // Known daily returns
      const returns = [0.01, 0.02, -0.005, 0.015, 0.008, -0.003, 0.012, 0.006, -0.002, 0.009];

      const sharpe = analyzer.calculateSharpeRatio(returns, 0.04);

      // The Sharpe should be positive since returns are mostly positive
      expect(sharpe).toBeGreaterThan(0);
      expect(Number.isFinite(sharpe)).toBe(true);

      // Manual verification:
      // mean = (0.01 + 0.02 - 0.005 + 0.015 + 0.008 - 0.003 + 0.012 + 0.006 - 0.002 + 0.009) / 10 = 0.007
      // periodicRiskFree = 0.04 / 365 ≈ 0.0001096
      // excessReturn = 0.007 - 0.0001096 ≈ 0.006890
      // stdDev of returns ≈ 0.00793
      // Sharpe = (0.006890 / 0.00793) * sqrt(365) ≈ 16.6
      expect(sharpe).toBeGreaterThan(10);
    });

    it('should return 0 for single return (no std dev)', () => {
      const returns = [0.05];
      const sharpe = analyzer.calculateSharpeRatio(returns, 0.04);
      expect(sharpe).toBe(0);
    });

    it('should return 0 for empty returns', () => {
      const sharpe = analyzer.calculateSharpeRatio([], 0.04);
      expect(sharpe).toBe(0);
    });

    it('should return 0 when all returns are identical (zero std dev)', () => {
      const returns = [0.01, 0.01, 0.01, 0.01];
      const sharpe = analyzer.calculateSharpeRatio(returns, 0.04);
      expect(sharpe).toBe(0);
    });
  });

  // --- Sortino Ratio ---

  describe('calculateSortinoRatio', () => {
    it('should calculate Sortino ratio using only negative returns for denominator', () => {
      // Mix of positive and negative returns
      const returns = [0.02, -0.01, 0.03, -0.02, 0.01, -0.005, 0.015, 0.008];

      const sortino = analyzer.calculateSortinoRatio(returns, 0.04);

      // Sortino should be positive since overall returns are positive
      expect(sortino).toBeGreaterThan(0);
      expect(Number.isFinite(sortino)).toBe(true);
    });

    it('should return higher value than Sharpe when there are few negative returns', () => {
      // Mostly positive returns with only one small negative
      const returns = [0.02, 0.03, 0.01, -0.001, 0.02, 0.015, 0.025];

      const sharpe = analyzer.calculateSharpeRatio(returns, 0.04);
      const sortino = analyzer.calculateSortinoRatio(returns, 0.04);

      // Sortino should be higher since downside deviation is smaller than total std dev
      expect(sortino).toBeGreaterThan(sharpe);
    });

    it('should return 0 for single return', () => {
      const sortino = analyzer.calculateSortinoRatio([0.05], 0.04);
      expect(sortino).toBe(0);
    });

    it('should return 0 when no downside returns exist', () => {
      // All returns above risk-free rate — downside deviation is 0
      const returns = [0.05, 0.06, 0.04, 0.07];
      const sortino = analyzer.calculateSortinoRatio(returns, 0.0);
      // With target = 0 and all positive returns, downside deviation is 0
      expect(sortino).toBe(0);
    });
  });

  // --- Max Drawdown ---

  describe('calculateMaxDrawdown', () => {
    it('should calculate max drawdown for known equity curve [100, 120, 90, 110, 80, 100]', () => {
      const equityCurve = makeEquityCurve([100, 120, 90, 110, 80, 100]);

      const { maxDrawdown } = analyzer.calculateMaxDrawdown(equityCurve);

      // Peak = 120, trough = 80, drawdown = (120-80)/120 = 33.33%
      expect(maxDrawdown).toBeCloseTo(1 / 3, 4); // 0.3333
    });

    it('should calculate max drawdown duration from peak to recovery', () => {
      // Day 0: 100 (peak)
      // Day 1: 120 (new peak)
      // Day 2: 90 (drawdown starts from day 1 peak)
      // Day 3: 110
      // Day 4: 80 (still in drawdown from day 1 peak of 120)
      // Day 5: 130 (recovery — new peak, drawdown ends)
      const equityCurve = makeEquityCurve([100, 120, 90, 110, 80, 130]);

      const { maxDrawdownDuration } = analyzer.calculateMaxDrawdown(equityCurve);

      // Drawdown: from day 1 timestamp to day 5 timestamp = 4 days
      expect(maxDrawdownDuration).toBe(4 * 86400000);
    });

    it('should count duration to end of curve if no recovery', () => {
      // Peak at day 1, never recovers
      const equityCurve = makeEquityCurve([100, 120, 90, 85, 80]);

      const { maxDrawdownDuration } = analyzer.calculateMaxDrawdown(equityCurve);

      // Drawdown from day 1 to day 4 = 3 days
      expect(maxDrawdownDuration).toBe(3 * 86400000);
    });

    it('should return 0 for monotonically increasing curve', () => {
      const equityCurve = makeEquityCurve([100, 110, 120, 130, 140]);

      const { maxDrawdown, maxDrawdownDuration } = analyzer.calculateMaxDrawdown(equityCurve);

      expect(maxDrawdown).toBe(0);
      expect(maxDrawdownDuration).toBe(0);
    });

    it('should return 0 for insufficient data', () => {
      const equityCurve = makeEquityCurve([100]);

      const { maxDrawdown, maxDrawdownDuration } = analyzer.calculateMaxDrawdown(equityCurve);

      expect(maxDrawdown).toBe(0);
      expect(maxDrawdownDuration).toBe(0);
    });
  });

  // --- Win Rate ---

  describe('calculateWinRate', () => {
    it('should calculate win rate: 7 winners, 3 losers = 0.7', () => {
      const trades: TradeRecord[] = [
        ...Array.from({ length: 7 }, () => makeTrade({ pnl: 100n, pnlPercent: 0.1 })),
        ...Array.from({ length: 3 }, () => makeTrade({ pnl: -50n, pnlPercent: -0.05 })),
      ];

      const winRate = analyzer.calculateWinRate(trades);

      expect(winRate).toBeCloseTo(0.7, 5);
    });

    it('should return 0 for zero trades', () => {
      expect(analyzer.calculateWinRate([])).toBe(0);
    });

    it('should return 1 for all winning trades', () => {
      const trades = Array.from({ length: 5 }, () => makeTrade({ pnl: 100n, pnlPercent: 0.1 }));
      expect(analyzer.calculateWinRate(trades)).toBe(1);
    });

    it('should return 0 for all losing trades', () => {
      const trades = Array.from({ length: 5 }, () => makeTrade({ pnl: -100n, pnlPercent: -0.1 }));
      expect(analyzer.calculateWinRate(trades)).toBe(0);
    });
  });

  // --- Profit Factor ---

  describe('calculateProfitFactor', () => {
    it('should calculate profit factor: gross profits 1000, gross losses 500 = 2.0', () => {
      const trades = [
        makeTrade({ pnl: 600n, pnlPercent: 0.06 }),
        makeTrade({ pnl: 400n, pnlPercent: 0.04 }),
        makeTrade({ pnl: -300n, pnlPercent: -0.03 }),
        makeTrade({ pnl: -200n, pnlPercent: -0.02 }),
      ];

      const profitFactor = analyzer.calculateProfitFactor(trades);

      expect(profitFactor).toBeCloseTo(2.0, 5);
    });

    it('should cap at 999 when no losses', () => {
      const trades = [
        makeTrade({ pnl: 500n, pnlPercent: 0.05 }),
        makeTrade({ pnl: 300n, pnlPercent: 0.03 }),
      ];

      const profitFactor = analyzer.calculateProfitFactor(trades);

      expect(profitFactor).toBe(999);
    });

    it('should return 0 for zero trades', () => {
      expect(analyzer.calculateProfitFactor([])).toBe(0);
    });

    it('should return 0 for all zero-pnl trades', () => {
      const trades = [
        makeTrade({ pnl: 0n, pnlPercent: 0 }),
        makeTrade({ pnl: 0n, pnlPercent: 0 }),
      ];
      expect(analyzer.calculateProfitFactor(trades)).toBe(0);
    });
  });

  // --- Calmar Ratio ---

  describe('calculateCalmarRatio', () => {
    it('should calculate Calmar ratio: annualized return 0.2, max drawdown 0.1 = 2.0', () => {
      const calmar = analyzer.calculateCalmarRatio(0.2, 0.1);
      expect(calmar).toBeCloseTo(2.0, 5);
    });

    it('should return 0 when max drawdown is 0', () => {
      const calmar = analyzer.calculateCalmarRatio(0.2, 0);
      expect(calmar).toBe(0);
    });

    it('should handle negative annualized return', () => {
      const calmar = analyzer.calculateCalmarRatio(-0.1, 0.2);
      expect(calmar).toBeCloseTo(-0.5, 5);
    });
  });

  // --- Total Return ---

  describe('calculateTotalReturn', () => {
    it('should calculate fractional total return', () => {
      const totalReturn = analyzer.calculateTotalReturn(1000000n, 1250000n);
      expect(totalReturn).toBeCloseTo(0.25, 5);
    });

    it('should handle losses', () => {
      const totalReturn = analyzer.calculateTotalReturn(1000000n, 800000n);
      expect(totalReturn).toBeCloseTo(-0.2, 5);
    });

    it('should return 0 for zero initial capital', () => {
      const totalReturn = analyzer.calculateTotalReturn(0n, 100n);
      expect(totalReturn).toBe(0);
    });
  });

  // --- Edge Cases: analyze() ---

  describe('analyze edge cases', () => {
    it('should return zeroed metrics for zero trades', () => {
      const result = makeBacktestResult({
        totalTrades: 0,
        tradeLog: [],
      });

      const metrics = analyzer.analyze(result);

      expect(metrics.sharpeRatio).toBe(0);
      expect(metrics.sortinoRatio).toBe(0);
      expect(metrics.maxDrawdown).toBe(0);
      expect(metrics.maxDrawdownDuration).toBe(0);
      expect(metrics.winRate).toBe(0);
      expect(metrics.profitFactor).toBe(0);
      expect(metrics.calmarRatio).toBe(0);
      expect(metrics.totalTrades).toBe(0);
      expect(Number.isFinite(metrics.totalReturn)).toBe(true);
      expect(Number.isNaN(metrics.totalReturn)).toBe(false);
    });

    it('should return valid metrics for single trade (Sharpe = 0)', () => {
      const equityCurve = makeEquityCurve([100, 110]);
      const trades = [makeTrade({ pnl: 100n, pnlPercent: 0.1 })];
      const result = makeBacktestResult({
        equityCurve,
        tradeLog: trades,
        totalTrades: 1,
        initialCapital: BigInt(100 * 1e6),
        finalPortfolioValue: BigInt(110 * 1e6),
      });

      const metrics = analyzer.analyze(result);

      // Single return means Sharpe = 0 (insufficient data for std dev)
      expect(metrics.sharpeRatio).toBe(0);
      expect(metrics.sortinoRatio).toBe(0);
      expect(metrics.winRate).toBe(1);
      expect(metrics.totalTrades).toBe(1);
      expect(Number.isFinite(metrics.totalReturn)).toBe(true);
      expect(Number.isNaN(metrics.sharpeRatio)).toBe(false);
    });

    it('should handle no losses (profit factor = 999)', () => {
      const equityCurve = makeEquityCurve([100, 105, 110, 115, 120]);
      const trades = [
        makeTrade({ pnl: 500n, pnlPercent: 0.05 }),
        makeTrade({ pnl: 500n, pnlPercent: 0.05 }),
        makeTrade({ pnl: 500n, pnlPercent: 0.05 }),
      ];

      const result = makeBacktestResult({
        equityCurve,
        tradeLog: trades,
        totalTrades: 3,
      });

      const metrics = analyzer.analyze(result);

      expect(metrics.profitFactor).toBe(999);
      expect(metrics.winRate).toBe(1);
    });

    it('should not produce NaN or Infinity for any metric', () => {
      const equityCurve = makeEquityCurve([100, 100, 100, 100]);
      const result = makeBacktestResult({
        equityCurve,
        tradeLog: [makeTrade({ pnl: 0n, pnlPercent: 0 })],
        totalTrades: 1,
        initialCapital: BigInt(100 * 1e6),
        finalPortfolioValue: BigInt(100 * 1e6),
      });

      const metrics = analyzer.analyze(result);

      for (const [key, value] of Object.entries(metrics)) {
        expect(Number.isNaN(value)).toBe(false);
        expect(Number.isFinite(value)).toBe(true);
      }
    });
  });

  // --- Drawdown Curve ---

  describe('generateDrawdownCurve', () => {
    it('should generate drawdown curve matching expected underwater pattern', () => {
      const equityCurve = makeEquityCurve([100, 120, 90, 110, 80, 130]);
      const drawdown = analyzer.generateDrawdownCurve(equityCurve);

      expect(drawdown.length).toBe(6);

      // Day 0: 100 (peak=100), drawdown = 0
      expect(drawdown[0].drawdown).toBeCloseTo(0, 5);

      // Day 1: 120 (new peak=120), drawdown = 0
      expect(drawdown[1].drawdown).toBeCloseTo(0, 5);

      // Day 2: 90 (peak=120), drawdown = (90-120)/120 = -0.25
      expect(drawdown[2].drawdown).toBeCloseTo(-0.25, 5);

      // Day 3: 110 (peak=120), drawdown = (110-120)/120 = -0.0833
      expect(drawdown[3].drawdown).toBeCloseTo(-1 / 12, 4);

      // Day 4: 80 (peak=120), drawdown = (80-120)/120 = -0.3333
      expect(drawdown[4].drawdown).toBeCloseTo(-1 / 3, 4);

      // Day 5: 130 (new peak=130), drawdown = 0
      expect(drawdown[5].drawdown).toBeCloseTo(0, 5);
    });

    it('should return empty array for empty equity curve', () => {
      expect(analyzer.generateDrawdownCurve([])).toEqual([]);
    });

    it('should return all zeros for monotonically increasing curve', () => {
      const equityCurve = makeEquityCurve([100, 110, 120, 130]);
      const drawdown = analyzer.generateDrawdownCurve(equityCurve);
      for (const point of drawdown) {
        expect(point.drawdown).toBeCloseTo(0, 5);
      }
    });

    it('should have drawdowns sorted by timestamp', () => {
      const equityCurve = makeEquityCurve([100, 90, 80, 85, 95]);
      const drawdown = analyzer.generateDrawdownCurve(equityCurve);
      for (let i = 1; i < drawdown.length; i++) {
        expect(drawdown[i].timestamp).toBeGreaterThan(drawdown[i - 1].timestamp);
      }
    });
  });

  // --- Monthly Returns ---

  describe('generateMonthlyReturns', () => {
    it('should compute monthly returns covering all months in the backtest period', () => {
      // Create equity curve spanning 3 months (Jan, Feb, Mar 2024)
      const jan1 = new Date('2024-01-01T00:00:00Z').getTime();
      const feb1 = new Date('2024-02-01T00:00:00Z').getTime();
      const mar1 = new Date('2024-03-01T00:00:00Z').getTime();
      const mar31 = new Date('2024-03-31T00:00:00Z').getTime();

      const equityCurve: EquityPoint[] = [
        { timestamp: jan1, portfolioValue: 1000000n },
        { timestamp: jan1 + 15 * 86400000, portfolioValue: 1050000n }, // mid Jan
        { timestamp: feb1, portfolioValue: 1100000n },
        { timestamp: feb1 + 14 * 86400000, portfolioValue: 1080000n }, // mid Feb
        { timestamp: mar1, portfolioValue: 1150000n },
        { timestamp: mar31, portfolioValue: 1200000n },
      ];

      const monthlyReturns = analyzer.generateMonthlyReturns(equityCurve);

      expect(monthlyReturns.length).toBe(3);

      // January: first=1000000, last=1050000 (Feb 1 is a new month)
      // Actually, we have points at jan1 and jan1+15d — both in January
      // And feb1 starts February
      expect(monthlyReturns[0].year).toBe(2024);
      expect(monthlyReturns[0].month).toBe(1);
      expect(monthlyReturns[0].return).toBeCloseTo(0.05, 4); // (1050000-1000000)/1000000

      // February: first=1100000, last=1080000
      expect(monthlyReturns[1].year).toBe(2024);
      expect(monthlyReturns[1].month).toBe(2);

      // March
      expect(monthlyReturns[2].year).toBe(2024);
      expect(monthlyReturns[2].month).toBe(3);
    });

    it('should return empty array for insufficient data', () => {
      const equityCurve = makeEquityCurve([100]);
      expect(analyzer.generateMonthlyReturns(equityCurve)).toEqual([]);
    });

    it('should sort by year then month', () => {
      // Create equity curve spanning year boundary
      const dec = new Date('2023-12-15T00:00:00Z').getTime();
      const jan = new Date('2024-01-15T00:00:00Z').getTime();

      const equityCurve: EquityPoint[] = [
        { timestamp: dec, portfolioValue: 1000000n },
        { timestamp: jan, portfolioValue: 1100000n },
      ];

      const monthlyReturns = analyzer.generateMonthlyReturns(equityCurve);
      expect(monthlyReturns.length).toBe(2);
      expect(monthlyReturns[0].year).toBe(2023);
      expect(monthlyReturns[0].month).toBe(12);
      expect(monthlyReturns[1].year).toBe(2024);
      expect(monthlyReturns[1].month).toBe(1);
    });
  });

  // --- Trade Distribution ---

  describe('generateTradeDistribution', () => {
    it('should bucket trades into correct histogram bins', () => {
      const trades = [
        makeTrade({ pnl: 100n, pnlPercent: 0.10 }),
        makeTrade({ pnl: 200n, pnlPercent: 0.20 }),
        makeTrade({ pnl: -50n, pnlPercent: -0.05 }),
        makeTrade({ pnl: -100n, pnlPercent: -0.10 }),
        makeTrade({ pnl: 50n, pnlPercent: 0.05 }),
      ];

      const distribution = analyzer.generateTradeDistribution(trades, 5);

      // Should have 5 buckets
      expect(distribution.length).toBe(5);

      // Total count across all buckets should equal trade count
      const totalCount = distribution.reduce((sum, b) => sum + b.count, 0);
      expect(totalCount).toBe(5);

      // Buckets should be ordered by rangeMin
      for (let i = 1; i < distribution.length; i++) {
        expect(distribution[i].rangeMin).toBeGreaterThanOrEqual(distribution[i - 1].rangeMin);
      }
    });

    it('should return empty array for no trades', () => {
      expect(analyzer.generateTradeDistribution([])).toEqual([]);
    });

    it('should handle single bucket for identical P&L', () => {
      const trades = [
        makeTrade({ pnl: 100n, pnlPercent: 0.1 }),
        makeTrade({ pnl: 100n, pnlPercent: 0.1 }),
      ];

      const distribution = analyzer.generateTradeDistribution(trades);
      expect(distribution.length).toBe(1);
      expect(distribution[0].count).toBe(2);
    });
  });

  // --- Generate Report ---

  describe('generateReport', () => {
    it('should generate a complete report with all sections', () => {
      const equityCurve = makeEquityCurve([100, 105, 110, 108, 115, 120]);
      const trades = [
        makeTrade({ pnl: 500n, pnlPercent: 0.05 }),
        makeTrade({ pnl: -200n, pnlPercent: -0.02 }),
        makeTrade({ pnl: 300n, pnlPercent: 0.03 }),
      ];

      const result = makeBacktestResult({
        equityCurve,
        tradeLog: trades,
        totalTrades: 3,
        initialCapital: BigInt(100 * 1e6),
        finalPortfolioValue: BigInt(120 * 1e6),
      });

      const report = analyzer.generateReport(result);

      expect(report.metrics).toBeDefined();
      expect(report.equityCurveData.length).toBe(6);
      expect(report.drawdownCurveData.length).toBe(6);
      expect(report.tradeDistribution.length).toBeGreaterThan(0);
      expect(report.summaryTable).toBeDefined();
      expect(report.summaryTable['Sharpe Ratio']).toBeDefined();
      expect(report.summaryTable['Total Trades']).toBe(3);
    });

    it('should sort equity curve data by timestamp', () => {
      const equityCurve = makeEquityCurve([100, 110, 120]);
      const result = makeBacktestResult({
        equityCurve,
        tradeLog: [makeTrade({ pnl: 100n, pnlPercent: 0.1 })],
        totalTrades: 1,
      });

      const report = analyzer.generateReport(result);

      for (let i = 1; i < report.equityCurveData.length; i++) {
        expect(report.equityCurveData[i].timestamp).toBeGreaterThanOrEqual(
          report.equityCurveData[i - 1].timestamp,
        );
      }
    });
  });

  // --- Summary Table ---

  describe('generateSummaryTable', () => {
    it('should format metrics with human-readable labels', () => {
      const equityCurve = makeEquityCurve([100, 110, 105, 120]);
      const trades = [
        makeTrade({ pnl: 500n, pnlPercent: 0.05 }),
        makeTrade({ pnl: -200n, pnlPercent: -0.02 }),
      ];

      const result = makeBacktestResult({
        equityCurve,
        tradeLog: trades,
        totalTrades: 2,
        initialCapital: BigInt(100 * 1e6),
        finalPortfolioValue: BigInt(120 * 1e6),
      });

      const metrics = analyzer.analyze(result);
      const table = analyzer.generateSummaryTable(metrics);

      expect(table['Sharpe Ratio']).toBeDefined();
      expect(table['Sortino Ratio']).toBeDefined();
      expect(table['Max Drawdown']).toBeDefined();
      expect(table['Win Rate']).toBeDefined();
      expect(table['Profit Factor']).toBeDefined();
      expect(table['Calmar Ratio']).toBeDefined();
      expect(table['Total Return']).toBeDefined();
      expect(table['Total Trades']).toBe(2);
      expect(table['Annualized Return']).toBeDefined();
    });
  });
});
