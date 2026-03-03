import { describe, it, expect, vi } from 'vitest';
import { CrossChainStrategy } from '../cross-chain-strategy.js';
import { StrategyConfigError } from '../../utils/errors.js';
import type {
  StrategySignal,
  ExecutionPlan,
  StrategyContext,
  StrategyFilter,
  Position,
  ChainId,
  TokenAddress,
} from '../../core/types.js';
import { chainId, tokenAddress } from '../../core/types.js';

// --- Test helper: concrete strategy implementation ---

class TestStrategy extends CrossChainStrategy {
  readonly name = 'test-strategy';
  readonly timeframe = '5m';

  shouldExecute(_context: StrategyContext): StrategySignal | null {
    return null;
  }

  buildExecution(signal: StrategySignal, _context: StrategyContext): ExecutionPlan {
    return {
      id: 'plan-1',
      strategyName: this.name,
      actions: [],
      estimatedCostUsd: 0,
      estimatedDurationMs: 0,
      metadata: { signal: signal.reason },
    };
  }
}

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

function makePosition(overrides: Partial<Position> = {}): Position {
  return {
    id: 'pos-1',
    strategyId: 'test-strategy',
    chainId: chainId(1),
    tokenAddress: tokenAddress('0x0000000000000000000000000000000000000001'),
    entryPrice: 100,
    currentPrice: 110,
    amount: 1000000000000000000n,
    enteredAt: Date.now(),
    pnlUsd: 10,
    pnlPercent: 0.1,
    ...overrides,
  };
}

function makeSignal(overrides: Partial<StrategySignal> = {}): StrategySignal {
  return {
    direction: 'long',
    tokenPair: {
      from: { address: tokenAddress('0x0000000000000000000000000000000000000001'), symbol: 'USDC', decimals: 6 },
      to: { address: tokenAddress('0x0000000000000000000000000000000000000002'), symbol: 'WETH', decimals: 18 },
    },
    sourceChain: chainId(1),
    destChain: chainId(42161),
    strength: 0.8,
    reason: 'test signal',
    metadata: {},
    ...overrides,
  };
}

// --- Tests ---

