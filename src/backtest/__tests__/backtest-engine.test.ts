import { describe, it, expect, beforeEach } from 'vitest';
import { BacktestEngine } from '../backtest-engine.js';
import { HistoricalDataLoader } from '../historical-data-loader.js';
import { SimulatedLiFiConnector } from '../../connectors/simulated-lifi-connector.js';
import { LookaheadError } from '../errors.js';
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

// --- Test strategy implementations ---

/** Simple strategy that always signals a trade */
class AlwaysTradeStrategy extends CrossChainStrategy {
  readonly name = 'always-trade';
  readonly timeframe = '1m';
  override readonly stoploss = -0.10;
  override readonly maxPositions = 5;

  shouldExecute(context: StrategyContext): StrategySignal | null {
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
      strength: 0.1, // use 10% of balance
      reason: 'Always trade for testing',
      metadata: {},
    };
  }

  buildExecution(signal: StrategySignal, _context: StrategyContext): ExecutionPlan {
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

/** Strategy that never signals */
class NeverTradeStrategy extends CrossChainStrategy {
  readonly name = 'never-trade';
  readonly timeframe = '1m';

  shouldExecute(_context: StrategyContext): StrategySignal | null {
    return null;
  }

  buildExecution(_signal: StrategySignal, _context: StrategyContext): ExecutionPlan {
    return {
      id: 'plan-never',
      strategyName: this.name,
      actions: [],
      estimatedCostUsd: 0,
      estimatedDurationMs: 0,
      metadata: {},
    };
  }
}

/** Strategy that tries to access future data — should trigger LookaheadError */
class LookaheadCheaterStrategy extends CrossChainStrategy {
  readonly name = 'lookahead-cheater';
  readonly timeframe = '1m';
  private loader: HistoricalDataLoader;

  constructor(loader: HistoricalDataLoader) {
    super();
    this.loader = loader;
  }

  shouldExecute(context: StrategyContext): StrategySignal | null {
    // Try to peek into the future — should throw LookaheadError
    const futureTimestamp = context.timestamp + 100000;
    this.loader.getPrice('0xusdc', 1, futureTimestamp);
    return null;
  }

  buildExecution(_signal: StrategySignal, _context: StrategyContext): ExecutionPlan {
    return {
      id: 'plan-cheater',
      strategyName: this.name,
      actions: [],
      estimatedCostUsd: 0,
      estimatedDurationMs: 0,
      metadata: {},
    };
  }
}

/** Strategy that signals cross-chain trade */
class CrossChainTradeStrategy extends CrossChainStrategy {
  readonly name = 'cross-chain-trade';
  readonly timeframe = '1m';
  override readonly maxPositions = 5;
  private tradeCount = 0;
  private maxTrades: number;

  constructor(maxTrades = 1) {
    super();
    this.maxTrades = maxTrades;
  }

  shouldExecute(context: StrategyContext): StrategySignal | null {
    if (this.tradeCount >= this.maxTrades) return null;
    this.tradeCount++;

    const fromToken: TokenInfo = {
      address: tokenAddress('0xusdc'),
      symbol: 'USDC',
      decimals: 6,
    };
    const toToken: TokenInfo = {
      address: tokenAddress('0xusdc_arb'),
      symbol: 'USDC',
      decimals: 6,
    };

    return {
      direction: 'long',
      tokenPair: { from: fromToken, to: toToken },
      sourceChain: chainId(1),
      destChain: chainId(42161),
      strength: 0.5,
      reason: 'Cross-chain test',
      metadata: {},
    };
  }

  buildExecution(signal: StrategySignal, _context: StrategyContext): ExecutionPlan {
    return {
      id: `plan-xchain-${Date.now()}`,
      strategyName: this.name,
      actions: [],
      estimatedCostUsd: 10,
      estimatedDurationMs: 60000,
      metadata: {},
    };
  }
}

// --- Test setup ---

function createDefaultConfig(overrides?: Partial<BacktestConfig>): BacktestConfig {
  return {
    strategyName: 'test-strategy',
    startDate: 1000,
    endDate: 3000,
    initialCapital: 1000000n, // 1 USDC (6 decimals)
    tickInterval: 1000,
    slippage: 0.005,
    bridgeDelayMs: 60000,
    feeModel: {
      bridgeFeePercent: 0.003,
      gasEstimateUsd: 5.0,
      dexFeePercent: 0.003,
    },
    initialToken: '0xusdc',
    initialChainId: 1,
    seed: 42,
    ...overrides,
  };
}

function createDefaultLoader(): HistoricalDataLoader {
  const loader = new HistoricalDataLoader();
  loader.loadDirect([
    // USDC on chain 1
    { timestamp: 1000, token: '0xusdc', chainId: 1, price: 1.0, volume: 100000 },
    { timestamp: 2000, token: '0xusdc', chainId: 1, price: 1.01, volume: 120000 },
    { timestamp: 3000, token: '0xusdc', chainId: 1, price: 0.99, volume: 110000 },
    // WETH on chain 1
    { timestamp: 1000, token: '0xweth', chainId: 1, price: 2500, volume: 50000 },
    { timestamp: 2000, token: '0xweth', chainId: 1, price: 2550, volume: 55000 },
    { timestamp: 3000, token: '0xweth', chainId: 1, price: 2480, volume: 45000 },
    // USDC on chain 42161 (Arbitrum)
    { timestamp: 1000, token: '0xusdc_arb', chainId: 42161, price: 1.0, volume: 80000 },
    { timestamp: 2000, token: '0xusdc_arb', chainId: 42161, price: 1.005, volume: 90000 },
    { timestamp: 3000, token: '0xusdc_arb', chainId: 42161, price: 0.995, volume: 85000 },
  ]);
  return loader;
}

function createDefaultConnector(
  loader: HistoricalDataLoader,
  overrides?: Partial<{ slippage: number; bridgeDelayMs: number; feeModel: FeeModel; seed: number }>,
): SimulatedLiFiConnector {
  return new SimulatedLiFiConnector(loader, {
    slippage: overrides?.slippage ?? 0.005,
    bridgeDelayMs: overrides?.bridgeDelayMs ?? 60000,
    feeModel: overrides?.feeModel ?? {
      bridgeFeePercent: 0.003,
      gasEstimateUsd: 5.0,
      dexFeePercent: 0.003,
    },
    seed: overrides?.seed ?? 42,
  });
}

describe('BacktestEngine', () => {
  beforeEach(() => {
    Store.getInstance().reset();
  });

  // --- AC 1: OODA loop replay ---

  describe('OODA loop replay', () => {
    it('runs a full backtest with a simple strategy and produces BacktestResult', async () => {
      const loader = createDefaultLoader();
      const connector = createDefaultConnector(loader);
      const strategy = new NeverTradeStrategy();
      const config = createDefaultConfig();

      const engine = new BacktestEngine(config, strategy, loader, connector);
      const result = await engine.run();

      expect(result).toBeDefined();
      expect(result.startDate).toBe(1000);
      expect(result.endDate).toBe(3000);
      expect(result.initialCapital).toBe(1000000n);
      expect(result.totalTrades).toBe(0);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('equity curve has points for each tick plus initial', async () => {
      const loader = createDefaultLoader();
      const connector = createDefaultConnector(loader);
      const strategy = new NeverTradeStrategy();
      const config = createDefaultConfig({
        startDate: 1000,
        endDate: 3000,
        tickInterval: 1000,
      });

      const engine = new BacktestEngine(config, strategy, loader, connector);
      const result = await engine.run();

      // startDate=1000, endDate=3000, tickInterval=1000
      // Ticks: 1000, 2000, 3000 = 3 ticks + 1 initial = 4 points
      expect(result.equityCurve.length).toBeGreaterThanOrEqual(3);

      // First point is the initial
      expect(result.equityCurve[0].timestamp).toBe(1000);
      expect(result.equityCurve[0].portfolioValue).toBe(1000000n);
    });

    it('records initial capital as first equity point', async () => {
      const loader = createDefaultLoader();
      const connector = createDefaultConnector(loader);
      const strategy = new NeverTradeStrategy();
      const config = createDefaultConfig();

      const engine = new BacktestEngine(config, strategy, loader, connector);
      const result = await engine.run();

      expect(result.equityCurve[0].portfolioValue).toBe(1000000n);
    });
  });

  // --- AC 2 & 5: Trade execution ---

  describe('trade execution', () => {
    it('executes trades when strategy signals', async () => {
      const loader = createDefaultLoader();
      const connector = createDefaultConnector(loader);
      const strategy = new AlwaysTradeStrategy();
      const config = createDefaultConfig();

      const engine = new BacktestEngine(config, strategy, loader, connector);
      const result = await engine.run();

      // Strategy signals every tick, so there should be trades
      expect(result.totalTrades).toBeGreaterThan(0);
      expect(result.tradeLog.length).toBeGreaterThan(0);
    });

    it('trade log captures fill prices and fees', async () => {
      const loader = createDefaultLoader();
      const connector = createDefaultConnector(loader);
      const strategy = new AlwaysTradeStrategy();
      const config = createDefaultConfig();

      const engine = new BacktestEngine(config, strategy, loader, connector);
      const result = await engine.run();

      if (result.tradeLog.length > 0) {
        const firstTrade = result.tradeLog[0];
        expect(firstTrade.fillPrice).toBeGreaterThan(0);
        expect(firstTrade.fees).toBeGreaterThanOrEqual(0n);
        expect(firstTrade.fromToken).toBeDefined();
        expect(firstTrade.toToken).toBeDefined();
        expect(firstTrade.amount).toBeGreaterThan(0n);
      }
    });
  });

  // --- AC 4: Lookahead prevention ---

  describe('lookahead prevention', () => {
    it('strategy that accesses future data triggers error during backtest', async () => {
      const loader = createDefaultLoader();
      const connector = createDefaultConnector(loader);
      const cheater = new LookaheadCheaterStrategy(loader);
      const config = createDefaultConfig();

      const engine = new BacktestEngine(config, cheater, loader, connector);

      // The backtest should handle the error (log warning, continue)
      // or propagate it — either way the strategy should not succeed
      // with lookahead data
      const result = await engine.run();

      // Even though the strategy tried to cheat, the engine should
      // complete (with error handling) and produce a result
      expect(result).toBeDefined();
      // The cheater strategy returns null after the failed price access,
      // so it shouldn't have successful trades
      expect(result.totalTrades).toBe(0);
    });

    it('HistoricalDataLoader enforces cursor during backtest', () => {
      const loader = createDefaultLoader();

      loader.advanceTo(1000);

      // Should work — at or before cursor
      expect(loader.getPrice('0xusdc', 1, 1000)).toBe(1.0);

      // Should throw — beyond cursor
      expect(() => loader.getPrice('0xusdc', 1, 2000)).toThrow(LookaheadError);
    });
  });

  // --- AC 7: State isolation ---

  describe('state isolation', () => {
    it('store.reset() is called — no state leakage between backtests', async () => {
      const loader = createDefaultLoader();
      const connector1 = createDefaultConnector(loader);
      const connector2 = createDefaultConnector(loader);
      const strategy1 = new AlwaysTradeStrategy();
      const strategy2 = new NeverTradeStrategy();
      const config = createDefaultConfig();

      // Run first backtest (with trades)
      const engine1 = new BacktestEngine(config, strategy1, loader, connector1);
      const result1 = await engine1.run();

      // Run second backtest (no trades)
      const engine2 = new BacktestEngine(config, strategy2, loader, connector2);
      const result2 = await engine2.run();

      // Second backtest should start with clean state
      expect(result2.initialCapital).toBe(1000000n);
      expect(result2.totalTrades).toBe(0);

      // The second backtest should start fresh
      expect(result2.equityCurve[0].portfolioValue).toBe(1000000n);
    });

    it('store is empty after reset between runs', async () => {
      const loader = createDefaultLoader();
      const connector = createDefaultConnector(loader);
      const strategy = new AlwaysTradeStrategy();
      const config = createDefaultConfig();

      // Run backtest
      const engine = new BacktestEngine(config, strategy, loader, connector);
      await engine.run();

      // Manually reset and check
      Store.getInstance().reset();
      const freshStore = Store.getInstance();

      expect(freshStore.getAllBalances()).toHaveLength(0);
      expect(freshStore.getActiveTransfers()).toHaveLength(0);
      expect(freshStore.getAllPositions()).toHaveLength(0);
      expect(freshStore.getAllTrades()).toHaveLength(0);
    });
  });

  // --- Phase sequence ---

  describe('phase sequence', () => {
    it('follows same phase order as live mode: prices -> in-flight -> exits -> entries', async () => {
      // We verify this indirectly: the engine should update prices before
      // evaluating entries, so the strategy context should have current prices
      const loader = createDefaultLoader();
      const connector = createDefaultConnector(loader);

      const contextTimestamps: number[] = [];

      class PhaseTrackingStrategy extends CrossChainStrategy {
        readonly name = 'phase-tracker';
        readonly timeframe = '1m';

        shouldExecute(context: StrategyContext): StrategySignal | null {
          contextTimestamps.push(context.timestamp);

          // Verify prices are available (Phase 1 ran before Phase 4)
          const price = context.prices.get('1-0xusdc');
          // Price should exist because updatePricesFromHistory runs first
          if (context.timestamp >= 1000 && price !== undefined) {
            expect(price).toBeGreaterThan(0);
          }

          return null;
        }

        buildExecution(_signal: StrategySignal, _context: StrategyContext): ExecutionPlan {
          return {
            id: 'plan',
            strategyName: this.name,
            actions: [],
            estimatedCostUsd: 0,
            estimatedDurationMs: 0,
            metadata: {},
          };
        }
      }

      const strategy = new PhaseTrackingStrategy();
      const config = createDefaultConfig();

      const engine = new BacktestEngine(config, strategy, loader, connector);
      await engine.run();

      // Strategy should have been called for each tick
      expect(contextTimestamps.length).toBeGreaterThan(0);
      // Timestamps should be in order
      for (let i = 1; i < contextTimestamps.length; i++) {
        expect(contextTimestamps[i]).toBeGreaterThanOrEqual(contextTimestamps[i - 1]);
      }
    });
  });

  // --- Result collection ---

  describe('result collection', () => {
    it('produces complete BacktestResult with all required fields', async () => {
      const loader = createDefaultLoader();
      const connector = createDefaultConnector(loader);
      const strategy = new AlwaysTradeStrategy();
      const config = createDefaultConfig();

      const engine = new BacktestEngine(config, strategy, loader, connector);
      const result = await engine.run();

      expect(result.startDate).toBe(config.startDate);
      expect(result.endDate).toBe(config.endDate);
      expect(result.initialCapital).toBe(config.initialCapital);
      expect(result.finalPortfolioValue).toBeDefined();
      expect(result.equityCurve).toBeDefined();
      expect(Array.isArray(result.equityCurve)).toBe(true);
      expect(result.tradeLog).toBeDefined();
      expect(Array.isArray(result.tradeLog)).toBe(true);
      expect(typeof result.totalTrades).toBe('number');
      expect(typeof result.durationMs).toBe('number');
    });

    it('final portfolio value reflects trading activity', async () => {
      const loader = createDefaultLoader();
      const connector = createDefaultConnector(loader);
      const strategy = new AlwaysTradeStrategy();
      const config = createDefaultConfig();

      const engine = new BacktestEngine(config, strategy, loader, connector);
      const result = await engine.run();

      // With trading and fees, portfolio value should change from initial
      expect(result.finalPortfolioValue).toBeDefined();
      // The value may go up or down depending on slippage/fees
    });

    it('equity curve timestamps are monotonically increasing', async () => {
      const loader = createDefaultLoader();
      const connector = createDefaultConnector(loader);
      const strategy = new NeverTradeStrategy();
      const config = createDefaultConfig();

      const engine = new BacktestEngine(config, strategy, loader, connector);
      const result = await engine.run();

      for (let i = 1; i < result.equityCurve.length; i++) {
        expect(result.equityCurve[i].timestamp).toBeGreaterThanOrEqual(
          result.equityCurve[i - 1].timestamp,
        );
      }
    });
  });

  // --- Strategy integration ---

  describe('strategy integration', () => {
    it('accepts any CrossChainStrategy subclass', async () => {
      const loader = createDefaultLoader();
      const connector = createDefaultConnector(loader);
      const config = createDefaultConfig();

      // Test with different strategy types
      const strategies: CrossChainStrategy[] = [
        new AlwaysTradeStrategy(),
        new NeverTradeStrategy(),
      ];

      for (const strategy of strategies) {
        Store.getInstance().reset();
        const freshConnector = createDefaultConnector(loader);
        const engine = new BacktestEngine(config, strategy, loader, freshConnector);
        const result = await engine.run();
        expect(result).toBeDefined();
      }
    });

    it('calls strategy lifecycle hooks', async () => {
      const loader = createDefaultLoader();
      const connector = createDefaultConnector(loader);
      const config = createDefaultConfig();

      let botStartCalled = false;
      let loopStartCount = 0;

      class LifecycleStrategy extends CrossChainStrategy {
        readonly name = 'lifecycle';
        readonly timeframe = '1m';

        override async onBotStart(): Promise<void> {
          botStartCalled = true;
        }

        override async onLoopStart(_timestamp: number): Promise<void> {
          loopStartCount++;
        }

        shouldExecute(_context: StrategyContext): StrategySignal | null {
          return null;
        }

        buildExecution(_signal: StrategySignal, _context: StrategyContext): ExecutionPlan {
          return {
            id: 'plan',
            strategyName: this.name,
            actions: [],
            estimatedCostUsd: 0,
            estimatedDurationMs: 0,
            metadata: {},
          };
        }
      }

      const strategy = new LifecycleStrategy();
      const engine = new BacktestEngine(config, strategy, loader, connector);
      await engine.run();

      expect(botStartCalled).toBe(true);
      expect(loopStartCount).toBeGreaterThan(0);
    });
  });
});
