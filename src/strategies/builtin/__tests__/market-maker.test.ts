import { describe, it, expect, beforeEach } from 'vitest';
import {
  MarketMaker,
  resetActionCounter,
} from '../market-maker.js';
import type {
  MarketMakerConfig,
  MarketMakerMarketData,
  OrderLevel,
} from '../market-maker.js';
import type {
  StrategyContext,
  StrategySignal,
  Position,
  TokenInfo,
} from '../../../core/types.js';
import { chainId, tokenAddress } from '../../../core/types.js';
import { Store } from '../../../core/store.js';
import { CHAINS, USDC_ADDRESSES } from '../../../core/constants.js';

// ---------------------------------------------------------------------------
// Test helpers
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

function makePosition(overrides: Partial<Position> = {}): Position {
  return {
    id: 'pos-1',
    strategyId: 'MarketMaker',
    chainId: CHAINS.ARBITRUM,
    tokenAddress: USDC_ADDRESSES[CHAINS.ARBITRUM as number]!,
    entryPrice: 2000,
    currentPrice: 2050,
    amount: 50_000_000n,
    enteredAt: Date.now(),
    pnlUsd: 0,
    pnlPercent: 0,
    ...overrides,
  };
}

function makeMarketData(overrides: Partial<MarketMakerMarketData> = {}): MarketMakerMarketData {
  return {
    midPrice: 2000,
    bestBid: 1999,
    bestAsk: 2001,
    baseBalance: 1_000_000_000_000_000_000n, // 1 WETH
    quoteBalance: 2000_000_000n, // 2000 USDC
    basePrice: 2000,
    fills: [],
    ...overrides,
  };
}

const baseToken: TokenInfo = {
  address: tokenAddress('0x82af49447d8a07e3bd95bd0d56f35241523fbab1'),
  symbol: 'WETH',
  decimals: 18,
};

