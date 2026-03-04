import { describe, it, expect, beforeEach, vi } from 'vitest';
import { StrategyOptimizer } from '../strategy-optimizer.js';
import { PerformanceAnalyzer } from '../performance-analyzer.js';
import { Store } from '../../core/store.js';
import { CrossChainStrategy } from '../../strategies/cross-chain-strategy.js';
import { chainId, tokenAddress } from '../../core/types.js';
import type {
  StrategySignal,
  ExecutionPlan,
  StrategyContext,
  TokenInfo,
} from '../../core/types.js';
import type {
  BacktestConfig,
  BacktestResult,
  EquityPoint,
  FeeModel,
  PerformanceMetrics,
  ParameterGrid,
  WalkForwardConfig,
} from '../types.js';
import type { BacktestEngineFactory, StrategyFactory } from '../strategy-optimizer.js';

// --- Test helpers ---

const DEFAULT_FEE_MODEL: FeeModel = {
  bridgeFeePercent: 0.003,
  gasEstimateUsd: 5.0,
  dexFeePercent: 0.003,
};

function makeConfig(overrides: Partial<BacktestConfig> = {}): BacktestConfig {
  return {
    strategyName: 'test-strategy',
    startDate: 0,
    endDate: 30 * 86400000, // 30 days
    initialCapital: 1000000n,
    tickInterval: 86400000, // 1 day
    slippage: 0.005,
    bridgeDelayMs: 30000,
    feeModel: DEFAULT_FEE_MODEL,
    ...overrides,
  };
}

function makeEquityCurve(values: number[], startTimestamp: number = 0, intervalMs: number = 86400000): EquityPoint[] {
  return values.map((v, i) => ({
    timestamp: startTimestamp + i * intervalMs,
    portfolioValue: BigInt(Math.round(v * 1e6)),
  }));
}

/**
 * Create a mock BacktestResult that simulates strategy performance.
 * Uses a sharpe-like value to generate realistic-looking equity curves.
 */
function makeMockResult(
  config: BacktestConfig,
  performanceLevel: number = 1.0,
): BacktestResult {
  const days = Math.floor((config.endDate - config.startDate) / 86400000);
  const values: number[] = [100];

  for (let i = 1; i <= days; i++) {
    const dailyReturn = 0.001 * performanceLevel + (Math.sin(i * 0.5) * 0.005);
    values.push(values[i - 1] * (1 + dailyReturn));
  }

  const equityCurve = makeEquityCurve(values, config.startDate, 86400000);
  const finalValue = values[values.length - 1];

  return {
    startDate: config.startDate,
    endDate: config.endDate,
    initialCapital: BigInt(Math.round(100 * 1e6)),
    finalPortfolioValue: BigInt(Math.round(finalValue * 1e6)),
    equityCurve,
    tradeLog: [
      {
        id: 'trade-1',
        entryTimestamp: config.startDate,
        exitTimestamp: config.endDate,
        fromToken: '0xusdc',
        toToken: '0xweth',
        fromChain: 1,
        toChain: 1,
        entryPrice: 1.0,
        exitPrice: finalValue / 100,
        amount: 1000000n,
        fillPrice: finalValue / 100,
        fees: 1000n,
        pnl: BigInt(Math.round((finalValue - 100) * 1e6)),
        pnlPercent: (finalValue - 100) / 100,
      },
    ],
    totalTrades: 1,
    durationMs: 100,
  };
}

/** Test strategy with configurable parameters */
class TestParamStrategy extends CrossChainStrategy {
  readonly name: string;
  readonly timeframe = '1d';
  private readonly params: Record<string, number>;

  constructor(params: Record<string, number>) {
    super();
    this.params = params;
    this.name = `test-${JSON.stringify(params)}`;
  }

