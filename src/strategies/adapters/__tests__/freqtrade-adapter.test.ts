import { describe, it, expect, beforeEach } from 'vitest';
import { FreqtradeAdapter, resetActionCounter } from '../freqtrade-adapter.js';
import type { DataFrame, DataFrameRow } from '../freqtrade-adapter.js';
import { Store } from '../../../core/store.js';
import type {
  StrategyContext,
  StrategySignal,
  ChainId,
  TokenInfo,
  Position,
} from '../../../core/types.js';
import { chainId, tokenAddress } from '../../../core/types.js';
import { CHAINS, USDC_ADDRESSES } from '../../../core/constants.js';

// ---------------------------------------------------------------------------
// Concrete test implementation of FreqtradeAdapter
// ---------------------------------------------------------------------------

class TestFreqtradeStrategy extends FreqtradeAdapter {
  readonly name = 'TestFreqtrade';
  readonly timeframe = '5m';

  override readonly stoploss = -0.08;
  override readonly minimalRoi: Readonly<Record<number, number>> = { 0: 0.05, 60: 0.02 };
  override readonly trailingStop = true;
  override readonly trailingStopPositive: number | undefined = 0.03;
  override readonly maxPositions = 2;

  populateIndicators(dataframe: DataFrame): DataFrame {
    // Add a simple moving indicator for testing
    return dataframe.map((row) => ({
      ...row,
      test_indicator: row.close > 100 ? 1 : 0,
    }));
  }

  populateEntryTrend(dataframe: DataFrame): DataFrame {
    return dataframe.map((row) => ({
      ...row,
      enter_long: row.test_indicator === 1,
    }));
  }

  populateExitTrend(dataframe: DataFrame): DataFrame {
    return dataframe.map((row) => ({
      ...row,
      exit_long: (row.close as number) > 150,
    }));
  }
}

// Strategy with custom stoploss override
class CustomStoplossStrategy extends TestFreqtradeStrategy {
  override readonly name = 'CustomStoplossFreqtrade';

  override customStoploss(_position: Position, currentProfit: number): number {
    // Tighten stoploss as profit increases
    if (currentProfit > 0.05) {
      return -0.02;
    }
    return this.stoploss;
  }
}

// Strategy with short signals
class ShortStrategy extends FreqtradeAdapter {
  readonly name = 'ShortFreqtrade';
  readonly timeframe = '1h';

  populateIndicators(dataframe: DataFrame): DataFrame {
    return dataframe;
  }

  populateEntryTrend(dataframe: DataFrame): DataFrame {
    return dataframe.map((row) => ({
      ...row,
      enter_short: (row.close as number) > 200,
    }));
  }

