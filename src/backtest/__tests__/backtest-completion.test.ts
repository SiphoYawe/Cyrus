import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm } from 'node:fs/promises';
import Database from 'better-sqlite3';
import { HistoricalDataLoader } from '../historical-data-loader.js';
import { BacktestEngine } from '../backtest-engine.js';
import { PerformanceAnalyzer } from '../performance-analyzer.js';
import { StrategyOptimizer } from '../strategy-optimizer.js';
import { SimulatedLiFiConnector } from '../../connectors/simulated-lifi-connector.js';
import { PersistenceService } from '../../core/persistence.js';
import { Store } from '../../core/store.js';
import { CrossChainStrategy } from '../../strategies/cross-chain-strategy.js';
import { chainId, tokenAddress } from '../../core/types.js';
import type {
  StrategySignal,
  ExecutionPlan,
  StrategyContext,
  TokenInfo,
} from '../../core/types.js';
import type { BacktestConfig, FeeModel } from '../types.js';

// --- Test strategy ---

class SimpleTestStrategy extends CrossChainStrategy {
  readonly name = 'simple-test';
  readonly timeframe = '1m';
  override readonly maxPositions = 5;
  private tradeCount = 0;
  private maxTrades: number;

  constructor(maxTrades = 2) {
    super();
    this.maxTrades = maxTrades;
  }

