// StrategyOptimizer — grid search and walk-forward parameter optimization

import { createLogger } from '../utils/logger.js';
import { Store } from '../core/store.js';
import type { CrossChainStrategy } from '../strategies/cross-chain-strategy.js';
import type { BacktestEngine } from './backtest-engine.js';
import type { PerformanceAnalyzer } from './performance-analyzer.js';
import type {
  BacktestConfig,
  ParameterGrid,
  OptimizationResult,
  RankedParameterSet,
  OverfittingWarning,
  PerformanceMetrics,
  WalkForwardConfig,
} from './types.js';

const logger = createLogger('strategy-optimizer');

/**
 * Factory function type for creating a BacktestEngine with a given strategy and config.
 */
export type BacktestEngineFactory = (
  strategy: CrossChainStrategy,
  config: BacktestConfig,
) => BacktestEngine;

/**
 * Factory function type for creating a strategy with specific parameter values.
 */
export type StrategyFactory = (params: Record<string, number>) => CrossChainStrategy;

/**
 * StrategyOptimizer performs grid search and walk-forward parameter optimization.
 *
 * For each combination of parameters, it creates a strategy, runs a backtest,
 * computes metrics, and ranks results by Sharpe ratio.
 *
 * Walk-forward optimization splits data into in-sample/out-of-sample windows
 * to detect overfitting.
 */
export class StrategyOptimizer {
  private readonly engineFactory: BacktestEngineFactory;
  private readonly analyzer: PerformanceAnalyzer;

  constructor(
    engineFactory: BacktestEngineFactory,
    analyzer: PerformanceAnalyzer,
  ) {
    this.engineFactory = engineFactory;
    this.analyzer = analyzer;
  }

  /**
   * Run grid search optimization over the parameter space.
   *
   * For each combination in the cartesian product of the parameter grid:
   * 1. Create strategy with those parameters
   * 2. Run backtest via BacktestEngine
   * 3. Compute metrics via PerformanceAnalyzer
   * 4. Reset store for isolation
   *
   * Results are ranked by Sharpe ratio descending.
   *
   * @param strategyFactory - Factory to create strategy with specific parameters
   * @param grid - Parameter grid to search
   * @param config - Backtest config (start/end dates, capital, etc.)
   * @param topN - Number of top results to include (default: 10)
   */
  async optimize(
    strategyFactory: StrategyFactory,
    grid: ParameterGrid,
    config: BacktestConfig,
    topN: number = 10,
  ): Promise<OptimizationResult> {
    const startTime = Date.now();
    const combinations = this.generateCombinations(grid);
    const totalCombinations = combinations.length;

    logger.info(
      { totalCombinations, grid },
      'Starting grid search optimization',
    );

    const results: Array<{
      parameters: Record<string, number>;
      metrics: PerformanceMetrics;
    }> = [];

    for (let i = 0; i < combinations.length; i++) {
      const params = combinations[i];
      logger.info(
        { combinationIndex: i + 1, totalCombinations, params },
        `Running combination ${i + 1} of ${totalCombinations}`,
      );

      // Reset store for isolation
      Store.getInstance().reset();

      const strategy = strategyFactory(params);
      const engine = this.engineFactory(strategy, config);
      const backtestResult = await engine.run();
      const metrics = this.analyzer.analyze(backtestResult);

      results.push({ parameters: params, metrics });
    }

    // Sort by Sharpe ratio descending
    results.sort((a, b) => b.metrics.sharpeRatio - a.metrics.sharpeRatio);

    // Build ranked parameter sets (top N)
    const parameterSets: RankedParameterSet[] = results
      .slice(0, topN)
      .map((r, idx) => ({
        rank: idx + 1,
        parameters: r.parameters,
        inSampleMetrics: r.metrics,
        overfitting: false,
      }));

    const bestSharpe = results.length > 0 ? results[0].metrics.sharpeRatio : 0;
    const durationMs = Date.now() - startTime;

    logger.info(
      { totalCombinations, bestSharpe, durationMs },
      'Grid search optimization completed',
    );

    return {
      parameterSets,
      totalCombinations,
      durationMs,
      bestSharpe,
      overfittingWarnings: [],
    };
  }