describe('CrossChainStrategy', () => {
  describe('default risk parameters', () => {
    it('has correct default stoploss', () => {
      const strategy = new TestStrategy();
      expect(strategy.stoploss).toBe(-0.10);
    });

    it('has correct default minimalRoi', () => {
      const strategy = new TestStrategy();
      expect(strategy.minimalRoi).toEqual({ 0: 0.05 });
    });

    it('has correct default trailingStop', () => {
      const strategy = new TestStrategy();
      expect(strategy.trailingStop).toBe(false);
    });

    it('has correct default maxPositions', () => {
      const strategy = new TestStrategy();
      expect(strategy.maxPositions).toBe(3);
    });

    it('has correct default trailingStopPositive', () => {
      const strategy = new TestStrategy();
      expect(strategy.trailingStopPositive).toBeUndefined();
    });
  });

  describe('lifecycle hooks', () => {
    it('onBotStart is callable and resolves', async () => {
      const strategy = new TestStrategy();
      await expect(strategy.onBotStart()).resolves.toBeUndefined();
    });

    it('onLoopStart is callable and resolves', async () => {
      const strategy = new TestStrategy();
      await expect(strategy.onLoopStart(Date.now())).resolves.toBeUndefined();
    });

    it('confirmTradeEntry returns true by default', () => {
      const strategy = new TestStrategy();
      const plan: ExecutionPlan = {
        id: 'plan-1',
        strategyName: 'test',
        actions: [],
        estimatedCostUsd: 0,
        estimatedDurationMs: 0,
        metadata: {},
      };
      expect(strategy.confirmTradeEntry(plan)).toBe(true);
    });

    it('confirmTradeExit returns true by default', () => {
      const strategy = new TestStrategy();
      const position = makePosition();
      expect(strategy.confirmTradeExit(position, 'stoploss')).toBe(true);
    });

    it('customStoploss returns this.stoploss by default', () => {
      const strategy = new TestStrategy();
      const position = makePosition();
      expect(strategy.customStoploss(position, 0.05)).toBe(-0.10);
    });
  });

  describe('filter chain', () => {
    it('returns true when no filters', () => {
      const strategy = new TestStrategy();
      const ctx = makeContext();
      expect(strategy.evaluateFilters(ctx)).toBe(true);
    });

    it('returns true when all filters pass', () => {
      class FilteredStrategy extends TestStrategy {
        filters(): StrategyFilter[] {
          return [
            () => true,
            () => true,
            () => true,
          ];
        }
      }
      const strategy = new FilteredStrategy();
      expect(strategy.evaluateFilters(makeContext())).toBe(true);
    });

    it('returns false and short-circuits when a filter fails', () => {
      const secondFilter = vi.fn(() => true);
      class FilteredStrategy extends TestStrategy {
        filters(): StrategyFilter[] {
          return [
            () => false,
            secondFilter,
          ];
        }
      }
      const strategy = new FilteredStrategy();
      expect(strategy.evaluateFilters(makeContext())).toBe(false);
      expect(secondFilter).not.toHaveBeenCalled();
    });
  });

  describe('StrategyContext shape', () => {
    it('contains all required fields', () => {
      const ctx = makeContext({
        timestamp: 1000,
        balances: new Map([['1-0x0000000000000000000000000000000000000001', 500000n]]),
        positions: [makePosition()],
        prices: new Map([['1-0x0000000000000000000000000000000000000001', 100.5]]),
        activeTransfers: [],
      });

      expect(ctx.timestamp).toBe(1000);
      expect(ctx.balances).toBeInstanceOf(Map);
      expect(ctx.balances.get('1-0x0000000000000000000000000000000000000001')).toBe(500000n);
      expect(ctx.positions).toHaveLength(1);
      expect(ctx.prices).toBeInstanceOf(Map);
      expect(ctx.activeTransfers).toHaveLength(0);
    });
  });

  describe('config validation', () => {
    it('throws StrategyConfigError for positive stoploss', () => {
      class BadStoploss extends TestStrategy {
        override readonly stoploss = 0.05;
      }
      const s = new BadStoploss();
      expect(() => s.validateConfig()).toThrow(StrategyConfigError);
    });

    it('throws StrategyConfigError for stoploss of 0', () => {
      class ZeroStoploss extends TestStrategy {
        override readonly stoploss = 0;
      }
      const s = new ZeroStoploss();
      expect(() => s.validateConfig()).toThrow(StrategyConfigError);
    });

    it('throws StrategyConfigError for stoploss <= -1.0', () => {
      class TooLowStoploss extends TestStrategy {
        override readonly stoploss = -1.0;
      }
      const s = new TooLowStoploss();
      expect(() => s.validateConfig()).toThrow(StrategyConfigError);
    });

    it('includes field and value in StrategyConfigError', () => {
      class BadStoploss extends TestStrategy {
        override readonly stoploss = 0.5;
      }
      const s = new BadStoploss();
      try {
        s.validateConfig();
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(StrategyConfigError);
        const configErr = err as StrategyConfigError;
        expect(configErr.field).toBe('stoploss');
        expect(configErr.value).toBe(0.5);
      }
    });

    it('throws for non-integer maxPositions', () => {
      class BadMaxPositions extends TestStrategy {
        override readonly maxPositions = 2.5;
      }
      const s = new BadMaxPositions();
      expect(() => s.validateConfig()).toThrow(StrategyConfigError);
    });

    it('throws for zero maxPositions', () => {
      class ZeroMaxPositions extends TestStrategy {
        override readonly maxPositions = 0;
      }
      const s = new ZeroMaxPositions();
      expect(() => s.validateConfig()).toThrow(StrategyConfigError);
    });

    it('allows valid custom risk params', () => {
      class CustomRisk extends TestStrategy {
        override readonly stoploss = -0.05;
        override readonly maxPositions = 10;
        override readonly minimalRoi = { 0: 0.03, 60: 0.01 };
        override readonly trailingStop = true;
        override readonly trailingStopPositive = 0.02;
      }
      const strategy = new CustomRisk();
      expect(() => strategy.validateConfig()).not.toThrow();
      expect(strategy.stoploss).toBe(-0.05);
      expect(strategy.maxPositions).toBe(10);
      expect(strategy.trailingStop).toBe(true);
      expect(strategy.trailingStopPositive).toBe(0.02);
    });
  });

  describe('abstract methods', () => {
    it('shouldExecute returns null for base test strategy', () => {
      const strategy = new TestStrategy();
      expect(strategy.shouldExecute(makeContext())).toBeNull();
    });

    it('buildExecution returns a valid plan', () => {
      const strategy = new TestStrategy();
      const signal = makeSignal();
      const plan = strategy.buildExecution(signal, makeContext());
      expect(plan.id).toBe('plan-1');
      expect(plan.strategyName).toBe('test-strategy');
      expect(plan.actions).toEqual([]);
    });
  });
});