const quoteToken: TokenInfo = {
  address: USDC_ADDRESSES[CHAINS.ARBITRUM as number]!,
  symbol: 'USDC',
  decimals: 6,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MarketMaker', () => {
  beforeEach(() => {
    Store.getInstance().reset();
    resetActionCounter();
  });

  // --- Initialization ---

  describe('initialization', () => {
    it('has correct name and timeframe', () => {
      const strategy = new MarketMaker();
      expect(strategy.name).toBe('MarketMaker');
      expect(strategy.timeframe).toBe('5s');
    });

    it('has growth tier risk defaults', () => {
      const strategy = new MarketMaker();
      expect(strategy.stoploss).toBe(-0.05);
      expect(strategy.maxPositions).toBe(1);
      expect(strategy.trailingStop).toBe(false);
    });

    it('uses default config values when no options provided', () => {
      const strategy = new MarketMaker();
      expect(strategy.config.spread).toBe(0.001);
      expect(strategy.config.levels).toBe(3);
      expect(strategy.config.inventoryTarget).toBe(0.5);
      expect(strategy.config.rebalanceThreshold).toBe(0.85);
      expect(strategy.config.skewAdjustThreshold).toBe(0.70);
      expect(strategy.config.staleOrderThreshold).toBe(0.005);
    });

    it('accepts custom config values', () => {
      const strategy = new MarketMaker({
        spread: 0.002,
        orderSize: 100_000_000n,
        levels: 5,
        inventoryTarget: 0.4,
        rebalanceThreshold: 0.90,
        skewAdjustThreshold: 0.75,
        staleOrderThreshold: 0.01,
        symbol: 'ETH/USDT',
        baseToken,
        quoteToken,
        chainId: CHAINS.ARBITRUM,
      });

      expect(strategy.config.spread).toBe(0.002);
      expect(strategy.config.orderSize).toBe(100_000_000n);
      expect(strategy.config.levels).toBe(5);
      expect(strategy.config.inventoryTarget).toBe(0.4);
      expect(strategy.config.rebalanceThreshold).toBe(0.90);
      expect(strategy.config.symbol).toBe('ETH/USDT');
    });

    it('passes validateConfig with growth tier defaults', () => {
      const strategy = new MarketMaker();
      expect(() => strategy.validateConfig()).not.toThrow();
    });
  });

  // --- Order level calculation ---

  describe('calculateOrderLevels', () => {
    it('generates correct number of levels', () => {
      const strategy = new MarketMaker({ levels: 3, spread: 0.001 });
      strategy.setMarketData(makeMarketData());
      const levels = strategy.calculateOrderLevels(2000);
      expect(levels).toHaveLength(3);
    });

    it('level 1 at 0.5x spread, level 2 at 1.0x, level 3 at 1.5x', () => {
      const strategy = new MarketMaker({
        spread: 0.01, // 1% for easy math
        levels: 3,
        baseToken,
        quoteToken,
      });

      // Set balanced inventory to avoid skew adjustment
      strategy.setMarketData(makeMarketData({
        baseBalance: 1_000_000_000_000_000_000n, // 1 WETH
        quoteBalance: 2000_000_000n, // 2000 USDC
        basePrice: 2000,
      }));

      const levels = strategy.calculateOrderLevels(2000);

      // Level 1: 0.5x spread = 0.5%
      expect(levels[0]!.level).toBe(1);
      expect(levels[0]!.bidPrice).toBeCloseTo(2000 * (1 - 0.01 * 0.5), 2);
      expect(levels[0]!.askPrice).toBeCloseTo(2000 * (1 + 0.01 * 0.5), 2);

      // Level 2: 1.0x spread = 1.0%
      expect(levels[1]!.level).toBe(2);
      expect(levels[1]!.bidPrice).toBeCloseTo(2000 * (1 - 0.01 * 1.0), 2);
      expect(levels[1]!.askPrice).toBeCloseTo(2000 * (1 + 0.01 * 1.0), 2);

      // Level 3: 1.5x spread = 1.5%
      expect(levels[2]!.level).toBe(3);
      expect(levels[2]!.bidPrice).toBeCloseTo(2000 * (1 - 0.01 * 1.5), 2);
      expect(levels[2]!.askPrice).toBeCloseTo(2000 * (1 + 0.01 * 1.5), 2);
    });

    it('each level has the configured order size', () => {
      const strategy = new MarketMaker({
        levels: 3,
        orderSize: 75_000_000n,
      });
      strategy.setMarketData(makeMarketData());
      const levels = strategy.calculateOrderLevels(2000);

      for (const level of levels) {
        expect(level.size).toBe(75_000_000n);
      }
    });

    it('bid prices are below ask prices at each level', () => {
      const strategy = new MarketMaker({ levels: 5, spread: 0.002 });
      strategy.setMarketData(makeMarketData());
      const levels = strategy.calculateOrderLevels(2000);

      for (const level of levels) {
        expect(level.bidPrice).toBeLessThan(level.askPrice);
      }
    });
  });

  // --- Inventory skew ---

  describe('inventory skew', () => {
    it('returns 0.5 for balanced inventory', () => {
      const strategy = new MarketMaker({ baseToken, quoteToken });
      strategy.setMarketData(makeMarketData({
        baseBalance: 1_000_000_000_000_000_000n, // 1 WETH = $2000
        quoteBalance: 2000_000_000n, // 2000 USDC
        basePrice: 2000,
      }));

      const skew = strategy.calculateInventorySkew();
      expect(skew).toBeCloseTo(0.5, 2);
    });

    it('returns > 0.5 when heavy on base', () => {
      const strategy = new MarketMaker({ baseToken, quoteToken });
      strategy.setMarketData(makeMarketData({
        baseBalance: 5_000_000_000_000_000_000n, // 5 WETH = $10000
        quoteBalance: 1000_000_000n, // 1000 USDC
        basePrice: 2000,
      }));

      const skew = strategy.calculateInventorySkew();
      expect(skew).toBeGreaterThan(0.5);
    });

    it('returns < 0.5 when heavy on quote', () => {
      const strategy = new MarketMaker({ baseToken, quoteToken });
      strategy.setMarketData(makeMarketData({
        baseBalance: 100_000_000_000_000_000n, // 0.1 WETH = $200
        quoteBalance: 5000_000_000n, // 5000 USDC
        basePrice: 2000,
      }));

      const skew = strategy.calculateInventorySkew();
      expect(skew).toBeLessThan(0.5);
    });

    it('returns 0.5 when both balances are zero', () => {
      const strategy = new MarketMaker({ baseToken, quoteToken });
      strategy.setMarketData(makeMarketData({
        baseBalance: 0n,
        quoteBalance: 0n,
        basePrice: 2000,
      }));

      const skew = strategy.calculateInventorySkew();
      expect(skew).toBe(0.5);
    });

    it('adjusts order levels when skew exceeds skewAdjustThreshold', () => {
      const strategy = new MarketMaker({
        spread: 0.01,
        levels: 3,
        skewAdjustThreshold: 0.70,
        baseToken,
        quoteToken,
      });

      // Heavy on base: skew > 0.70
      strategy.setMarketData(makeMarketData({
        baseBalance: 10_000_000_000_000_000_000n, // 10 WETH = $20000
        quoteBalance: 1000_000_000n, // 1000 USDC
        basePrice: 2000,
      }));

      const skewedLevels = strategy.calculateOrderLevels(2000);

      // Reset to balanced
      strategy.setMarketData(makeMarketData({
        baseBalance: 1_000_000_000_000_000_000n,
        quoteBalance: 2000_000_000n,
        basePrice: 2000,
      }));

      const balancedLevels = strategy.calculateOrderLevels(2000);

      // When heavy on base, bids should be wider and asks tighter vs balanced
      expect(skewedLevels[0]!.bidPrice).not.toBe(balancedLevels[0]!.bidPrice);
      expect(skewedLevels[0]!.askPrice).not.toBe(balancedLevels[0]!.askPrice);
    });
  });

  // --- shouldExecute ---

  describe('shouldExecute', () => {
    it('returns signal with order levels when market data is available', () => {
      const strategy = new MarketMaker({
        levels: 3,
        spread: 0.001,
        baseToken,
        quoteToken,
      });

      strategy.setMarketData(makeMarketData());

      const signal = strategy.shouldExecute(makeContext());

      expect(signal).not.toBeNull();
      expect(signal!.metadata['orderLevels']).toBeDefined();
      expect(signal!.metadata['midPrice']).toBe(2000);
      expect(signal!.metadata['symbol']).toBe('WETH/USDC');
      expect(signal!.reason).toContain('market_make');
    });

    it('returns null when no market data is set', () => {
      const strategy = new MarketMaker();
      const signal = strategy.shouldExecute(makeContext());
      expect(signal).toBeNull();
    });

    it('returns null when max positions reached', () => {
      const strategy = new MarketMaker();
      strategy.setMarketData(makeMarketData());

      const positions = [makePosition()];
      const signal = strategy.shouldExecute(makeContext({ positions }));
      expect(signal).toBeNull();
    });

    it('returns null when midPrice is zero', () => {
      const strategy = new MarketMaker();
      strategy.setMarketData(makeMarketData({ midPrice: 0 }));

      const signal = strategy.shouldExecute(makeContext());
      expect(signal).toBeNull();
    });

    it('includes needsRebalance flag when skew > 85%', () => {
      const strategy = new MarketMaker({
        rebalanceThreshold: 0.85,
        baseToken,
        quoteToken,
      });

      // Very heavy on base: 20 WETH = $40000 vs 1000 USDC
      strategy.setMarketData(makeMarketData({
        baseBalance: 20_000_000_000_000_000_000n,
        quoteBalance: 1000_000_000n,
        basePrice: 2000,
      }));

      const signal = strategy.shouldExecute(makeContext());

      expect(signal).not.toBeNull();
      expect(signal!.metadata['needsRebalance']).toBe(true);
      expect(signal!.reason).toContain('[REBALANCE]');
    });

    it('does not flag rebalance with balanced inventory', () => {
      const strategy = new MarketMaker({
        rebalanceThreshold: 0.85,
        baseToken,
        quoteToken,
      });

      strategy.setMarketData(makeMarketData({
        baseBalance: 1_000_000_000_000_000_000n,
        quoteBalance: 2000_000_000n,
        basePrice: 2000,
      }));

      const signal = strategy.shouldExecute(makeContext());

      expect(signal).not.toBeNull();
      expect(signal!.metadata['needsRebalance']).toBe(false);
    });
  });

  // --- buildExecution ---

  describe('buildExecution', () => {
    it('creates market_make action without rebalance', () => {
      const strategy = new MarketMaker({
        levels: 3,
        spread: 0.001,
        baseToken,
        quoteToken,
      });

      strategy.setMarketData(makeMarketData());

      const signal = strategy.shouldExecute(makeContext())!;
      const plan = strategy.buildExecution(signal, makeContext());

      expect(plan.strategyName).toBe('MarketMaker');
      expect(plan.actions).toHaveLength(1);
      expect(plan.actions[0]!.type).toBe('market_make');

      const mmAction = plan.actions[0]! as { spread: number; levels: number; orderSize: bigint };
      expect(mmAction.spread).toBe(0.001);
      expect(mmAction.levels).toBe(3);
    });

    it('prepends bridge action when skew > rebalanceThreshold (heavy base)', () => {
      const strategy = new MarketMaker({
        rebalanceThreshold: 0.85,
        baseToken,
        quoteToken,
      });

      // Heavy on base
      strategy.setMarketData(makeMarketData({
        baseBalance: 20_000_000_000_000_000_000n,
        quoteBalance: 1000_000_000n,
        basePrice: 2000,
      }));

      const signal = strategy.shouldExecute(makeContext())!;
      const plan = strategy.buildExecution(signal, makeContext());

      expect(plan.actions.length).toBeGreaterThanOrEqual(2);
      expect(plan.actions[0]!.type).toBe('bridge');
      expect(plan.actions[plan.actions.length - 1]!.type).toBe('market_make');
      expect(plan.metadata['needsRebalance']).toBe(true);
    });

    it('prepends swap action when skew < (1 - rebalanceThreshold) (heavy quote)', () => {
      const strategy = new MarketMaker({
        rebalanceThreshold: 0.85,
        baseToken,
        quoteToken,
      });

      // Heavy on quote: very little base
      strategy.setMarketData(makeMarketData({
        baseBalance: 10_000_000_000_000_000n, // 0.01 WETH = $20
        quoteBalance: 5000_000_000n, // 5000 USDC
        basePrice: 2000,
      }));

      const signal = strategy.shouldExecute(makeContext())!;
      const plan = strategy.buildExecution(signal, makeContext());

      expect(plan.actions.length).toBeGreaterThanOrEqual(2);
      expect(plan.actions[0]!.type).toBe('swap');
      expect(plan.actions[plan.actions.length - 1]!.type).toBe('market_make');
    });

    it('includes correct metadata in the plan', () => {
      const strategy = new MarketMaker({
        levels: 3,
        spread: 0.002,
        symbol: 'ETH/USDC',
        baseToken,
        quoteToken,
      });

      strategy.setMarketData(makeMarketData({ midPrice: 3000 }));

      const signal = strategy.shouldExecute(makeContext())!;
      const plan = strategy.buildExecution(signal, makeContext());

      expect(plan.metadata['symbol']).toBe('ETH/USDC');
      expect(plan.metadata['midPrice']).toBe(3000);
      expect(plan.metadata['levels']).toBe(3);
      expect(plan.metadata['spread']).toBe(0.002);
    });
  });

  // --- Filters ---

  describe('filters', () => {
    it('rejects when no market data', () => {
      const strategy = new MarketMaker();
      const result = strategy.evaluateFilters(makeContext());
      expect(result).toBe(false);
    });

    it('passes when market data is set and positions below limit', () => {
      const strategy = new MarketMaker();
      strategy.setMarketData(makeMarketData());
      const result = strategy.evaluateFilters(makeContext());
      expect(result).toBe(true);
    });

    it('rejects when max positions reached in filter', () => {
      const strategy = new MarketMaker();
      strategy.setMarketData(makeMarketData());

      const positions = [makePosition()];
      const result = strategy.evaluateFilters(makeContext({ positions }));
      expect(result).toBe(false);
    });
  });

  // --- confirmTradeEntry ---

  describe('confirmTradeEntry', () => {
    it('returns true when midPrice is valid', () => {
      const strategy = new MarketMaker();
      const plan = {
        id: 'plan-1',
        strategyName: 'MarketMaker',
        actions: [],
        estimatedCostUsd: 1,
        estimatedDurationMs: 5000,
        metadata: { midPrice: 2000 },
      };
      expect(strategy.confirmTradeEntry(plan)).toBe(true);
    });

    it('returns false when midPrice is zero', () => {
      const strategy = new MarketMaker();
      const plan = {
        id: 'plan-1',
        strategyName: 'MarketMaker',
        actions: [],
        estimatedCostUsd: 1,
        estimatedDurationMs: 5000,
        metadata: { midPrice: 0 },
      };
      expect(strategy.confirmTradeEntry(plan)).toBe(false);
    });

    it('returns false when midPrice is absent', () => {
      const strategy = new MarketMaker();
      const plan = {
        id: 'plan-1',
        strategyName: 'MarketMaker',
        actions: [],
        estimatedCostUsd: 1,
        estimatedDurationMs: 5000,
        metadata: {},
      };
      expect(strategy.confirmTradeEntry(plan)).toBe(false);
    });
  });

  // --- setMarketData ---

  describe('setMarketData', () => {
    it('makes data available for shouldExecute', () => {
      const strategy = new MarketMaker({ baseToken, quoteToken });
      strategy.setMarketData(makeMarketData());

      const signal = strategy.shouldExecute(makeContext());
      expect(signal).not.toBeNull();
    });

    it('updates inventory tracker', () => {
      const strategy = new MarketMaker({ baseToken, quoteToken });

      strategy.setMarketData(makeMarketData({
        baseBalance: 2_000_000_000_000_000_000n,
        quoteBalance: 3000_000_000n,
        basePrice: 1500,
      }));

      const inventory = strategy.getInventory();
      expect(inventory.baseBalance).toBe(2_000_000_000_000_000_000n);
      expect(inventory.quoteBalance).toBe(3000_000_000n);
      expect(inventory.baseValueUsd).toBeCloseTo(3000, 0);
      expect(inventory.quoteValueUsd).toBeCloseTo(3000, 0);
    });

    it('replaces previous data', () => {
      const strategy = new MarketMaker({ baseToken, quoteToken });

      strategy.setMarketData(makeMarketData({ midPrice: 2000 }));
      strategy.setMarketData(makeMarketData({ midPrice: 3000 }));

      const signal = strategy.shouldExecute(makeContext());
      expect(signal).not.toBeNull();
      expect(signal!.metadata['midPrice']).toBe(3000);
    });
  });
});