  /**
   * Run walk-forward optimization with in-sample/out-of-sample splitting.
   *
   * For each window:
   * 1. Split data into in-sample and out-of-sample periods
   * 2. Run grid search on in-sample period
   * 3. Take best parameter set (by Sharpe)
   * 4. Run single backtest on out-of-sample period with those parameters
   * 5. Compare in-sample vs out-of-sample performance
   * 6. Flag overfitting if Sharpe drops > 50%
   *
   * @param strategyFactory - Factory to create strategy with specific parameters
   * @param grid - Parameter grid to search
   * @param config - Base backtest config
   * @param walkForwardConfig - Walk-forward configuration
   * @param topN - Number of top results to include (default: 10)
   */
  async walkForwardOptimize(
    strategyFactory: StrategyFactory,
    grid: ParameterGrid,
    config: BacktestConfig,
    walkForwardConfig: WalkForwardConfig,
    topN: number = 10,
  ): Promise<OptimizationResult> {
    const startTime = Date.now();
    const combinations = this.generateCombinations(grid);
    const totalCombinations = combinations.length;

    logger.info(
      {
        totalCombinations,
        windowCount: walkForwardConfig.windowCount,
        inSampleRatio: walkForwardConfig.inSampleRatio,
        anchoredStart: walkForwardConfig.anchoredStart,
      },
      'Starting walk-forward optimization',
    );

    const windows = this.splitWindows(config, walkForwardConfig);

    // Track results per parameter combination across all windows
    const parameterResults = new Map<string, {
      parameters: Record<string, number>;
      inSampleMetricsList: PerformanceMetrics[];
      outOfSampleMetricsList: PerformanceMetrics[];
    }>();

    const overfittingWarnings: OverfittingWarning[] = [];

    for (let windowIdx = 0; windowIdx < windows.length; windowIdx++) {
      const window = windows[windowIdx];

      logger.info(
        { windowIdx: windowIdx + 1, windowCount: windows.length, inSample: window.inSample, outOfSample: window.outOfSample },
        `Processing walk-forward window ${windowIdx + 1} of ${windows.length}`,
      );

      // In-sample: run grid search
      const inSampleConfig: BacktestConfig = {
        ...config,
        startDate: window.inSample.start,
        endDate: window.inSample.end,
      };

      const inSampleResults: Array<{
        parameters: Record<string, number>;
        metrics: PerformanceMetrics;
      }> = [];

      for (const params of combinations) {
        Store.getInstance().reset();
        const strategy = strategyFactory(params);
        const engine = this.engineFactory(strategy, inSampleConfig);
        const backtestResult = await engine.run();
        const metrics = this.analyzer.analyze(backtestResult);
        inSampleResults.push({ parameters: params, metrics });
      }

      // Find best in-sample by Sharpe
      inSampleResults.sort((a, b) => b.metrics.sharpeRatio - a.metrics.sharpeRatio);

      if (inSampleResults.length === 0) continue;

      const bestInSample = inSampleResults[0];

      // Out-of-sample: run best params
      const outOfSampleConfig: BacktestConfig = {
        ...config,
        startDate: window.outOfSample.start,
        endDate: window.outOfSample.end,
      };

      Store.getInstance().reset();
      const oosStrategy = strategyFactory(bestInSample.parameters);
      const oosEngine = this.engineFactory(oosStrategy, outOfSampleConfig);
      const oosResult = await oosEngine.run();
      const oosMetrics = this.analyzer.analyze(oosResult);

      // Accumulate results for this parameter set
      const paramKey = JSON.stringify(bestInSample.parameters);
      let tracked = parameterResults.get(paramKey);
      if (!tracked) {
        tracked = {
          parameters: bestInSample.parameters,
          inSampleMetricsList: [],
          outOfSampleMetricsList: [],
        };
        parameterResults.set(paramKey, tracked);
      }
      tracked.inSampleMetricsList.push(bestInSample.metrics);
      tracked.outOfSampleMetricsList.push(oosMetrics);
    }

    // Aggregate results: average metrics across windows
    const aggregated: Array<{
      parameters: Record<string, number>;
      inSampleMetrics: PerformanceMetrics;
      outOfSampleMetrics: PerformanceMetrics;
      overfitting: boolean;
    }> = [];

    for (const [, tracked] of parameterResults) {
      const avgInSample = this.averageMetrics(tracked.inSampleMetricsList);
      const avgOutOfSample = this.averageMetrics(tracked.outOfSampleMetricsList);

      // Overfitting detection
      let isOverfit = false;
      if (avgInSample.sharpeRatio > 0) {
        const sharpeDrop = (avgInSample.sharpeRatio - avgOutOfSample.sharpeRatio) / avgInSample.sharpeRatio;
        if (sharpeDrop > 0.5) {
          isOverfit = true;
          const warning: OverfittingWarning = {
            parameters: tracked.parameters,
            inSampleSharpe: avgInSample.sharpeRatio,
            outOfSampleSharpe: avgOutOfSample.sharpeRatio,
            sharpeDrop,
          };
          overfittingWarnings.push(warning);

          logger.warn(
            {
              params: tracked.parameters,
              inSampleSharpe: avgInSample.sharpeRatio,
              outOfSampleSharpe: avgOutOfSample.sharpeRatio,
              sharpeDrop: `${(sharpeDrop * 100).toFixed(1)}%`,
            },
            `WARNING: Parameter set shows overfitting — in-sample Sharpe: ${avgInSample.sharpeRatio.toFixed(2)}, out-of-sample Sharpe: ${avgOutOfSample.sharpeRatio.toFixed(2)} (drop: ${(sharpeDrop * 100).toFixed(1)}%)`,
          );
        }
      }

      aggregated.push({
        parameters: tracked.parameters,
        inSampleMetrics: avgInSample,
        outOfSampleMetrics: avgOutOfSample,
        overfitting: isOverfit,
      });
    }

    // Sort by in-sample Sharpe descending
    aggregated.sort((a, b) => b.inSampleMetrics.sharpeRatio - a.inSampleMetrics.sharpeRatio);

    const parameterSets: RankedParameterSet[] = aggregated
      .slice(0, topN)
      .map((r, idx) => ({
        rank: idx + 1,
        parameters: r.parameters,
        inSampleMetrics: r.inSampleMetrics,
        outOfSampleMetrics: r.outOfSampleMetrics,
        overfitting: r.overfitting,
      }));

    const bestSharpe = aggregated.length > 0 ? aggregated[0].inSampleMetrics.sharpeRatio : 0;
    const durationMs = Date.now() - startTime;

    logger.info(
      { totalCombinations, bestSharpe, durationMs, overfittingWarnings: overfittingWarnings.length },
      'Walk-forward optimization completed',
    );

    return {
      parameterSets,
      totalCombinations,
      durationMs,
      bestSharpe,
      overfittingWarnings,
    };
  }