  populateExitTrend(dataframe: DataFrame): DataFrame {
    return dataframe.map((row) => ({
      ...row,
      exit_short: (row.close as number) < 100,
    }));
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(overrides: Partial<StrategyContext> = {}): StrategyContext {
  return {
    timestamp: Date.now(),
    balances: new Map(),
    positions: [],
    prices: new Map(),
    activeTransfers: [],
    ...overrides,
  };
}

function makeOhlcvRow(close: number, overrides: Partial<DataFrameRow> = {}): DataFrameRow {
  return {
    open: close - 1,
    high: close + 2,
    low: close - 2,
    close,
    volume: 1000,
    ...overrides,
  };
}

function makePosition(id: string = 'pos-1'): Position {
  return {
    id,
    strategyId: 'TestFreqtrade',
    chainId: chainId(1),
    tokenAddress: tokenAddress('0x0000000000000000000000000000000000000001'),
    entryPrice: 100,
    currentPrice: 110,
    amount: 1000000000000000000n,
    enteredAt: Date.now(),
    pnlUsd: 10,
    pnlPercent: 0.1,
  };
}

const testToken: TokenInfo = {
  address: tokenAddress('0x0000000000000000000000000000000000000abc'),
  symbol: 'WETH',
  decimals: 18,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FreqtradeAdapter', () => {
  let strategy: TestFreqtradeStrategy;
  const store = Store.getInstance();

  beforeEach(() => {
    store.reset();
    resetActionCounter();
    strategy = new TestFreqtradeStrategy();
  });

  describe('populate chain called in correct sequence', () => {
    it('calls populateIndicators -> populateEntryTrend -> populateExitTrend in order', () => {
      const callOrder: string[] = [];

      class OrderTrackingStrategy extends FreqtradeAdapter {
        readonly name = 'OrderTracking';
        readonly timeframe = '5m';

        populateIndicators(dataframe: DataFrame): DataFrame {
          callOrder.push('indicators');
          return dataframe.map((row) => ({ ...row, ind: 1 }));
        }

        populateEntryTrend(dataframe: DataFrame): DataFrame {
          callOrder.push('entry');
          // Verify indicators were already populated
          expect(dataframe[0].ind).toBe(1);
          return dataframe.map((row) => ({ ...row, enter_long: true }));
        }

        populateExitTrend(dataframe: DataFrame): DataFrame {
          callOrder.push('exit');
          // Verify entry trend was already populated
          expect(dataframe[0].enter_long).toBe(true);
          return dataframe.map((row) => ({ ...row, exit_long: false }));
        }
      }

      const tracker = new OrderTrackingStrategy();
      tracker.setOhlcvData([makeOhlcvRow(105)]);
      tracker.shouldExecute(makeContext());

      expect(callOrder).toEqual(['indicators', 'entry', 'exit']);
    });

    it('does not mutate the original OHLCV data', () => {
      const originalData: DataFrame = [makeOhlcvRow(105), makeOhlcvRow(110)];
      const originalLength = originalData.length;
      const originalFirstClose = originalData[0].close;

      strategy.setOhlcvData(originalData);
      strategy.shouldExecute(makeContext());

      expect(originalData.length).toBe(originalLength);
      expect(originalData[0].close).toBe(originalFirstClose);
      // Ensure no indicator columns were added to original
      expect(originalData[0]).not.toHaveProperty('test_indicator');
    });
  });

  describe('last row signal mapping to StrategySignal', () => {
    it('maps enter_long to long direction signal', () => {
      strategy.setOhlcvData([makeOhlcvRow(80), makeOhlcvRow(105)]); // last row close > 100
      strategy.setTradeToken(testToken, CHAINS.ETHEREUM);

      const signal = strategy.shouldExecute(makeContext());

      expect(signal).not.toBeNull();
      expect(signal!.direction).toBe('long');
      expect(signal!.reason).toContain('enter_long');
    });

    it('maps exit_long to exit direction signal', () => {
      // close > 150 triggers exit_long in our test strategy
      strategy.setOhlcvData([makeOhlcvRow(80), makeOhlcvRow(155)]);
      strategy.setTradeToken(testToken, CHAINS.ETHEREUM);

      const signal = strategy.shouldExecute(makeContext());

      expect(signal).not.toBeNull();
      // exit signals have higher priority than entry signals
      expect(signal!.direction).toBe('exit');
      expect(signal!.reason).toContain('exit_long');
    });

    it('maps enter_short to short direction signal', () => {
      const shortStrategy = new ShortStrategy();
      shortStrategy.setOhlcvData([makeOhlcvRow(100), makeOhlcvRow(210)]); // close > 200
      shortStrategy.setTradeToken(testToken, CHAINS.ETHEREUM);

      const signal = shortStrategy.shouldExecute(makeContext());

      expect(signal).not.toBeNull();
      expect(signal!.direction).toBe('short');
      expect(signal!.reason).toContain('enter_short');
    });

    it('returns null when no signals are triggered', () => {
      // close = 90, not > 100 (no entry), not > 150 (no exit)
      strategy.setOhlcvData([makeOhlcvRow(90)]);
      strategy.setTradeToken(testToken, CHAINS.ETHEREUM);

      const signal = strategy.shouldExecute(makeContext());

      expect(signal).toBeNull();
    });

    it('returns null when OHLCV data is empty', () => {
      strategy.setOhlcvData([]);

      const signal = strategy.shouldExecute(makeContext());

      expect(signal).toBeNull();
    });

    it('includes serialized last row in signal metadata', () => {
      strategy.setOhlcvData([makeOhlcvRow(105)]);
      strategy.setTradeToken(testToken, CHAINS.ETHEREUM);

      const signal = strategy.shouldExecute(makeContext());

      expect(signal).not.toBeNull();
      expect(signal!.metadata.signalSource).toBe('freqtrade_adapter');
      expect(signal!.metadata.lastRow).toBeDefined();
    });
  });

  describe('risk param mapping', () => {
    it('maps stoploss correctly in getFreqtradeRiskConfig', () => {
      const config = strategy.getFreqtradeRiskConfig();

      expect(config.stoploss).toBe(-0.08);
    });

    it('maps minimal_roi with string keys', () => {
      const config = strategy.getFreqtradeRiskConfig();

      expect(config.minimal_roi).toEqual({ '0': 0.05, '60': 0.02 });
    });

    it('maps trailing_stop params', () => {
      const config = strategy.getFreqtradeRiskConfig();

      expect(config.trailing_stop).toBe(true);
      expect(config.trailing_stop_positive).toBe(0.03);
    });

    it('includes risk config in execution plan metadata', () => {
      strategy.setOhlcvData([makeOhlcvRow(105)]);
      strategy.setTradeToken(testToken, CHAINS.ETHEREUM);

      const signal = strategy.shouldExecute(makeContext());
      expect(signal).not.toBeNull();

      const plan = strategy.buildExecution(signal!, makeContext());

      expect(plan.metadata.riskConfig).toBeDefined();
      const riskConfig = plan.metadata.riskConfig as Record<string, unknown>;
      expect(riskConfig.stoploss).toBe(-0.08);
      expect(riskConfig.trailing_stop).toBe(true);
    });

    it('includes absolute stoploss in swap action metadata', () => {
      strategy.setOhlcvData([makeOhlcvRow(105)]);
      strategy.setTradeToken(testToken, CHAINS.ETHEREUM);

      const signal = strategy.shouldExecute(makeContext());
      expect(signal).not.toBeNull();

      const plan = strategy.buildExecution(signal!, makeContext());
      const swapAction = plan.actions.find((a) => a.type === 'swap');

      expect(swapAction).toBeDefined();
      const swapMeta = swapAction!.metadata as Record<string, unknown>;
      const riskMeta = swapMeta.riskConfig as Record<string, unknown>;
      expect(riskMeta.stoploss).toBe(0.08); // absolute value
    });
  });

  describe('customStoploss override', () => {
    it('returns static stoploss by default', () => {
      const position = makePosition();

      expect(strategy.customStoploss(position, 0.02)).toBe(-0.08);
    });

    it('allows subclass override for dynamic stoploss', () => {
      const customStrategy = new CustomStoplossStrategy();
      const position = makePosition();

      // Below 5% profit — use default stoploss
      expect(customStrategy.customStoploss(position, 0.03)).toBe(-0.08);

      // Above 5% profit — tighten to -2%
      expect(customStrategy.customStoploss(position, 0.06)).toBe(-0.02);
    });
  });

  describe('buildExecution with LI.FI bridge', () => {
    it('creates only swap action for same-chain trade', () => {
      strategy.setOhlcvData([makeOhlcvRow(105)]);
      strategy.setTradeToken(testToken, CHAINS.ETHEREUM);

      const signal = strategy.shouldExecute(makeContext());
      expect(signal).not.toBeNull();
      expect(signal!.sourceChain).toBe(signal!.destChain);

      const plan = strategy.buildExecution(signal!, makeContext());

      expect(plan.actions).toHaveLength(1);
      expect(plan.actions[0].type).toBe('swap');
      expect(plan.estimatedDurationMs).toBe(30_000);
      expect(plan.estimatedCostUsd).toBe(1);
    });

    it('prepends bridge action for cross-chain trade', () => {
      strategy.setOhlcvData([makeOhlcvRow(105)]);
      strategy.setTradeToken(testToken, CHAINS.ETHEREUM);

      const signal = strategy.shouldExecute(makeContext());
      expect(signal).not.toBeNull();

      // Modify signal to be cross-chain
      const crossChainSignal: StrategySignal = {
        ...signal!,
        sourceChain: CHAINS.ETHEREUM,
        destChain: CHAINS.ARBITRUM,
      };

      const plan = strategy.buildExecution(crossChainSignal, makeContext());

      expect(plan.actions).toHaveLength(2);
      expect(plan.actions[0].type).toBe('bridge');
      expect(plan.actions[0].fromChain).toBe(CHAINS.ETHEREUM);
      expect((plan.actions[0] as { toChain: ChainId }).toChain).toBe(CHAINS.ARBITRUM);
      expect(plan.actions[1].type).toBe('swap');
      expect(plan.estimatedDurationMs).toBe(150_000);
      expect(plan.estimatedCostUsd).toBe(5);
    });

    it('sets correct priorities for bridge + swap', () => {
      const crossChainSignal: StrategySignal = {
        direction: 'long',
        tokenPair: {
          from: { address: USDC_ADDRESSES[1]!, symbol: 'USDC', decimals: 6 },
          to: testToken,
        },
        sourceChain: CHAINS.ETHEREUM,
        destChain: CHAINS.ARBITRUM,
        strength: 0.7,
        reason: 'test',
        metadata: {},
      };

      const plan = strategy.buildExecution(crossChainSignal, makeContext());

      expect(plan.actions[0].priority).toBe(1); // bridge first
      expect(plan.actions[1].priority).toBe(2); // swap second
    });
  });

  describe('data injection', () => {
    it('setOhlcvData stores data accessible to shouldExecute', () => {
      const data: DataFrame = [makeOhlcvRow(50), makeOhlcvRow(105)];
      strategy.setOhlcvData(data);

      expect(strategy.getOhlcvData()).toEqual(data);
    });

    it('setTradeToken stores token and chain', () => {
      strategy.setTradeToken(testToken, CHAINS.ARBITRUM);

      expect(strategy.getTradeToken()).toEqual(testToken);
      expect(strategy.getTradeChain()).toBe(CHAINS.ARBITRUM);
    });

    it('uses USDC as base token for signal token pair', () => {
      strategy.setOhlcvData([makeOhlcvRow(105)]);
      strategy.setTradeToken(testToken, CHAINS.ETHEREUM);

      const signal = strategy.shouldExecute(makeContext());

      expect(signal).not.toBeNull();
      // For entry: from = base (USDC), to = trade token
      expect(signal!.tokenPair.from.symbol).toBe('USDC');
      expect(signal!.tokenPair.to.address).toBe(testToken.address);
    });
  });

  describe('max positions handling', () => {
    it('returns null when at max positions and no exit signal', () => {
      strategy.setOhlcvData([makeOhlcvRow(105)]); // entry signal but not exit (< 150)
      strategy.setTradeToken(testToken, CHAINS.ETHEREUM);

      const ctx = makeContext({
        positions: [makePosition('p1'), makePosition('p2')], // maxPositions = 2
      });

      const signal = strategy.shouldExecute(ctx);

      expect(signal).toBeNull();
    });

    it('returns exit signal when at max positions with exit condition', () => {
      strategy.setOhlcvData([makeOhlcvRow(155)]); // triggers exit_long (close > 150)
      strategy.setTradeToken(testToken, CHAINS.ETHEREUM);

      const ctx = makeContext({
        positions: [makePosition('p1'), makePosition('p2')], // maxPositions = 2
      });

      const signal = strategy.shouldExecute(ctx);

      expect(signal).not.toBeNull();
      expect(signal!.direction).toBe('exit');
    });
  });

  describe('config validation', () => {
    it('passes validation with valid risk params', () => {
      expect(() => strategy.validateConfig()).not.toThrow();
    });

    it('strategy name is set correctly', () => {
      expect(strategy.name).toBe('TestFreqtrade');
    });

    it('strategy timeframe is set correctly', () => {
      expect(strategy.timeframe).toBe('5m');
    });
  });
});