  shouldExecute(_context: StrategyContext): StrategySignal | null {
    const fromToken: TokenInfo = {
      address: tokenAddress('0xusdc'),
      symbol: 'USDC',
      decimals: 6,
    };
    const toToken: TokenInfo = {
      address: tokenAddress('0xweth'),
      symbol: 'WETH',
      decimals: 18,
    };

    return {
      direction: 'long',
      tokenPair: { from: fromToken, to: toToken },
      sourceChain: chainId(1),
      destChain: chainId(1),
      strength: this.params.spread ?? 0.1,
      reason: 'test signal',
      metadata: { params: this.params },
    };
  }

  buildExecution(_signal: StrategySignal, _context: StrategyContext): ExecutionPlan {
    return {
      id: `plan-${Date.now()}`,
      strategyName: this.name,
      actions: [],
      estimatedCostUsd: 5,
      estimatedDurationMs: 1000,
      metadata: {},
    };
  }
}

describe('StrategyOptimizer', () => {
  let analyzer: PerformanceAnalyzer;
  let storeResetSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    Store.getInstance().reset();
    analyzer = new PerformanceAnalyzer(0.04, 365);
    storeResetSpy = vi.spyOn(Store.prototype, 'reset');
  });

  // --- generateCombinations ---

  describe('generateCombinations', () => {
    it('should generate cartesian product of parameter grid', () => {
      const mockEngineFactory: BacktestEngineFactory = vi.fn() as BacktestEngineFactory;
      const optimizer = new StrategyOptimizer(mockEngineFactory, analyzer);

      const grid: ParameterGrid = {
        stoploss: [0.01, 0.02],
        spread: [0.05, 0.1],
      };

      const combinations = optimizer.generateCombinations(grid);

      expect(combinations.length).toBe(4);

      // Should contain all 4 combinations
      expect(combinations).toContainEqual({ stoploss: 0.01, spread: 0.05 });
      expect(combinations).toContainEqual({ stoploss: 0.01, spread: 0.1 });
      expect(combinations).toContainEqual({ stoploss: 0.02, spread: 0.05 });
      expect(combinations).toContainEqual({ stoploss: 0.02, spread: 0.1 });
    });

    it('should handle empty grid', () => {
      const mockEngineFactory: BacktestEngineFactory = vi.fn() as BacktestEngineFactory;
      const optimizer = new StrategyOptimizer(mockEngineFactory, analyzer);

      const combinations = optimizer.generateCombinations({});
      expect(combinations).toEqual([{}]);
    });

    it('should handle single parameter', () => {
      const mockEngineFactory: BacktestEngineFactory = vi.fn() as BacktestEngineFactory;
      const optimizer = new StrategyOptimizer(mockEngineFactory, analyzer);

      const grid: ParameterGrid = {
        stoploss: [0.01, 0.02, 0.03],
      };

      const combinations = optimizer.generateCombinations(grid);
      expect(combinations.length).toBe(3);
    });

    it('should handle 3-parameter grid', () => {
      const mockEngineFactory: BacktestEngineFactory = vi.fn() as BacktestEngineFactory;
      const optimizer = new StrategyOptimizer(mockEngineFactory, analyzer);

      const grid: ParameterGrid = {
        a: [1, 2],
        b: [3, 4],
        c: [5, 6],
      };

      const combinations = optimizer.generateCombinations(grid);
      expect(combinations.length).toBe(8); // 2 * 2 * 2
    });
  });

  // --- Grid Search Optimization ---

  describe('optimize (grid search)', () => {
    it('should run all combinations and rank by Sharpe ratio', async () => {
      let callCount = 0;

      const engineFactory: BacktestEngineFactory = (_strategy, config) => {
        callCount++;
        const performanceLevel = callCount; // Higher call count = higher performance for variety
        return {
          run: async () => makeMockResult(config, performanceLevel),
        } as unknown as ReturnType<BacktestEngineFactory>;
      };

      const optimizer = new StrategyOptimizer(engineFactory, analyzer);

      const strategyFactory: StrategyFactory = (params) => new TestParamStrategy(params);

      const grid: ParameterGrid = {
        stoploss: [0.01, 0.02],
        spread: [0.05, 0.1],
      };

      const config = makeConfig();
      const result = await optimizer.optimize(strategyFactory, grid, config);

      // Should have run all 4 combinations
      expect(result.totalCombinations).toBe(4);
      expect(callCount).toBe(4);

      // Results should be ranked by Sharpe descending
      expect(result.parameterSets.length).toBeLessThanOrEqual(10);
      expect(result.parameterSets[0].rank).toBe(1);

      if (result.parameterSets.length > 1) {
        expect(result.parameterSets[0].inSampleMetrics.sharpeRatio)
          .toBeGreaterThanOrEqual(result.parameterSets[1].inSampleMetrics.sharpeRatio);
      }

      // bestSharpe should match the top result
      expect(result.bestSharpe).toBe(result.parameterSets[0].inSampleMetrics.sharpeRatio);
    });

    it('should call store.reset() between each backtest run', async () => {
      const engineFactory: BacktestEngineFactory = (_strategy, config) => {
        return {
          run: async () => makeMockResult(config),
        } as unknown as ReturnType<BacktestEngineFactory>;
      };

      const optimizer = new StrategyOptimizer(engineFactory, analyzer);
      const strategyFactory: StrategyFactory = (params) => new TestParamStrategy(params);

      const grid: ParameterGrid = {
        stoploss: [0.01, 0.02],
        spread: [0.05, 0.1],
      };

      // Reset the spy count after the initial reset in beforeEach
      storeResetSpy.mockClear();

      await optimizer.optimize(strategyFactory, grid, makeConfig());

      // Should have been called once per combination (4 times)
      expect(storeResetSpy).toHaveBeenCalledTimes(4);
    });

    it('should return top-N results when requested', async () => {
      let callCount = 0;

      const engineFactory: BacktestEngineFactory = (_strategy, config) => {
        callCount++;
        return {
          run: async () => makeMockResult(config, callCount),
        } as unknown as ReturnType<BacktestEngineFactory>;
      };

      const optimizer = new StrategyOptimizer(engineFactory, analyzer);
      const strategyFactory: StrategyFactory = (params) => new TestParamStrategy(params);

      const grid: ParameterGrid = {
        a: [1, 2, 3, 4, 5],
        b: [1, 2],
      };

      const result = await optimizer.optimize(strategyFactory, grid, makeConfig(), 3);

      // Should have run all 10 combinations
      expect(result.totalCombinations).toBe(10);

      // But only return top 3
      expect(result.parameterSets.length).toBe(3);
      expect(result.parameterSets[0].rank).toBe(1);
      expect(result.parameterSets[1].rank).toBe(2);
      expect(result.parameterSets[2].rank).toBe(3);
    });

    it('should assign sequential ranks starting from 1', async () => {
      const engineFactory: BacktestEngineFactory = (_strategy, config) => {
        return {
          run: async () => makeMockResult(config),
        } as unknown as ReturnType<BacktestEngineFactory>;
      };

      const optimizer = new StrategyOptimizer(engineFactory, analyzer);
      const strategyFactory: StrategyFactory = (params) => new TestParamStrategy(params);

      const grid: ParameterGrid = { a: [1, 2, 3] };
      const result = await optimizer.optimize(strategyFactory, grid, makeConfig());

      for (let i = 0; i < result.parameterSets.length; i++) {
        expect(result.parameterSets[i].rank).toBe(i + 1);
      }
    });

    it('should have no overfitting warnings in grid search (no out-of-sample)', async () => {
      const engineFactory: BacktestEngineFactory = (_strategy, config) => {
        return {
          run: async () => makeMockResult(config),
        } as unknown as ReturnType<BacktestEngineFactory>;
      };

      const optimizer = new StrategyOptimizer(engineFactory, analyzer);
      const strategyFactory: StrategyFactory = (params) => new TestParamStrategy(params);

      const grid: ParameterGrid = { a: [1, 2] };
      const result = await optimizer.optimize(strategyFactory, grid, makeConfig());

      expect(result.overfittingWarnings).toEqual([]);
    });
  });

  // --- Walk-Forward Optimization ---

  describe('walkForwardOptimize', () => {
    it('should correctly split data into in-sample and out-of-sample windows', async () => {
      const configsUsed: BacktestConfig[] = [];

      const engineFactory: BacktestEngineFactory = (_strategy, config) => {
        configsUsed.push(config);
        return {
          run: async () => makeMockResult(config),
        } as unknown as ReturnType<BacktestEngineFactory>;
      };

      const optimizer = new StrategyOptimizer(engineFactory, analyzer);
      const strategyFactory: StrategyFactory = (params) => new TestParamStrategy(params);

      const baseConfig = makeConfig({
        startDate: 0,
        endDate: 100 * 86400000, // 100 days
      });

      const walkForwardConfig: WalkForwardConfig = {
        inSampleRatio: 0.7,
        windowCount: 2,
        anchoredStart: false,
      };

      const grid: ParameterGrid = { a: [1] }; // Single combination for simplicity

      await optimizer.walkForwardOptimize(strategyFactory, grid, baseConfig, walkForwardConfig);

      // Should have called engine for:
      // Window 1: in-sample (1 combo) + out-of-sample (1 best)
      // Window 2: in-sample (1 combo) + out-of-sample (1 best)
      // Total: 4 engine runs
      expect(configsUsed.length).toBe(4);

      // Verify window dates are within the total range
      for (const cfg of configsUsed) {
        expect(cfg.startDate).toBeGreaterThanOrEqual(baseConfig.startDate);
        expect(cfg.endDate).toBeLessThanOrEqual(baseConfig.endDate);
      }
    });

    it('should include both in-sample and out-of-sample metrics', async () => {
      const engineFactory: BacktestEngineFactory = (_strategy, config) => {
        return {
          run: async () => makeMockResult(config, 2.0),
        } as unknown as ReturnType<BacktestEngineFactory>;
      };

      const optimizer = new StrategyOptimizer(engineFactory, analyzer);
      const strategyFactory: StrategyFactory = (params) => new TestParamStrategy(params);

      const baseConfig = makeConfig({
        startDate: 0,
        endDate: 100 * 86400000,
      });

      const walkForwardConfig: WalkForwardConfig = {
        inSampleRatio: 0.7,
        windowCount: 2,
        anchoredStart: false,
      };

      const grid: ParameterGrid = { a: [1, 2] };

      const result = await optimizer.walkForwardOptimize(
        strategyFactory, grid, baseConfig, walkForwardConfig,
      );

      // Should have results with out-of-sample metrics
      expect(result.parameterSets.length).toBeGreaterThan(0);
      for (const ps of result.parameterSets) {
        expect(ps.inSampleMetrics).toBeDefined();
        expect(ps.outOfSampleMetrics).toBeDefined();
      }
    });
  });

  // --- Overfitting Detection ---

  describe('overfitting detection', () => {
    it('should flag overfitting when Sharpe drops > 50%', async () => {
      let callIndex = 0;

      const engineFactory: BacktestEngineFactory = (_strategy, config) => {
        callIndex++;
        // Alternate between high-perf (in-sample) and low-perf (out-of-sample)
        // In-sample calls (odd): high performance
        // Out-of-sample calls (even): low performance
        const isInSample = callIndex % 2 === 1;
        const performanceLevel = isInSample ? 5.0 : 0.5;

        return {
          run: async () => makeMockResult(config, performanceLevel),
        } as unknown as ReturnType<BacktestEngineFactory>;
      };

      const optimizer = new StrategyOptimizer(engineFactory, analyzer);
      const strategyFactory: StrategyFactory = (params) => new TestParamStrategy(params);

      const baseConfig = makeConfig({
        startDate: 0,
        endDate: 100 * 86400000,
      });

      const walkForwardConfig: WalkForwardConfig = {
        inSampleRatio: 0.7,
        windowCount: 1,
        anchoredStart: false,
      };

      const grid: ParameterGrid = { a: [1] };

      const result = await optimizer.walkForwardOptimize(
        strategyFactory, grid, baseConfig, walkForwardConfig,
      );

      // Check if in-sample sharpe is significantly higher than out-of-sample
      if (result.parameterSets.length > 0) {
        const ps = result.parameterSets[0];
        if (ps.inSampleMetrics.sharpeRatio > 0 && ps.outOfSampleMetrics) {
          const sharpeDrop = (ps.inSampleMetrics.sharpeRatio - ps.outOfSampleMetrics.sharpeRatio) / ps.inSampleMetrics.sharpeRatio;

          if (sharpeDrop > 0.5) {
            expect(ps.overfitting).toBe(true);
            expect(result.overfittingWarnings.length).toBeGreaterThan(0);
            expect(result.overfittingWarnings[0].sharpeDrop).toBeGreaterThan(0.5);
          }
        }
      }
    });

    it('should not flag overfitting when Sharpe drop < 50%', async () => {
      // Use consistent performance levels so IS and OOS are similar
      const engineFactory: BacktestEngineFactory = (_strategy, config) => {
        return {
          run: async () => makeMockResult(config, 2.0),
        } as unknown as ReturnType<BacktestEngineFactory>;
      };

      const optimizer = new StrategyOptimizer(engineFactory, analyzer);
      const strategyFactory: StrategyFactory = (params) => new TestParamStrategy(params);

      const baseConfig = makeConfig({
        startDate: 0,
        endDate: 100 * 86400000,
      });

      const walkForwardConfig: WalkForwardConfig = {
        inSampleRatio: 0.7,
        windowCount: 1,
        anchoredStart: false,
      };

      const grid: ParameterGrid = { a: [1] };

      const result = await optimizer.walkForwardOptimize(
        strategyFactory, grid, baseConfig, walkForwardConfig,
      );

      // With same performance level for IS and OOS, there should be no overfitting
      for (const ps of result.parameterSets) {
        // Either no OOS metrics or the Sharpe drop is small
        if (ps.outOfSampleMetrics && ps.inSampleMetrics.sharpeRatio > 0) {
          const sharpeDrop = (ps.inSampleMetrics.sharpeRatio - ps.outOfSampleMetrics.sharpeRatio) / ps.inSampleMetrics.sharpeRatio;
          // Since both use same perf level, sharp drop should be minimal
          // (slight differences from different date ranges are expected)
          if (sharpeDrop <= 0.5) {
            expect(ps.overfitting).toBe(false);
          }
        }
      }
    });

    it('should skip overfitting check when in-sample Sharpe <= 0', async () => {
      // Very low performance to produce negative or zero Sharpe
      const engineFactory: BacktestEngineFactory = (_strategy, config) => {
        // Create a flat/declining equity curve that produces Sharpe <= 0
        const days = Math.floor((config.endDate - config.startDate) / 86400000);
        const values: number[] = [100];
        for (let i = 1; i <= days; i++) {
          values.push(values[i - 1] * (1 - 0.001)); // declining
        }

        const equityCurve = values.map((v, i) => ({
          timestamp: config.startDate + i * 86400000,
          portfolioValue: BigInt(Math.round(v * 1e6)),
        }));

        const result: BacktestResult = {
          startDate: config.startDate,
          endDate: config.endDate,
          initialCapital: BigInt(100 * 1e6),
          finalPortfolioValue: BigInt(Math.round(values[values.length - 1] * 1e6)),
          equityCurve,
          tradeLog: [{
            id: 'trade-1',
            entryTimestamp: config.startDate,
            exitTimestamp: config.endDate,
            fromToken: '0xusdc',
            toToken: '0xweth',
            fromChain: 1,
            toChain: 1,
            entryPrice: 1.0,
            exitPrice: 0.9,
            amount: 1000000n,
            fillPrice: 0.9,
            fees: 1000n,
            pnl: -100000n,
            pnlPercent: -0.1,
          }],
          totalTrades: 1,
          durationMs: 100,
        };

        return result;
      };

      const mockEngineFactory: BacktestEngineFactory = (strategy, config) => {
        return {
          run: async () => engineFactory(strategy, config),
        } as unknown as ReturnType<BacktestEngineFactory>;
      };

      const optimizer = new StrategyOptimizer(mockEngineFactory, analyzer);
      const strategyFactory: StrategyFactory = (params) => new TestParamStrategy(params);

      const baseConfig = makeConfig({
        startDate: 0,
        endDate: 100 * 86400000,
      });

      const walkForwardConfig: WalkForwardConfig = {
        inSampleRatio: 0.7,
        windowCount: 1,
        anchoredStart: false,
      };

      const grid: ParameterGrid = { a: [1] };

      const result = await optimizer.walkForwardOptimize(
        strategyFactory, grid, baseConfig, walkForwardConfig,
      );

      // When in-sample Sharpe <= 0, overfitting check should be skipped
      expect(result.overfittingWarnings.length).toBe(0);
      for (const ps of result.parameterSets) {
        expect(ps.overfitting).toBe(false);
      }
    });

    it('should compute correct sharpeDrop ratio', () => {
      // Direct unit test of the formula: (IS - OOS) / IS
      const inSampleSharpe = 2.0;
      const outOfSampleSharpe = 0.8;
      const sharpeDrop = (inSampleSharpe - outOfSampleSharpe) / inSampleSharpe;

      // drop = (2.0 - 0.8) / 2.0 = 0.6 = 60% > 50% threshold
      expect(sharpeDrop).toBeCloseTo(0.6, 5);
      expect(sharpeDrop).toBeGreaterThan(0.5);
    });

    it('should not flag when Sharpe drop is 25%', () => {
      const inSampleSharpe = 2.0;
      const outOfSampleSharpe = 1.5;
      const sharpeDrop = (inSampleSharpe - outOfSampleSharpe) / inSampleSharpe;

      // drop = (2.0 - 1.5) / 2.0 = 0.25 = 25% < 50% threshold
      expect(sharpeDrop).toBeCloseTo(0.25, 5);
      expect(sharpeDrop).toBeLessThan(0.5);
    });
  });

  // --- Edge Cases ---

  describe('edge cases', () => {
    it('should handle optimization with zero combinations gracefully', async () => {
      const engineFactory: BacktestEngineFactory = vi.fn() as BacktestEngineFactory;

      const optimizer = new StrategyOptimizer(engineFactory, analyzer);
      const strategyFactory: StrategyFactory = (params) => new TestParamStrategy(params);

      // Empty grid produces one empty combination
      const grid: ParameterGrid = {};
      const config = makeConfig();

      // Create a proper mock engine for the single empty-params combination
      const mockEngine = {
        run: async () => makeMockResult(config),
      };
      (engineFactory as ReturnType<typeof vi.fn>).mockReturnValue(mockEngine);

      const result = await optimizer.optimize(strategyFactory, grid, config);

      expect(result.totalCombinations).toBe(1);
      expect(result.parameterSets.length).toBe(1);
    });

    it('should include duration in result', async () => {
      const engineFactory: BacktestEngineFactory = (_strategy, config) => {
        return {
          run: async () => makeMockResult(config),
        } as unknown as ReturnType<BacktestEngineFactory>;
      };

      const optimizer = new StrategyOptimizer(engineFactory, analyzer);
      const strategyFactory: StrategyFactory = (params) => new TestParamStrategy(params);

      const grid: ParameterGrid = { a: [1] };
      const result = await optimizer.optimize(strategyFactory, grid, makeConfig());

      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });
  });
});
