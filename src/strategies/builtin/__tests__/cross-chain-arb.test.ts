import { describe, it, expect, beforeEach } from 'vitest';
import { CrossChainArbStrategy } from '../cross-chain-arb.js';
import type {
  StrategyContext,
  StrategySignal,
  ExecutionPlan,
} from '../../../core/types.js';
import { chainId, tokenAddress } from '../../../core/types.js';

// --- Helpers ---

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

function makePosition(id: string = 'pos-1') {
  return {
    id,
    strategyId: 'CrossChainArb',
    chainId: chainId(1),
    tokenAddress: tokenAddress('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'),
    entryPrice: 1.0,
    currentPrice: 1.0,
    amount: 1000000n,
    enteredAt: Date.now(),
    pnlUsd: 0,
    pnlPercent: 0,
  };
}

// --- Tests ---

describe('CrossChainArbStrategy', () => {
  let strategy: CrossChainArbStrategy;

  beforeEach(() => {
    strategy = new CrossChainArbStrategy();
  });

  describe('identity and Growth-tier defaults', () => {
    it('has correct name', () => {
      expect(strategy.name).toBe('CrossChainArb');
    });

    it('has correct timeframe', () => {
      expect(strategy.timeframe).toBe('30s');
    });

    it('has Growth-tier stoploss', () => {
      expect(strategy.stoploss).toBe(-0.03);
    });

    it('has Growth-tier minimalRoi', () => {
      expect(strategy.minimalRoi).toEqual({ 0: 0.003 });
    });

    it('has trailing stop enabled', () => {
      expect(strategy.trailingStop).toBe(true);
    });

    it('has maxPositions of 5', () => {
      expect(strategy.maxPositions).toBe(5);
    });

    it('has correct default minProfitUsd', () => {
      expect(strategy.minProfitUsd).toBe(5);
    });

    it('has correct default minProfitPercent', () => {
      expect(strategy.minProfitPercent).toBe(0.003);
    });

    it('has correct default stablecoinDepegThreshold', () => {
      expect(strategy.stablecoinDepegThreshold).toBe(0.005);
    });

    it('accepts custom config values', () => {
      const custom = new CrossChainArbStrategy({
        minProfitUsd: 10,
        minProfitPercent: 0.01,
        stablecoinDepegThreshold: 0.01,
      });
      expect(custom.minProfitUsd).toBe(10);
      expect(custom.minProfitPercent).toBe(0.01);
      expect(custom.stablecoinDepegThreshold).toBe(0.01);
    });
  });

  describe('price arb detection', () => {
    it('detects same token at different prices on two chains', () => {
      const token = '0x0000000000000000000000000000000000000abc';
      const prices = new Map<string, number>();
      // Token on chain 1 at $100, on chain 42161 at $102 (2% spread)
      prices.set(`1-${token}`, 100);
      prices.set(`42161-${token}`, 102);

      const ctx = makeContext({ prices });
      const signal = strategy.shouldExecute(ctx);

      expect(signal).not.toBeNull();
      expect(signal!.metadata.arbType).toBe('price');
      expect(signal!.sourceChain).toBe(chainId(1)); // buy cheap
      expect(signal!.destChain).toBe(chainId(42161)); // sell expensive
    });

    it('rejects when costs exceed profit', () => {
      const token = '0x0000000000000000000000000000000000000abc';
      const prices = new Map<string, number>();
      // Token on chain 1 at $100, on chain 42161 at $100.10 (0.1% spread — below 0.5% cost)
      prices.set(`1-${token}`, 100);
      prices.set(`42161-${token}`, 100.10);

      const ctx = makeContext({ prices });
      const signal = strategy.shouldExecute(ctx);

      expect(signal).toBeNull();
    });
  });

  describe('stablecoin depeg detection', () => {
    it('detects when USDC at 0.99 on Ethereum', () => {
      const prices = new Map<string, number>();
      // USDC on Ethereum (depegged at 0.99)
      prices.set(
        `1-${tokenAddress('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48') as string}`,
        0.99,
      );
      // USDC on Arbitrum (at peg)
      prices.set(
        `42161-${tokenAddress('0xaf88d065e77c8cc2239327c5edb3a432268e5831') as string}`,
        1.0,
      );

      const ctx = makeContext({ prices });
      const signal = strategy.shouldExecute(ctx);

      expect(signal).not.toBeNull();
      expect(signal!.metadata.arbType).toBe('stablecoin_depeg');
      expect(signal!.sourceChain).toBe(chainId(1)); // buy depegged
    });

    it('ignores stablecoin within depeg threshold', () => {
      const prices = new Map<string, number>();
      // USDC at 0.998 — within 0.005 threshold
      prices.set(
        `1-${tokenAddress('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48') as string}`,
        0.998,
      );

      const ctx = makeContext({ prices });
      const signal = strategy.shouldExecute(ctx);

      expect(signal).toBeNull();
    });
  });

  describe('shouldExecute', () => {
    it('returns the most profitable opportunity when multiple exist', () => {
      const tokenA = '0x0000000000000000000000000000000000000aaa';
      const tokenB = '0x0000000000000000000000000000000000000bbb';
      const prices = new Map<string, number>();

      // Token A: 3% spread (more profitable)
      prices.set(`1-${tokenA}`, 100);
      prices.set(`42161-${tokenA}`, 103);

      // Token B: 2% spread (less profitable)
      prices.set(`1-${tokenB}`, 100);
      prices.set(`42161-${tokenB}`, 102);

      const ctx = makeContext({ prices });
      const signal = strategy.shouldExecute(ctx);

      expect(signal).not.toBeNull();
      // Should pick the 3% spread (token A) — higher net profit
      expect(signal!.metadata.netProfit).toBeGreaterThan(0.01);
    });

    it('returns null when no profitable opportunity exists', () => {
      const prices = new Map<string, number>();
      // Same price on both chains — no arb
      prices.set('1-0x0000000000000000000000000000000000000abc', 100);
      prices.set('42161-0x0000000000000000000000000000000000000abc', 100);

      const ctx = makeContext({ prices });
      const signal = strategy.shouldExecute(ctx);

      expect(signal).toBeNull();
    });

    it('returns null when max positions reached', () => {
      const token = '0x0000000000000000000000000000000000000abc';
      const prices = new Map<string, number>();
      prices.set(`1-${token}`, 100);
      prices.set(`42161-${token}`, 105); // 5% spread — very profitable

      // Fill up to maxPositions (5)
      const positions = Array.from({ length: 5 }, (_, i) =>
        makePosition(`pos-${i}`),
      );

      const ctx = makeContext({ prices, positions });
      const signal = strategy.shouldExecute(ctx);

      expect(signal).toBeNull();
    });

    it('returns null when prices map is empty', () => {
      const ctx = makeContext({ prices: new Map() });
      const signal = strategy.shouldExecute(ctx);

      expect(signal).toBeNull();
    });
  });

  describe('buildExecution', () => {
    it('creates buy -> bridge -> sell sequence for price arb', () => {
      const signal: StrategySignal = {
        direction: 'long',
        tokenPair: {
          from: { address: tokenAddress('0x0000000000000000000000000000000000000abc'), symbol: 'TOKEN', decimals: 18 },
          to: { address: tokenAddress('0x0000000000000000000000000000000000000abc'), symbol: 'TOKEN', decimals: 18 },
        },
        sourceChain: chainId(1),
        destChain: chainId(42161),
        strength: 0.8,
        reason: 'price arb',
        metadata: {
          arbType: 'price',
          buyPrice: 100,
          sellPrice: 103,
          grossProfit: 0.03,
          estimatedCosts: 0.005,
          netProfit: 0.025,
        },
      };

      const plan = strategy.buildExecution(signal, makeContext());

      expect(plan.strategyName).toBe('CrossChainArb');
      expect(plan.actions).toHaveLength(3);
      expect(plan.actions[0].type).toBe('swap'); // buy
      expect(plan.actions[1].type).toBe('bridge');
      expect(plan.actions[2].type).toBe('swap'); // sell

      // Verify chain routing
      expect(plan.actions[0].fromChain).toBe(chainId(1));
      expect((plan.actions[0] as { toChain: unknown }).toChain).toBe(chainId(1));
      expect(plan.actions[1].fromChain).toBe(chainId(1));
      expect((plan.actions[1] as { toChain: unknown }).toChain).toBe(chainId(42161));
      expect(plan.actions[2].fromChain).toBe(chainId(42161));
      expect((plan.actions[2] as { toChain: unknown }).toChain).toBe(chainId(42161));
    });

    it('creates correct sequence for stablecoin depeg', () => {
      const signal: StrategySignal = {
        direction: 'long',
        tokenPair: {
          from: { address: tokenAddress('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'), symbol: 'USDC', decimals: 6 },
          to: { address: tokenAddress('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'), symbol: 'USDC', decimals: 6 },
        },
        sourceChain: chainId(1),
        destChain: chainId(42161),
        strength: 0.5,
        reason: 'stablecoin depeg',
        metadata: {
          arbType: 'stablecoin_depeg',
          buyPrice: 0.99,
          sellPrice: 1.0,
          grossProfit: 0.0101,
          estimatedCosts: 0.005,
          netProfit: 0.0051,
        },
      };

      const plan = strategy.buildExecution(signal, makeContext());

      expect(plan.actions).toHaveLength(3);
      expect(plan.actions[0].type).toBe('swap'); // buy discounted
      expect(plan.actions[1].type).toBe('bridge');
      expect(plan.actions[2].type).toBe('swap'); // sell at peg

      // Verify metadata
      expect(plan.metadata.arbType).toBe('stablecoin_depeg');
    });

    it('creates composer actions for yield arb', () => {
      const signal: StrategySignal = {
        direction: 'long',
        tokenPair: {
          from: { address: tokenAddress('0x0000000000000000000000000000000000000abc'), symbol: 'TOKEN', decimals: 18 },
          to: { address: tokenAddress('0x0000000000000000000000000000000000000abc'), symbol: 'TOKEN', decimals: 18 },
        },
        sourceChain: chainId(1),
        destChain: chainId(42161),
        strength: 0.6,
        reason: 'yield arb',
        metadata: {
          arbType: 'yield',
          buyPrice: 0,
          sellPrice: 0,
          grossProfit: 0.05,
          estimatedCosts: 0.005,
          netProfit: 0.045,
          sourceProtocol: 'aave',
          destProtocol: 'compound',
        },
      };

      const plan = strategy.buildExecution(signal, makeContext());

      expect(plan.actions).toHaveLength(3);
      expect(plan.actions[0].type).toBe('composer'); // withdraw
      expect(plan.actions[1].type).toBe('bridge');
      expect(plan.actions[2].type).toBe('composer'); // deposit
    });
  });

  describe('confirmTradeEntry', () => {
    it('returns true for profitable plan', () => {
      const plan: ExecutionPlan = {
        id: 'plan-1',
        strategyName: 'CrossChainArb',
        actions: [],
        estimatedCostUsd: 1,
        estimatedDurationMs: 120000,
        metadata: { netProfit: 0.025 },
      };

      expect(strategy.confirmTradeEntry(plan)).toBe(true);
    });

    it('returns false when net profit is negative', () => {
      const plan: ExecutionPlan = {
        id: 'plan-1',
        strategyName: 'CrossChainArb',
        actions: [],
        estimatedCostUsd: 1,
        estimatedDurationMs: 120000,
        metadata: { netProfit: -0.005 },
      };

      expect(strategy.confirmTradeEntry(plan)).toBe(false);
    });

    it('returns false when net profit is zero', () => {
      const plan: ExecutionPlan = {
        id: 'plan-1',
        strategyName: 'CrossChainArb',
        actions: [],
        estimatedCostUsd: 1,
        estimatedDurationMs: 120000,
        metadata: { netProfit: 0 },
      };

      expect(strategy.confirmTradeEntry(plan)).toBe(false);
    });

    it('returns true when netProfit metadata is absent', () => {
      const plan: ExecutionPlan = {
        id: 'plan-1',
        strategyName: 'CrossChainArb',
        actions: [],
        estimatedCostUsd: 1,
        estimatedDurationMs: 120000,
        metadata: {},
      };

      expect(strategy.confirmTradeEntry(plan)).toBe(true);
    });
  });

  describe('adaptive thresholds', () => {
    it('increases after high missed rate (>30%)', () => {
      const initial = strategy.adaptiveMinProfitPercent;

      // Record 10 executions: 4 unprofitable (40% missed rate)
      for (let i = 0; i < 6; i++) {
        strategy.recordExecution(true, 100);
      }
      for (let i = 0; i < 4; i++) {
        strategy.recordExecution(false, 100);
      }

      expect(strategy.adaptiveMinProfitPercent).toBeGreaterThan(initial);
      expect(strategy.adaptiveMinProfitPercent).toBeCloseTo(initial * 1.5, 10);
    });

    it('decreases after low missed rate (<10%)', () => {
      const initial = strategy.adaptiveMinProfitPercent;
      // First raise the threshold so we can decrease it
      strategy.adaptiveMinProfitPercent = initial * 2;
      const raised = strategy.adaptiveMinProfitPercent;

      // Record 10 successful executions (0% missed rate)
      for (let i = 0; i < 10; i++) {
        strategy.recordExecution(true, 100);
      }

      expect(strategy.adaptiveMinProfitPercent).toBeLessThan(raised);
      expect(strategy.adaptiveMinProfitPercent).toBeCloseTo(raised * 0.75, 10);
    });

    it('never drops below initial default', () => {
      const initial = strategy.minProfitPercent;

      // Record many successful executions to drive threshold down
      for (let i = 0; i < 30; i++) {
        strategy.recordExecution(true, 100);
      }

      expect(strategy.adaptiveMinProfitPercent).toBeGreaterThanOrEqual(initial);
    });

    it('does not adjust with fewer than 10 data points', () => {
      const initial = strategy.adaptiveMinProfitPercent;

      // Record only 5 unprofitable executions
      for (let i = 0; i < 5; i++) {
        strategy.recordExecution(false, 100);
      }

      expect(strategy.adaptiveMinProfitPercent).toBe(initial);
    });
  });

  describe('filters', () => {
    it('rejects when prices map is empty (min profit filter)', () => {
      const ctx = makeContext({ prices: new Map() });
      expect(strategy.evaluateFilters(ctx)).toBe(false);
    });

    it('rejects when max positions reached', () => {
      const positions = Array.from({ length: 5 }, (_, i) =>
        makePosition(`pos-${i}`),
      );
      const prices = new Map<string, number>();
      prices.set('1-0x0000000000000000000000000000000000000abc', 100);

      const ctx = makeContext({ positions, prices });
      expect(strategy.evaluateFilters(ctx)).toBe(false);
    });

    it('passes when prices exist and positions below limit', () => {
      const prices = new Map<string, number>();
      prices.set('1-0x0000000000000000000000000000000000000abc', 100);
      const ctx = makeContext({ prices, positions: [makePosition()] });
      expect(strategy.evaluateFilters(ctx)).toBe(true);
    });
  });
});
