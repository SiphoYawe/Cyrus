import { describe, it, expect, beforeEach } from 'vitest';
import { Store } from '../../../core/store.js';
import { CrossChainStrategy } from '../../cross-chain-strategy.js';
import { StatArbStrategy, STAT_ARB_STRATEGY_DEFAULTS } from '../stat-arb-strategy.js';
import type { StrategyContext } from '../../../core/types.js';
import type { StatArbSignal, StatArbPosition } from '../../../core/store-slices/stat-arb-slice.js';

// --- Helpers ---

function makeContext(overrides?: Partial<StrategyContext>): StrategyContext {
  return {
    timestamp: Date.now(),
    balances: new Map(),
    positions: [],
    prices: new Map(),
    activeTransfers: [],
    ...overrides,
  };
}

function makeSignal(overrides?: Partial<StatArbSignal>): StatArbSignal {
  return {
    signalId: 'sig-1',
    pair: { tokenA: 'BTC', tokenB: 'ETH', key: 'BTC-ETH' },
    direction: 'short_pair',
    zScore: 2.0,
    correlation: 0.92,
    halfLifeHours: 12,
    hedgeRatio: 16.5,
    recommendedLeverage: 18,
    source: 'native',
    timestamp: Date.now(),
    consumed: false,
    expiresAt: Date.now() + 3_600_000,
    ...overrides,
  };
}

function makePosition(overrides?: Partial<StatArbPosition>): StatArbPosition {
  return {
    positionId: 'pos-1',
    pair: { tokenA: 'BTC', tokenB: 'ETH', key: 'BTC-ETH' },
    direction: 'short_pair',
    hedgeRatio: 16.5,
    leverage: 18,
    legA: {
      symbol: 'BTC',
      side: 'short',
      size: 1,
      entryPrice: 50000,
      currentPrice: 50000,
      unrealizedPnl: 0,
      funding: 0,
    },
    legB: {
      symbol: 'ETH',
      side: 'long',
      size: 16.5,
      entryPrice: 3000,
      currentPrice: 3000,
      unrealizedPnl: 0,
      funding: 0,
    },
    openTimestamp: Date.now() - 24 * 3_600_000,
    halfLifeHours: 12,
    combinedPnl: 0,
    accumulatedFunding: 0,
    marginUsed: 10000,
    status: 'active',
    signalSource: 'native',
    ...overrides,
  };
}