  /**
   * Generate the cartesian product of all parameter arrays in the grid.
   */
  generateCombinations(grid: ParameterGrid): Array<Record<string, number>> {
    const keys = Object.keys(grid);
    if (keys.length === 0) return [{}];

    const result: Array<Record<string, number>> = [];

    function recurse(idx: number, current: Record<string, number>): void {
      if (idx === keys.length) {
        result.push({ ...current });
        return;
      }

      const key = keys[idx];
      const values = grid[key];
      for (const value of values) {
        current[key] = value;
        recurse(idx + 1, current);
      }
      delete current[key];
    }

    recurse(0, {});
    return result;
  }

  // --- Private helper methods ---

  /**
   * Split the total date range into walk-forward windows.
   */
  private splitWindows(
    config: BacktestConfig,
    walkForwardConfig: WalkForwardConfig,
  ): Array<{
    inSample: { start: number; end: number };
    outOfSample: { start: number; end: number };
  }> {
    const totalRange = config.endDate - config.startDate;
    const windowCount = walkForwardConfig.windowCount;
    const inSampleRatio = walkForwardConfig.inSampleRatio;
    const anchoredStart = walkForwardConfig.anchoredStart;

    const windows: Array<{
      inSample: { start: number; end: number };
      outOfSample: { start: number; end: number };
    }> = [];

    if (anchoredStart) {
      // Anchored (expanding window): in-sample always starts from the beginning
      // Divide the OOS portion evenly across windows
      const totalOosLength = totalRange * (1 - inSampleRatio);
      const oosPerWindow = totalOosLength / windowCount;

      for (let i = 0; i < windowCount; i++) {
        const oosStart = config.startDate + totalRange * inSampleRatio + i * oosPerWindow;
        const oosEnd = oosStart + oosPerWindow;

        windows.push({
          inSample: {
            start: config.startDate,
            end: oosStart,
          },
          outOfSample: {
            start: oosStart,
            end: Math.min(oosEnd, config.endDate),
          },
        });
      }
    } else {
      // Rolling window: window slides forward
      const windowSize = totalRange / windowCount;
      const inSampleLength = windowSize * inSampleRatio;
      const oosLength = windowSize * (1 - inSampleRatio);

      for (let i = 0; i < windowCount; i++) {
        const windowStart = config.startDate + i * windowSize;
        const inSampleEnd = windowStart + inSampleLength;
        const oosEnd = windowStart + windowSize;

        windows.push({
          inSample: {
            start: windowStart,
            end: inSampleEnd,
          },
          outOfSample: {
            start: inSampleEnd,
            end: Math.min(oosEnd, config.endDate),
          },
        });
      }
    }

    return windows;
  }

  /**
   * Average multiple PerformanceMetrics into one.
   */
  private averageMetrics(metricsList: PerformanceMetrics[]): PerformanceMetrics {
    if (metricsList.length === 0) {
      return {
        sharpeRatio: 0,
        sortinoRatio: 0,
        maxDrawdown: 0,
        maxDrawdownDuration: 0,
        winRate: 0,
        profitFactor: 0,
        calmarRatio: 0,
        totalReturn: 0,
        totalTrades: 0,
        annualizedReturn: 0,
      };
    }

    const count = metricsList.length;
    return {
      sharpeRatio: metricsList.reduce((s, m) => s + m.sharpeRatio, 0) / count,
      sortinoRatio: metricsList.reduce((s, m) => s + m.sortinoRatio, 0) / count,
      maxDrawdown: metricsList.reduce((s, m) => s + m.maxDrawdown, 0) / count,
      maxDrawdownDuration: metricsList.reduce((s, m) => s + m.maxDrawdownDuration, 0) / count,
      winRate: metricsList.reduce((s, m) => s + m.winRate, 0) / count,
      profitFactor: metricsList.reduce((s, m) => s + m.profitFactor, 0) / count,
      calmarRatio: metricsList.reduce((s, m) => s + m.calmarRatio, 0) / count,
      totalReturn: metricsList.reduce((s, m) => s + m.totalReturn, 0) / count,
      totalTrades: Math.round(metricsList.reduce((s, m) => s + m.totalTrades, 0) / count),
      annualizedReturn: metricsList.reduce((s, m) => s + m.annualizedReturn, 0) / count,
    };
  }
}