  shouldExecute(_context: StrategyContext): StrategySignal | null {
    if (this.tradeCount >= this.maxTrades) return null;
    this.tradeCount++;

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
      strength: 0.1,
      reason: 'Test signal',
      metadata: {},
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

// --- Shared helpers ---

const DEFAULT_FEE_MODEL: FeeModel = {
  bridgeFeePercent: 0.003,
  gasEstimateUsd: 5.0,
  dexFeePercent: 0.003,
};

function createDefaultConfig(overrides?: Partial<BacktestConfig>): BacktestConfig {
  return {
    strategyName: 'test-strategy',
    startDate: 1000,
    endDate: 5000,
    initialCapital: 1000000n,
    tickInterval: 1000,
    slippage: 0.005,
    bridgeDelayMs: 60000,
    feeModel: DEFAULT_FEE_MODEL,
    initialToken: '0xusdc',
    initialChainId: 1,
    seed: 42,
    ...overrides,
  };
}

function createDefaultLoader(): HistoricalDataLoader {
  const loader = new HistoricalDataLoader();
  loader.loadDirect([
    { timestamp: 1000, token: '0xusdc', chainId: 1, price: 1.0, volume: 100000 },
    { timestamp: 2000, token: '0xusdc', chainId: 1, price: 1.01, volume: 120000 },
    { timestamp: 3000, token: '0xusdc', chainId: 1, price: 0.99, volume: 110000 },
    { timestamp: 4000, token: '0xusdc', chainId: 1, price: 1.02, volume: 130000 },
    { timestamp: 5000, token: '0xusdc', chainId: 1, price: 1.0, volume: 100000 },
    { timestamp: 1000, token: '0xweth', chainId: 1, price: 2500, volume: 50000 },
    { timestamp: 2000, token: '0xweth', chainId: 1, price: 2550, volume: 55000 },
    { timestamp: 3000, token: '0xweth', chainId: 1, price: 2480, volume: 45000 },
    { timestamp: 4000, token: '0xweth', chainId: 1, price: 2600, volume: 60000 },
    { timestamp: 5000, token: '0xweth', chainId: 1, price: 2520, volume: 52000 },
  ]);
  return loader;
}

function createDefaultConnector(loader: HistoricalDataLoader): SimulatedLiFiConnector {
  return new SimulatedLiFiConnector(loader, {
    slippage: 0.005,
    bridgeDelayMs: 60000,
    feeModel: DEFAULT_FEE_MODEL,
    seed: 42,
  });
}

// ========================================
// 1. Multi-token data alignment
// ========================================

describe('HistoricalDataLoader — alignTimeSeries', () => {
  let loader: HistoricalDataLoader;

  beforeEach(() => {
    loader = new HistoricalDataLoader();
  });

  it('aligns two token series to shared timestamps with forward-fill', () => {
    loader.loadDirect([
      { timestamp: 1000, token: 'A', chainId: 1, price: 10, volume: 100 },
      { timestamp: 3000, token: 'A', chainId: 1, price: 12, volume: 120 },
      { timestamp: 5000, token: 'A', chainId: 1, price: 11, volume: 110 },
      { timestamp: 2000, token: 'B', chainId: 1, price: 20, volume: 200 },
      { timestamp: 4000, token: 'B', chainId: 1, price: 22, volume: 220 },
    ]);

    const aligned = loader.alignTimeSeries(['1-A', '1-B'], 1000);

    const aAligned = aligned.get('1-A')!;
    const bAligned = aligned.get('1-B')!;

    // Both should have 5 timestamps (1000..5000)
    expect(aAligned.length).toBe(5);
    expect(bAligned.length).toBe(4); // B starts at 2000, so 2000..5000

    // Token A: forward-fills gap at 2000 and 4000
    expect(aAligned[0].price).toBe(10); // 1000
    expect(aAligned[1].price).toBe(10); // 2000 (forward-fill from 1000)
    expect(aAligned[2].price).toBe(12); // 3000
    expect(aAligned[3].price).toBe(12); // 4000 (forward-fill from 3000)
    expect(aAligned[4].price).toBe(11); // 5000

    // Token B: forward-fills gap at 3000
    expect(bAligned[0].price).toBe(20); // 2000
    expect(bAligned[1].price).toBe(20); // 3000 (forward-fill from 2000)
    expect(bAligned[2].price).toBe(22); // 4000
    expect(bAligned[3].price).toBe(22); // 5000 (forward-fill from 4000)
  });

  it('returns empty arrays for unknown keys', () => {
    const aligned = loader.alignTimeSeries(['1-UNKNOWN', '2-MISSING'], 1000);

    expect(aligned.get('1-UNKNOWN')).toEqual([]);
    expect(aligned.get('2-MISSING')).toEqual([]);
  });

  it('handles single token alignment', () => {
    loader.loadDirect([
      { timestamp: 1000, token: 'X', chainId: 1, price: 5, volume: 50 },
      { timestamp: 3000, token: 'X', chainId: 1, price: 7, volume: 70 },
    ]);

    const aligned = loader.alignTimeSeries(['1-X'], 1000);
    const xAligned = aligned.get('1-X')!;

    expect(xAligned.length).toBe(3); // 1000, 2000, 3000
    expect(xAligned[1].price).toBe(5); // 2000: forward-fill from 1000
    expect(xAligned[2].price).toBe(7); // 3000: actual
  });
});

// ========================================
// 2. CoinGecko fetching (mocked)
// ========================================

describe('HistoricalDataLoader — fetchFromCoinGecko', () => {
  let loader: HistoricalDataLoader;

  beforeEach(() => {
    loader = new HistoricalDataLoader();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches and parses CoinGecko market chart data', async () => {
    const mockResponse = {
      prices: [
        [1700000000000, 1.0],
        [1700003600000, 1.01],
        [1700007200000, 0.99],
      ],
      total_volumes: [
        [1700000000000, 500000],
        [1700003600000, 600000],
        [1700007200000, 550000],
      ],
    };

    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    } as Response);

    const points = await loader.fetchFromCoinGecko(
      '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      1,
      7,
    );

    expect(points).toHaveLength(3);
    expect(points[0].price).toBe(1.0);
    expect(points[0].volume).toBe(500000);
    expect(points[1].price).toBe(1.01);
    expect(points[2].price).toBe(0.99);

    // Data should be in the loader
    expect(loader.getAllDataPoints().length).toBe(3);
  });

  it('throws for unknown token without coingeckoId', async () => {
    await expect(
      loader.fetchFromCoinGecko('0xunknown', 1, 7),
    ).rejects.toThrow('No CoinGecko ID found');
  });

  it('throws on API error response', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
    } as Response);

    await expect(
      loader.fetchFromCoinGecko(
        '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        1,
        7,
      ),
    ).rejects.toThrow('CoinGecko API error: 429');
  });

  it('accepts explicit coingeckoId override', async () => {
    const mockResponse = {
      prices: [[1700000000000, 42.5]],
      total_volumes: [[1700000000000, 100000]],
    };

    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    } as Response);

    const points = await loader.fetchFromCoinGecko(
      '0xcustom',
      1,
      7,
      'custom-token',
    );

    expect(points).toHaveLength(1);
    expect(points[0].price).toBe(42.5);
  });
});

// ========================================
// 3. Backtest results persistence
// ========================================