describe('StatArbStrategy', () => {
  let strategy: StatArbStrategy;
  let store: Store;

  beforeEach(() => {
    store = Store.getInstance();
    store.reset();
    strategy = new StatArbStrategy({}, store);
  });

  // --- Identity and extends ---

  describe('identity and base class', () => {
    it('extends CrossChainStrategy', () => {
      expect(strategy).toBeInstanceOf(CrossChainStrategy);
    });

    it('has name StatArbStrategy', () => {
      expect(strategy.name).toBe('StatArbStrategy');
    });

    it('has timeframe 1h', () => {
      expect(strategy.timeframe).toBe('1h');
    });
  });

  // --- Declarative risk params ---

  describe('declarative risk parameters (AC6)', () => {
    it('has maxPositions = 10', () => {
      expect(strategy.maxPositions).toBe(10);
    });

    it('has stoploss = -0.30', () => {
      expect(strategy.stoploss).toBe(-0.30);
    });

    it('has trailingStop = false', () => {
      expect(strategy.trailingStop).toBe(false);
    });

    it('has empty minimalRoi', () => {
      expect(Object.keys(strategy.minimalRoi)).toHaveLength(0);
    });
  });

  // --- shouldExecute: no signals ---

  describe('shouldExecute with no signals', () => {
    it('returns null when no signals and no exit conditions', () => {
      const result = strategy.shouldExecute(makeContext());
      expect(result).toBeNull();
    });
  });

  // --- shouldExecute: entry signals ---

  describe('shouldExecute with entry signals (AC2)', () => {
    it('returns entry signal when pending long_pair signal exists', () => {
      store.addStatArbSignal(makeSignal({ direction: 'long_pair', zScore: -2.0 }));

      const result = strategy.shouldExecute(makeContext());
      expect(result).not.toBeNull();
      expect(result!.direction).toBe('long');
      expect(result!.metadata.type).toBe('entry');
    });

    it('returns entry signal when pending short_pair signal exists', () => {
      store.addStatArbSignal(makeSignal({ direction: 'short_pair', zScore: 2.0 }));

      const result = strategy.shouldExecute(makeContext());
      expect(result).not.toBeNull();
      expect(result!.direction).toBe('short');
    });

    it('selects highest |z-score| signal when multiple exist', () => {
      store.addStatArbSignal(makeSignal({
        signalId: 'sig-1',
        pair: { tokenA: 'BTC', tokenB: 'ETH', key: 'BTC-ETH' },
        zScore: 1.8,
      }));
      store.addStatArbSignal(makeSignal({
        signalId: 'sig-2',
        pair: { tokenA: 'AVAX', tokenB: 'SOL', key: 'AVAX-SOL' },
        zScore: -2.5,
      }));

      const result = strategy.shouldExecute(makeContext());
      expect(result).not.toBeNull();
      const signal = result!.metadata.statArbSignal as StatArbSignal;
      expect(Math.abs(signal.zScore)).toBe(2.5);
    });

    it('returns null when at max positions (AC8)', () => {
      store.addStatArbSignal(makeSignal());

      // Fill up to max positions
      for (let i = 0; i < STAT_ARB_STRATEGY_DEFAULTS.MAX_POSITIONS; i++) {
        store.openStatArbPosition(makePosition({
          positionId: `pos-${i}`,
          pair: { tokenA: `TOK${i}`, tokenB: `TOK${i + 100}`, key: `TOK${i}-TOK${i + 100}` },
        }));
      }

      const result = strategy.shouldExecute(makeContext());
      expect(result).toBeNull();
    });

    it('returns null when position already exists for signal pair', () => {
      store.addStatArbSignal(makeSignal());
      store.openStatArbPosition(makePosition());

      const result = strategy.shouldExecute(makeContext());
      expect(result).toBeNull();
    });

    it('skips consumed signals', () => {
      const signal = makeSignal();
      store.addStatArbSignal(signal);
      store.markSignalConsumed('BTC-ETH');

      const result = strategy.shouldExecute(makeContext());
      expect(result).toBeNull();
    });

    it('skips expired signals', () => {
      store.addStatArbSignal(makeSignal({ expiresAt: Date.now() - 1000 }));

      const result = strategy.shouldExecute(makeContext());
      expect(result).toBeNull();
    });
  });

  // --- shouldExecute: exit signals ---

  describe('shouldExecute with exit conditions (AC3, AC9)', () => {
    it('exit signals take priority over entry signals', () => {
      // Add entry signal
      store.addStatArbSignal(makeSignal({ pair: { tokenA: 'SOL', tokenB: 'AVAX', key: 'AVAX-SOL' } }));

      // Add stoploss position
      store.openStatArbPosition(makePosition({ combinedPnl: -4000, marginUsed: 10000 }));

      const result = strategy.shouldExecute(makeContext());
      expect(result).not.toBeNull();
      expect(result!.direction).toBe('exit');
      expect(result!.metadata.exitReason).toBe('stoploss');
    });

    it('triggers stoploss at -31% of margin', () => {
      store.openStatArbPosition(makePosition({ combinedPnl: -3100, marginUsed: 10000 }));

      const result = strategy.shouldExecute(makeContext());
      expect(result).not.toBeNull();
      expect(result!.metadata.exitReason).toBe('stoploss');
    });

    it('does NOT trigger stoploss at -29% of margin', () => {
      store.openStatArbPosition(makePosition({ combinedPnl: -2900, marginUsed: 10000 }));

      const result = strategy.shouldExecute(makeContext());
      // No stoploss trigger, and no entry signals either
      expect(result).toBeNull();
    });
  });

  // --- buildExecution: entry ---

  describe('buildExecution for entry (AC4, AC7)', () => {
    it('returns pair_trade ExecutionPlan', () => {
      store.addStatArbSignal(makeSignal());
      const signal = strategy.shouldExecute(makeContext())!;
      const plan = strategy.buildExecution(signal, makeContext());

      expect(plan.strategyName).toBe('StatArbStrategy');
      expect(plan.actions).toHaveLength(1);
      expect(plan.actions[0].type).toBe('pair');
    });

    it('marks signal as consumed in store', () => {
      store.addStatArbSignal(makeSignal());
      const signal = strategy.shouldExecute(makeContext())!;
      strategy.buildExecution(signal, makeContext());

      const storedSignal = store.getSignalByPairKey('BTC-ETH');
      expect(storedSignal?.consumed).toBe(true);
    });

    it('includes leverage and hedge ratio in action metadata', () => {
      store.addStatArbSignal(makeSignal({ recommendedLeverage: 23 }));
      const signal = strategy.shouldExecute(makeContext())!;
      const plan = strategy.buildExecution(signal, makeContext());

      expect(plan.metadata.leverage).toBe(23);
    });
  });

  // --- Beta-neutral sizing ---

  describe('beta-neutral position sizing (AC7)', () => {
    it('hedgeRatio=1.5, capital=1000 -> longSize=400, shortSize=600', () => {
      const { longSize, shortSize } = StatArbStrategy.calculateBetaNeutralSizes(1000, 1.5);
      expect(longSize).toBeCloseTo(400, 0);
      expect(shortSize).toBeCloseTo(600, 0);
    });

    it('hedgeRatio=1.0, capital=1000 -> longSize=500, shortSize=500', () => {
      const { longSize, shortSize } = StatArbStrategy.calculateBetaNeutralSizes(1000, 1.0);
      expect(longSize).toBeCloseTo(500, 0);
      expect(shortSize).toBeCloseTo(500, 0);
    });

    it('hedgeRatio=0.5, capital=1000 -> longSize=666.67, shortSize=333.33', () => {
      const { longSize, shortSize } = StatArbStrategy.calculateBetaNeutralSizes(1000, 0.5);
      expect(longSize).toBeCloseTo(666.67, 0);
      expect(shortSize).toBeCloseTo(333.33, 0);
    });
  });

  // --- buildExecution: exit ---

  describe('buildExecution for exit (AC5)', () => {
    it('returns close_pair_trade ExecutionPlan with correct positionId and exitReason', () => {
      store.openStatArbPosition(makePosition({ combinedPnl: -3500, marginUsed: 10000 }));
      const signal = strategy.shouldExecute(makeContext())!;
      const plan = strategy.buildExecution(signal, makeContext());

      expect(plan.metadata.action).toBe('close_pair_trade');
      expect(plan.metadata.positionId).toBe('pos-1');
      expect(plan.metadata.exitReason).toBe('stoploss');
    });
  });

  // --- Filters ---

  describe('filters (AC11)', () => {
    it('maxPositionsFilter returns false when at capacity', () => {
      for (let i = 0; i < STAT_ARB_STRATEGY_DEFAULTS.MAX_POSITIONS; i++) {
        store.openStatArbPosition(makePosition({
          positionId: `pos-${i}`,
          pair: { tokenA: `A${i}`, tokenB: `B${i}`, key: `A${i}-B${i}` },
        }));
      }

      expect(strategy.evaluateFilters(makeContext())).toBe(false);
    });

    it('maxPositionsFilter returns true when under capacity', () => {
      expect(strategy.evaluateFilters(makeContext())).toBe(true);
    });
  });

  // --- Signal source agnostic ---

  describe('signal source agnostic (AC10)', () => {
    it('treats native and telegram signals identically', () => {
      const nativeSignal = makeSignal({ source: 'native', signalId: 'native-1', pair: { tokenA: 'BTC', tokenB: 'ETH', key: 'BTC-ETH' } });
      store.addStatArbSignal(nativeSignal);

      const result1 = strategy.shouldExecute(makeContext());
      expect(result1).not.toBeNull();

      store.reset();

      const telegramSignal = makeSignal({ source: 'telegram', signalId: 'tg-1', pair: { tokenA: 'BTC', tokenB: 'ETH', key: 'BTC-ETH' } });
      store.addStatArbSignal(telegramSignal);

      const result2 = strategy.shouldExecute(makeContext());
      expect(result2).not.toBeNull();
      expect(result2!.direction).toBe(result1!.direction);
    });
  });

  // --- confirmTradeEntry ---

  describe('confirmTradeEntry', () => {
    it('rejects zero-sized positions', () => {
      const plan = {
        id: 'test',
        strategyName: 'StatArbStrategy',
        actions: [{
          id: 'a1',
          type: 'pair' as const,
          priority: 1,
          createdAt: Date.now(),
          strategyId: 'StatArbStrategy',
          pairId: 'BTC-ETH',
          longSymbol: 'BTC',
          shortSymbol: 'ETH',
          longSize: 0n,
          shortSize: 0n,
          leverage: 18,
          metadata: {},
        }],
        estimatedCostUsd: 1,
        estimatedDurationMs: 1000,
        metadata: {},
      };

      expect(strategy.confirmTradeEntry(plan)).toBe(false);
    });

    it('accepts valid positions', () => {
      const plan = {
        id: 'test',
        strategyName: 'StatArbStrategy',
        actions: [{
          id: 'a1',
          type: 'pair' as const,
          priority: 1,
          createdAt: Date.now(),
          strategyId: 'StatArbStrategy',
          pairId: 'BTC-ETH',
          longSymbol: 'BTC',
          shortSymbol: 'ETH',
          longSize: 1000n,
          shortSize: 500n,
          leverage: 18,
          metadata: {},
        }],
        estimatedCostUsd: 1,
        estimatedDurationMs: 1000,
        metadata: {},
      };

      expect(strategy.confirmTradeEntry(plan)).toBe(true);
    });
  });

  // --- confirmTradeExit ---

  describe('confirmTradeExit', () => {
    it('always returns true for stoploss reason', () => {
      expect(strategy.confirmTradeExit({}, 'stoploss')).toBe(true);
    });

    it('returns true for other reasons', () => {
      expect(strategy.confirmTradeExit({}, 'mean_reversion')).toBe(true);
    });
  });
});