describe('PersistenceService — backtest results', () => {
  let persistence: PersistenceService;
  let dbPath: string;
  let testDir: string;

  beforeEach(async () => {
    Store.getInstance().reset();
    testDir = join(tmpdir(), `persistence-bt-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    dbPath = join(testDir, 'test.db');
    persistence = new PersistenceService(dbPath);
  });

  afterEach(async () => {
    persistence.close();
    await rm(testDir, { recursive: true, force: true });
  });

  it('saves and retrieves a backtest result', () => {
    const result = {
      id: 'bt-001',
      strategyName: 'yield-hunter',
      startDate: 1700000000000,
      endDate: 1702592000000,
      initialCapital: '1000000',
      finalPortfolioValue: '1050000',
      totalTrades: 5,
      totalReturn: 0.05,
      sharpeRatio: 1.2,
      sortinoRatio: 1.5,
      maxDrawdown: 0.03,
      winRate: 0.6,
      profitFactor: 1.8,
      calmarRatio: 1.67,
      annualizedReturn: 0.61,
      parametersJson: JSON.stringify({ spread: 0.05, stoploss: 0.02 }),
      equityCurveJson: JSON.stringify([{ timestamp: 1700000000000, portfolioValue: '1000000' }]),
      tradeLogJson: JSON.stringify([]),
      durationMs: 150,
    };

    persistence.saveBacktestResult(result);

    const { entries, total } = persistence.getBacktestResults(50, 0);
    expect(total).toBe(1);
    expect(entries).toHaveLength(1);
    expect(entries[0].strategy_name).toBe('yield-hunter');
    expect(entries[0].sharpe_ratio).toBeCloseTo(1.2);
    expect(entries[0].total_trades).toBe(5);
  });

  it('filters by strategy name', () => {
    persistence.saveBacktestResult({
      id: 'bt-001',
      strategyName: 'yield-hunter',
      startDate: 1700000000000,
      endDate: 1702592000000,
      initialCapital: '1000000',
      finalPortfolioValue: '1050000',
      totalTrades: 5,
      totalReturn: 0.05,
      sharpeRatio: 1.2,
      sortinoRatio: 1.5,
      maxDrawdown: 0.03,
      winRate: 0.6,
      profitFactor: 1.8,
      calmarRatio: 1.67,
      annualizedReturn: 0.61,
      parametersJson: null,
      equityCurveJson: '[]',
      tradeLogJson: '[]',
      durationMs: 100,
    });

    persistence.saveBacktestResult({
      id: 'bt-002',
      strategyName: 'arb-strategy',
      startDate: 1700000000000,
      endDate: 1702592000000,
      initialCapital: '2000000',
      finalPortfolioValue: '2100000',
      totalTrades: 10,
      totalReturn: 0.05,
      sharpeRatio: 0.8,
      sortinoRatio: 1.0,
      maxDrawdown: 0.05,
      winRate: 0.7,
      profitFactor: 2.0,
      calmarRatio: 1.0,
      annualizedReturn: 0.61,
      parametersJson: null,
      equityCurveJson: '[]',
      tradeLogJson: '[]',
      durationMs: 200,
    });

    const all = persistence.getBacktestResults(50, 0);
    expect(all.total).toBe(2);

    const filtered = persistence.getBacktestResults(50, 0, 'yield-hunter');
    expect(filtered.total).toBe(1);
    expect(filtered.entries[0].strategy_name).toBe('yield-hunter');
  });

  it('supports pagination', () => {
    for (let i = 0; i < 5; i++) {
      persistence.saveBacktestResult({
        id: `bt-${i}`,
        strategyName: 'test',
        startDate: 1700000000000,
        endDate: 1702592000000,
        initialCapital: '1000000',
        finalPortfolioValue: '1050000',
        totalTrades: i,
        totalReturn: 0.05,
        sharpeRatio: 1.0,
        sortinoRatio: 1.0,
        maxDrawdown: 0.03,
        winRate: 0.6,
        profitFactor: 1.5,
        calmarRatio: 1.0,
        annualizedReturn: 0.5,
        parametersJson: null,
        equityCurveJson: '[]',
        tradeLogJson: '[]',
        durationMs: 100,
      });
    }

    const page1 = persistence.getBacktestResults(2, 0);
    expect(page1.total).toBe(5);
    expect(page1.entries).toHaveLength(2);

    const page2 = persistence.getBacktestResults(2, 2);
    expect(page2.total).toBe(5);
    expect(page2.entries).toHaveLength(2);

    const page3 = persistence.getBacktestResults(2, 4);
    expect(page3.total).toBe(5);
    expect(page3.entries).toHaveLength(1);
  });
});

// ========================================
// 4. End-to-end backtest validation
// ========================================

describe('Backtest E2E — engine → analyzer → persistence', () => {
  let testDir: string;
  let persistence: PersistenceService;

  beforeEach(async () => {
    Store.getInstance().reset();
    testDir = join(tmpdir(), `backtest-e2e-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    persistence = new PersistenceService(join(testDir, 'e2e.db'));
  });

  afterEach(async () => {
    persistence.close();
    await rm(testDir, { recursive: true, force: true });
  });

  it('runs backtest, analyzes metrics, and persists result to SQLite', async () => {
    const loader = createDefaultLoader();
    const connector = createDefaultConnector(loader);
    const strategy = new SimpleTestStrategy(2);
    const config = createDefaultConfig();

    // Run backtest
    const engine = new BacktestEngine(config, strategy, loader, connector);
    const result = await engine.run();

    expect(result.totalTrades).toBeGreaterThan(0);
    expect(result.equityCurve.length).toBeGreaterThan(1);

    // Analyze
    const analyzer = new PerformanceAnalyzer();
    const metrics = analyzer.analyze(result);

    expect(typeof metrics.sharpeRatio).toBe('number');
    expect(typeof metrics.maxDrawdown).toBe('number');
    expect(typeof metrics.winRate).toBe('number');

    // Persist
    const backtestId = `bt-e2e-${Date.now()}`;
    persistence.saveBacktestResult({
      id: backtestId,
      strategyName: config.strategyName,
      startDate: result.startDate,
      endDate: result.endDate,
      initialCapital: result.initialCapital.toString(),
      finalPortfolioValue: result.finalPortfolioValue.toString(),
      totalTrades: result.totalTrades,
      totalReturn: metrics.totalReturn,
      sharpeRatio: metrics.sharpeRatio,
      sortinoRatio: metrics.sortinoRatio,
      maxDrawdown: metrics.maxDrawdown,
      winRate: metrics.winRate,
      profitFactor: metrics.profitFactor,
      calmarRatio: metrics.calmarRatio,
      annualizedReturn: metrics.annualizedReturn,
      parametersJson: null,
      equityCurveJson: JSON.stringify(
        result.equityCurve.map((p) => ({
          timestamp: p.timestamp,
          portfolioValue: p.portfolioValue.toString(),
        })),
      ),
      tradeLogJson: JSON.stringify(
        result.tradeLog.map((t) => ({
          ...t,
          amount: t.amount.toString(),
          fees: t.fees.toString(),
          pnl: t.pnl.toString(),
        })),
      ),
      durationMs: result.durationMs,
    });

    // Verify retrieval
    const { entries, total } = persistence.getBacktestResults(10, 0);
    expect(total).toBe(1);
    expect(entries[0].id).toBe(backtestId);
    expect(entries[0].strategy_name).toBe(config.strategyName);
    expect(entries[0].total_trades).toBe(result.totalTrades);
    expect(Number(entries[0].sharpe_ratio)).toBeCloseTo(metrics.sharpeRatio, 4);
  });

  it('optimizer grid search results can be persisted', async () => {
    const loader = createDefaultLoader();
    const analyzer = new PerformanceAnalyzer();
    const config = createDefaultConfig();

    const engineFactory = (strategy: CrossChainStrategy, cfg: BacktestConfig) => {
      Store.getInstance().reset();
      const freshConnector = createDefaultConnector(loader);
      return new BacktestEngine(cfg, strategy, loader, freshConnector);
    };

    const strategyFactory = (_params: Record<string, number>) => {
      return new SimpleTestStrategy(_params.maxTrades ?? 2);
    };

    const optimizer = new StrategyOptimizer(engineFactory, analyzer);
    const result = await optimizer.optimize(
      strategyFactory,
      { maxTrades: [1, 2] },
      config,
      5,
    );

    expect(result.totalCombinations).toBe(2);
    expect(result.parameterSets.length).toBeGreaterThan(0);

    // Persist the top result
    const top = result.parameterSets[0];
    persistence.saveBacktestResult({
      id: `opt-${Date.now()}`,
      strategyName: config.strategyName,
      startDate: config.startDate,
      endDate: config.endDate,
      initialCapital: config.initialCapital.toString(),
      finalPortfolioValue: '0',
      totalTrades: top.inSampleMetrics.totalTrades,
      totalReturn: top.inSampleMetrics.totalReturn,
      sharpeRatio: top.inSampleMetrics.sharpeRatio,
      sortinoRatio: top.inSampleMetrics.sortinoRatio,
      maxDrawdown: top.inSampleMetrics.maxDrawdown,
      winRate: top.inSampleMetrics.winRate,
      profitFactor: top.inSampleMetrics.profitFactor,
      calmarRatio: top.inSampleMetrics.calmarRatio,
      annualizedReturn: top.inSampleMetrics.annualizedReturn,
      parametersJson: JSON.stringify(top.parameters),
      equityCurveJson: '[]',
      tradeLogJson: '[]',
      durationMs: result.durationMs,
    });

    const { total } = persistence.getBacktestResults();
    expect(total).toBe(1);
  });
});
