import { describe, it, expect, beforeEach } from 'vitest';
import {
  HyperliquidPerps,
} from '../hyperliquid-perps.js';
import type {
  PerpMarketData,
  PerpSubStrategy,
  RiskTier,
} from '../hyperliquid-perps.js';
import type {
  StrategyContext,
  StrategySignal,
  Position,
} from '../../../core/types.js';
import { chainId, tokenAddress } from '../../../core/types.js';
import { Store } from '../../../core/store.js';
import { CHAINS, USDC_ADDRESSES } from '../../../core/constants.js';
import type { RegimeClassification } from '../../../ai/types.js';

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
    strategyId: 'HyperliquidPerps',
    chainId: CHAINS.ARBITRUM,
    tokenAddress: USDC_ADDRESSES[CHAINS.ARBITRUM as number]!,
    entryPrice: 2000,
    currentPrice: 2050,
    amount: 100_000_000n,
    enteredAt: Date.now(),
    pnlUsd: 50,
    pnlPercent: 0.025,
    ...overrides,
  };
}

/** Create PerpMarketData with optional overrides per symbol. */
function makeMarketData(overrides: {
  fundingRates?: Map<string, { rate: number; premium: number; timestamp: number }>;
  ohlcv?: Map<string, { open: number; high: number; low: number; close: number; volume: number }[]>;
  volumes?: Map<string, number[]>;
} = {}): PerpMarketData {
  return {
    fundingRates: overrides.fundingRates ?? new Map(),
    ohlcv: overrides.ohlcv ?? new Map(),
    volumes: overrides.volumes ?? new Map(),
  };
}

/**
 * Generate a series of close prices forming a bullish trend.
 * Starts at `start`, increments by `step` each candle.
 */
function makeBullishCandles(
  count: number,
  start: number = 2000,
  step: number = 10,
): { open: number; high: number; low: number; close: number; volume: number }[] {
  return Array.from({ length: count }, (_, i) => {
    const close = start + i * step;
    return {
      open: close - step / 2,
      high: close + step / 4,
      low: close - step,
      close,
      volume: 1000 + i * 10,
    };
  });
}

/**
 * Generate a series of close prices forming a bearish trend.
 */
function makeBearishCandles(
  count: number,
  start: number = 3000,
  step: number = 10,
): { open: number; high: number; low: number; close: number; volume: number }[] {
  return Array.from({ length: count }, (_, i) => {
    const close = start - i * step;
    return {
      open: close + step / 2,
      high: close + step,
      low: close - step / 4,
      close,
      volume: 1000 + i * 10,
    };
  });
}

/**
 * Generate candles with an extreme deviation at the end (above mean).
 */
function makeHighDeviationCandles(
  count: number,
  basePrice: number = 2000,
  spikeMultiplier: number = 3,
): { open: number; high: number; low: number; close: number; volume: number }[] {
  const candles = Array.from({ length: count }, () => ({
    open: basePrice - 1,
    high: basePrice + 2,
    low: basePrice - 2,
    close: basePrice,
    volume: 1000,
  }));

  // Compute stddev of the base prices (should be ~0 for constant prices)
  // Spike the last candle significantly above mean
  const spike = basePrice + basePrice * 0.1 * spikeMultiplier; // big move up
  candles[candles.length - 1] = {
    open: basePrice,
    high: spike + 10,
    low: basePrice - 5,
    close: spike,
    volume: 5000,
  };

  return candles;
}

/**
 * Generate candles with an extreme deviation below mean.
 */
function makeLowDeviationCandles(
  count: number,
  basePrice: number = 2000,
  spikeMultiplier: number = 3,
): { open: number; high: number; low: number; close: number; volume: number }[] {
  const candles = Array.from({ length: count }, () => ({
    open: basePrice + 1,
    high: basePrice + 2,
    low: basePrice - 2,
    close: basePrice,
    volume: 1000,
  }));

  const spike = basePrice - basePrice * 0.1 * spikeMultiplier;
  candles[candles.length - 1] = {
    open: basePrice,
    high: basePrice + 5,
    low: spike - 10,
    close: spike,
    volume: 5000,
  };

  return candles;
}

function setRegime(regime: RegimeClassification['regime'], confidence: number = 0.8): void {
  const store = Store.getInstance();
  store.setRegimeClassification({
    regime,
    confidence,
    reasoning: `Test regime: ${regime}`,
    timestamp: Date.now(),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HyperliquidPerps', () => {
  beforeEach(() => {
    Store.getInstance().reset();
  });

  // --- Initialization ---

  describe('initialization with each sub-strategy mode', () => {
    it('initializes with funding_arb mode', () => {
      const strategy = new HyperliquidPerps({ mode: 'funding_arb' });
      expect(strategy.config.mode).toBe('funding_arb');
      expect(strategy.name).toBe('HyperliquidPerps');
      expect(strategy.timeframe).toBe('1m');
    });

    it('initializes with momentum mode', () => {
      const strategy = new HyperliquidPerps({ mode: 'momentum' });
      expect(strategy.config.mode).toBe('momentum');
    });

    it('initializes with mean_reversion mode', () => {
      const strategy = new HyperliquidPerps({ mode: 'mean_reversion' });
      expect(strategy.config.mode).toBe('mean_reversion');
    });

    it('initializes with auto mode', () => {
      const strategy = new HyperliquidPerps({ mode: 'auto' });
      expect(strategy.config.mode).toBe('auto');
    });

    it('defaults to auto mode when no mode specified', () => {
      const strategy = new HyperliquidPerps();
      expect(strategy.config.mode).toBe('auto');
    });

    it('accepts custom config values', () => {
      const strategy = new HyperliquidPerps({
        mode: 'momentum',
        tier: 'degen',
        markets: ['ETH', 'BTC'],
        fundingThreshold: 0.0005,
        momentumRocPeriod: 20,
        momentumFastMa: 5,
        momentumSlowMa: 30,
        momentumVolumeMultiplier: 2.0,
        meanReversionWindow: 30,
        meanReversionStdDevThreshold: 3.0,
      });

      expect(strategy.config.mode).toBe('momentum');
      expect(strategy.config.tier).toBe('degen');
      expect(strategy.config.markets).toEqual(['ETH', 'BTC']);
      expect(strategy.config.fundingThreshold).toBe(0.0005);
      expect(strategy.config.momentumRocPeriod).toBe(20);
      expect(strategy.config.momentumFastMa).toBe(5);
      expect(strategy.config.momentumSlowMa).toBe(30);
      expect(strategy.config.momentumVolumeMultiplier).toBe(2.0);
      expect(strategy.config.meanReversionWindow).toBe(30);
      expect(strategy.config.meanReversionStdDevThreshold).toBe(3.0);
    });

    it('passes validateConfig with default risk params', () => {
      const strategy = new HyperliquidPerps();
      expect(() => strategy.validateConfig()).not.toThrow();
    });
  });

  // --- Funding Arb ---

  describe('funding arb', () => {
    it('generates short signal when funding > threshold', () => {
      const strategy = new HyperliquidPerps({ mode: 'funding_arb' });

      strategy.setMarketData(makeMarketData({
        fundingRates: new Map([
          ['ETH', { rate: 0.001, premium: 0.0005, timestamp: Date.now() }], // 0.1% per period
        ]),
      }));

      const signal = strategy.shouldExecute(makeContext());

      expect(signal).not.toBeNull();
      expect(signal!.direction).toBe('short');
      expect(signal!.metadata['subStrategy']).toBe('funding_arb');
      expect(signal!.metadata['symbol']).toBe('ETH');
      expect(signal!.reason).toContain('funding_arb');
      expect(signal!.reason).toContain('short ETH');
    });

    it('returns null when funding is below threshold', () => {
      const strategy = new HyperliquidPerps({ mode: 'funding_arb' });

      strategy.setMarketData(makeMarketData({
        fundingRates: new Map([
          ['ETH', { rate: 0.00005, premium: 0.0001, timestamp: Date.now() }], // below 0.01%
        ]),
      }));

      const signal = strategy.shouldExecute(makeContext());
      expect(signal).toBeNull();
    });

    it('returns null when net yield is negative (costs exceed funding)', () => {
      const strategy = new HyperliquidPerps({
        mode: 'funding_arb',
        fundingThreshold: 0.000001, // very low threshold so rate passes threshold check
      });

      // Rate is above threshold but annualized yield < 2% cost
      // annualized = 0.000015 * 1095 = 0.016425 = 1.6% < 2% cost
      strategy.setMarketData(makeMarketData({
        fundingRates: new Map([
          ['ETH', { rate: 0.000015, premium: 0.00001, timestamp: Date.now() }],
        ]),
      }));

      const signal = strategy.shouldExecute(makeContext());
      expect(signal).toBeNull();
    });

    it('picks highest net yield among multiple markets', () => {
      const strategy = new HyperliquidPerps({ mode: 'funding_arb' });

      strategy.setMarketData(makeMarketData({
        fundingRates: new Map([
          ['ETH', { rate: 0.0005, premium: 0.0002, timestamp: Date.now() }],
          ['BTC', { rate: 0.002, premium: 0.001, timestamp: Date.now() }], // higher
          ['SOL', { rate: 0.0003, premium: 0.0001, timestamp: Date.now() }],
        ]),
      }));

      const signal = strategy.shouldExecute(makeContext());
      expect(signal).not.toBeNull();
      expect(signal!.metadata['symbol']).toBe('BTC');
    });

    it('returns null when no market data is set', () => {
      const strategy = new HyperliquidPerps({ mode: 'funding_arb' });
      const signal = strategy.shouldExecute(makeContext());
      expect(signal).toBeNull();
    });
  });

  // --- Momentum ---

  describe('momentum', () => {
    it('generates long signal on bullish crossover with volume', () => {
      const strategy = new HyperliquidPerps({
        mode: 'momentum',
        momentumFastMa: 5,
        momentumSlowMa: 10,
        momentumRocPeriod: 5,
        momentumVolumeMultiplier: 1.5,
      });

      // Bullish: closes trending up, fast MA > slow MA, positive ROC
      const candles = makeBullishCandles(25, 1900, 10);
      // Create volumes with the last one being high
      const volumes = Array.from({ length: 25 }, (_, i) =>
        i < 24 ? 100 : 200, // last volume is 2x average (> 1.5x)
      );

      strategy.setMarketData(makeMarketData({
        ohlcv: new Map([['ETH', candles]]),
        volumes: new Map([['ETH', volumes]]),
      }));

      const signal = strategy.shouldExecute(makeContext());

      expect(signal).not.toBeNull();
      expect(signal!.direction).toBe('long');
      expect(signal!.metadata['subStrategy']).toBe('momentum');
      expect(signal!.metadata['symbol']).toBe('ETH');
      expect(signal!.reason).toContain('momentum');
      expect(signal!.reason).toContain('long');
    });

    it('generates short signal on bearish crossover with volume', () => {
      const strategy = new HyperliquidPerps({
        mode: 'momentum',
        momentumFastMa: 5,
        momentumSlowMa: 10,
        momentumRocPeriod: 5,
        momentumVolumeMultiplier: 1.5,
      });

      const candles = makeBearishCandles(25, 3000, 10);
      const volumes = Array.from({ length: 25 }, (_, i) =>
        i < 24 ? 100 : 200,
      );

      strategy.setMarketData(makeMarketData({
        ohlcv: new Map([['ETH', candles]]),
        volumes: new Map([['ETH', volumes]]),
      }));

      const signal = strategy.shouldExecute(makeContext());

      expect(signal).not.toBeNull();
      expect(signal!.direction).toBe('short');
      expect(signal!.metadata['subStrategy']).toBe('momentum');
      expect(signal!.reason).toContain('short');
    });

    it('returns null without volume confirmation', () => {
      const strategy = new HyperliquidPerps({
        mode: 'momentum',
        momentumFastMa: 5,
        momentumSlowMa: 10,
        momentumRocPeriod: 5,
        momentumVolumeMultiplier: 1.5,
      });

      const candles = makeBullishCandles(25, 1900, 10);
      // All volumes the same -- last is not above 1.5x average
      const volumes = Array.from({ length: 25 }, () => 100);

      strategy.setMarketData(makeMarketData({
        ohlcv: new Map([['ETH', candles]]),
        volumes: new Map([['ETH', volumes]]),
      }));

      const signal = strategy.shouldExecute(makeContext());
      expect(signal).toBeNull();
    });

    it('returns null with insufficient data', () => {
      const strategy = new HyperliquidPerps({
        mode: 'momentum',
        momentumFastMa: 9,
        momentumSlowMa: 21,
        momentumRocPeriod: 14,
      });

      // Only 5 candles -- not enough for MA(21)
      const candles = makeBullishCandles(5);
      const volumes = Array.from({ length: 5 }, () => 100);

      strategy.setMarketData(makeMarketData({
        ohlcv: new Map([['ETH', candles]]),
        volumes: new Map([['ETH', volumes]]),
      }));

      const signal = strategy.shouldExecute(makeContext());
      expect(signal).toBeNull();
    });
  });

  // --- Mean Reversion ---

  describe('mean reversion', () => {
    it('generates short signal when price > mean + 2*stddev', () => {
      const strategy = new HyperliquidPerps({
        mode: 'mean_reversion',
        meanReversionWindow: 20,
        meanReversionStdDevThreshold: 2.0,
      });

      const candles = makeHighDeviationCandles(25, 2000, 3);

      strategy.setMarketData(makeMarketData({
        ohlcv: new Map([['ETH', candles]]),
      }));

      const signal = strategy.shouldExecute(makeContext());

      expect(signal).not.toBeNull();
      expect(signal!.direction).toBe('short');
      expect(signal!.metadata['subStrategy']).toBe('mean_reversion');
      expect(signal!.metadata['symbol']).toBe('ETH');
      expect(signal!.reason).toContain('mean_reversion');
      expect((signal!.metadata['zScore'] as number)).toBeGreaterThan(0);
    });

    it('generates long signal when price < mean - 2*stddev', () => {
      const strategy = new HyperliquidPerps({
        mode: 'mean_reversion',
        meanReversionWindow: 20,
        meanReversionStdDevThreshold: 2.0,
      });

      const candles = makeLowDeviationCandles(25, 2000, 3);

      strategy.setMarketData(makeMarketData({
        ohlcv: new Map([['ETH', candles]]),
      }));

      const signal = strategy.shouldExecute(makeContext());

      expect(signal).not.toBeNull();
      expect(signal!.direction).toBe('long');
      expect(signal!.metadata['subStrategy']).toBe('mean_reversion');
      expect((signal!.metadata['zScore'] as number)).toBeLessThan(0);
    });

    it('returns null when price within normal range', () => {
      const strategy = new HyperliquidPerps({
        mode: 'mean_reversion',
        meanReversionWindow: 20,
        meanReversionStdDevThreshold: 2.0,
      });

      // All same price -- z-score cannot exceed threshold (stddev ~0)
      // Actually with stddev=0, the check skips (stdDev === 0 guard)
      const candles = Array.from({ length: 25 }, () => ({
        open: 2000,
        high: 2002,
        low: 1998,
        close: 2000,
        volume: 1000,
      }));

      strategy.setMarketData(makeMarketData({
        ohlcv: new Map([['ETH', candles]]),
      }));

      const signal = strategy.shouldExecute(makeContext());
      expect(signal).toBeNull();
    });

    it('returns null with insufficient data', () => {
      const strategy = new HyperliquidPerps({
        mode: 'mean_reversion',
        meanReversionWindow: 20,
      });

      const candles = makeBullishCandles(10); // < window of 20

      strategy.setMarketData(makeMarketData({
        ohlcv: new Map([['ETH', candles]]),
      }));

      const signal = strategy.shouldExecute(makeContext());
      expect(signal).toBeNull();
    });
  });

  // --- Auto Mode ---

  describe('auto mode', () => {
    it('selects funding_arb for crab regime', () => {
      const strategy = new HyperliquidPerps({ mode: 'auto' });
      setRegime('crab');

      // Provide funding data so funding_arb can produce a signal
      strategy.setMarketData(makeMarketData({
        fundingRates: new Map([
          ['ETH', { rate: 0.001, premium: 0.0005, timestamp: Date.now() }],
        ]),
      }));

      const signal = strategy.shouldExecute(makeContext());
      expect(signal).not.toBeNull();
      expect(signal!.metadata['subStrategy']).toBe('funding_arb');
    });

    it('selects momentum for trending (bull) regime', () => {
      const strategy = new HyperliquidPerps({
        mode: 'auto',
        momentumFastMa: 5,
        momentumSlowMa: 10,
        momentumRocPeriod: 5,
        momentumVolumeMultiplier: 1.5,
      });
      setRegime('bull');

      const candles = makeBullishCandles(25, 1900, 10);
      const volumes = Array.from({ length: 25 }, (_, i) =>
        i < 24 ? 100 : 200,
      );

      strategy.setMarketData(makeMarketData({
        ohlcv: new Map([['ETH', candles]]),
        volumes: new Map([['ETH', volumes]]),
      }));

      const signal = strategy.shouldExecute(makeContext());
      expect(signal).not.toBeNull();
      expect(signal!.metadata['subStrategy']).toBe('momentum');
    });

    it('selects momentum for trending (bear) regime', () => {
      const strategy = new HyperliquidPerps({
        mode: 'auto',
        momentumFastMa: 5,
        momentumSlowMa: 10,
        momentumRocPeriod: 5,
        momentumVolumeMultiplier: 1.5,
      });
      setRegime('bear');

      const candles = makeBearishCandles(25, 3000, 10);
      const volumes = Array.from({ length: 25 }, (_, i) =>
        i < 24 ? 100 : 200,
      );

      strategy.setMarketData(makeMarketData({
        ohlcv: new Map([['ETH', candles]]),
        volumes: new Map([['ETH', volumes]]),
      }));

      const signal = strategy.shouldExecute(makeContext());
      expect(signal).not.toBeNull();
      expect(signal!.metadata['subStrategy']).toBe('momentum');
    });

    it('selects mean_reversion for volatile regime', () => {
      const strategy = new HyperliquidPerps({
        mode: 'auto',
        meanReversionWindow: 20,
        meanReversionStdDevThreshold: 2.0,
      });
      setRegime('volatile');

      const candles = makeHighDeviationCandles(25, 2000, 3);

      strategy.setMarketData(makeMarketData({
        ohlcv: new Map([['ETH', candles]]),
      }));

      const signal = strategy.shouldExecute(makeContext());
      expect(signal).not.toBeNull();
      expect(signal!.metadata['subStrategy']).toBe('mean_reversion');
    });

    it('falls back to funding_arb when no regime data available', () => {
      const strategy = new HyperliquidPerps({ mode: 'auto' });
      // No setRegime call -- store has no regime

      strategy.setMarketData(makeMarketData({
        fundingRates: new Map([
          ['ETH', { rate: 0.001, premium: 0.0005, timestamp: Date.now() }],
        ]),
      }));

      const signal = strategy.shouldExecute(makeContext());
      expect(signal).not.toBeNull();
      expect(signal!.metadata['subStrategy']).toBe('funding_arb');
    });
  });

  // --- buildExecution ---

  describe('buildExecution', () => {
    it('includes bridge when capital not on Arbitrum', () => {
      const strategy = new HyperliquidPerps({ mode: 'funding_arb' });

      const usdcAddress = USDC_ADDRESSES[CHAINS.ARBITRUM as number]!;
      const signal: StrategySignal = {
        direction: 'short',
        tokenPair: {
          from: { address: usdcAddress, symbol: 'USDC', decimals: 6 },
          to: { address: usdcAddress, symbol: 'USDC', decimals: 6 },
        },
        sourceChain: CHAINS.ETHEREUM, // NOT Arbitrum
        destChain: CHAINS.ARBITRUM,
        strength: 0.7,
        reason: 'funding_arb: short ETH',
        metadata: {
          subStrategy: 'funding_arb',
          symbol: 'ETH',
          fundingRate: 0.001,
        },
      };

      const plan = strategy.buildExecution(signal, makeContext());

      expect(plan.strategyName).toBe('HyperliquidPerps');
      expect(plan.actions.length).toBeGreaterThanOrEqual(2);
      expect(plan.actions[0]!.type).toBe('bridge');
      expect(plan.actions[1]!.type).toBe('perp');
      expect(plan.metadata['needsBridge']).toBe(true);
      expect(plan.estimatedCostUsd).toBeGreaterThan(5); // includes bridge cost
    });

    it('skips bridge when capital on Arbitrum', () => {
      const strategy = new HyperliquidPerps({ mode: 'funding_arb' });

      const usdcAddress = USDC_ADDRESSES[CHAINS.ARBITRUM as number]!;
      const signal: StrategySignal = {
        direction: 'short',
        tokenPair: {
          from: { address: usdcAddress, symbol: 'USDC', decimals: 6 },
          to: { address: usdcAddress, symbol: 'USDC', decimals: 6 },
        },
        sourceChain: CHAINS.ARBITRUM,
        destChain: CHAINS.ARBITRUM,
        strength: 0.7,
        reason: 'funding_arb: short ETH',
        metadata: {
          subStrategy: 'funding_arb',
          symbol: 'ETH',
          fundingRate: 0.001,
        },
      };

      const plan = strategy.buildExecution(signal, makeContext());

      expect(plan.actions).toHaveLength(1);
      expect(plan.actions[0]!.type).toBe('perp');
      expect(plan.metadata['needsBridge']).toBe(false);
    });

    it('sets correct perp action fields', () => {
      const strategy = new HyperliquidPerps({ mode: 'momentum', tier: 'growth' });

      const usdcAddress = USDC_ADDRESSES[CHAINS.ARBITRUM as number]!;
      const signal: StrategySignal = {
        direction: 'long',
        tokenPair: {
          from: { address: usdcAddress, symbol: 'USDC', decimals: 6 },
          to: { address: usdcAddress, symbol: 'USDC', decimals: 6 },
        },
        sourceChain: CHAINS.ARBITRUM,
        destChain: CHAINS.ARBITRUM,
        strength: 0.5,
        reason: 'momentum: long ETH',
        metadata: {
          subStrategy: 'momentum',
          symbol: 'ETH',
        },
      };

      const plan = strategy.buildExecution(signal, makeContext());
      const perpAction = plan.actions[0]!;

      expect(perpAction.type).toBe('perp');
      expect((perpAction as { symbol: string }).symbol).toBe('ETH');
      expect((perpAction as { side: string }).side).toBe('long');
      expect((perpAction as { orderType: string }).orderType).toBe('market');
      expect((perpAction as { leverage: number }).leverage).toBeGreaterThanOrEqual(2);
      expect((perpAction as { leverage: number }).leverage).toBeLessThanOrEqual(5);

      // Triple Barrier params in metadata
      expect(perpAction.metadata['stoploss']).toBe(-0.05);
      expect(perpAction.metadata['takeProfit']).toBeDefined();
      expect(perpAction.metadata['timeLimitMs']).toBeDefined();
      expect(perpAction.metadata['tier']).toBe('growth');
    });

    it('builds short perp action from short signal', () => {
      const strategy = new HyperliquidPerps({ mode: 'funding_arb' });

      const usdcAddress = USDC_ADDRESSES[CHAINS.ARBITRUM as number]!;
      const signal: StrategySignal = {
        direction: 'short',
        tokenPair: {
          from: { address: usdcAddress, symbol: 'USDC', decimals: 6 },
          to: { address: usdcAddress, symbol: 'USDC', decimals: 6 },
        },
        sourceChain: CHAINS.ARBITRUM,
        destChain: CHAINS.ARBITRUM,
        strength: 0.6,
        reason: 'funding_arb: short ETH',
        metadata: {
          subStrategy: 'funding_arb',
          symbol: 'ETH',
        },
      };

      const plan = strategy.buildExecution(signal, makeContext());
      const perpAction = plan.actions[0]!;

      expect((perpAction as { side: string }).side).toBe('short');
    });
  });

  // --- Growth Tier ---

  describe('growth tier', () => {
    it('has -0.05 stoploss', () => {
      const strategy = new HyperliquidPerps({ tier: 'growth' });
      expect(strategy.stoploss).toBe(-0.05);
    });

    it('computes leverage between 2x and 5x', () => {
      const strategy = new HyperliquidPerps({ tier: 'growth', mode: 'funding_arb' });

      const usdcAddress = USDC_ADDRESSES[CHAINS.ARBITRUM as number]!;

      // Low strength -> min leverage
      const lowSignal: StrategySignal = {
        direction: 'short',
        tokenPair: {
          from: { address: usdcAddress, symbol: 'USDC', decimals: 6 },
          to: { address: usdcAddress, symbol: 'USDC', decimals: 6 },
        },
        sourceChain: CHAINS.ARBITRUM,
        destChain: CHAINS.ARBITRUM,
        strength: 0.0,
        reason: 'test',
        metadata: { subStrategy: 'funding_arb', symbol: 'ETH' },
      };

      const lowPlan = strategy.buildExecution(lowSignal, makeContext());
      const lowLev = (lowPlan.actions[0]! as { leverage: number }).leverage;
      expect(lowLev).toBe(2);

      // High strength -> max leverage
      const highSignal: StrategySignal = {
        ...lowSignal,
        strength: 1.0,
      };

      const highPlan = strategy.buildExecution(highSignal, makeContext());
      const highLev = (highPlan.actions[0]! as { leverage: number }).leverage;
      expect(highLev).toBe(5);
    });

    it('has maxPositions of 3', () => {
      const strategy = new HyperliquidPerps({ tier: 'growth' });
      expect(strategy.maxPositions).toBe(3);
    });

    it('passes validateConfig', () => {
      const strategy = new HyperliquidPerps({ tier: 'growth' });
      expect(() => strategy.validateConfig()).not.toThrow();
    });
  });

  // --- Degen Tier ---

  describe('degen tier', () => {
    it('has -0.10 stoploss', () => {
      const strategy = new HyperliquidPerps({ tier: 'degen' });
      expect(strategy.stoploss).toBe(-0.10);
    });

    it('computes leverage between 5x and 20x', () => {
      const strategy = new HyperliquidPerps({ tier: 'degen', mode: 'funding_arb' });

      const usdcAddress = USDC_ADDRESSES[CHAINS.ARBITRUM as number]!;

      const lowSignal: StrategySignal = {
        direction: 'short',
        tokenPair: {
          from: { address: usdcAddress, symbol: 'USDC', decimals: 6 },
          to: { address: usdcAddress, symbol: 'USDC', decimals: 6 },
        },
        sourceChain: CHAINS.ARBITRUM,
        destChain: CHAINS.ARBITRUM,
        strength: 0.0,
        reason: 'test',
        metadata: { subStrategy: 'funding_arb', symbol: 'ETH' },
      };

      const lowPlan = strategy.buildExecution(lowSignal, makeContext());
      const lowLev = (lowPlan.actions[0]! as { leverage: number }).leverage;
      expect(lowLev).toBe(5);

      const highSignal: StrategySignal = {
        ...lowSignal,
        strength: 1.0,
      };

      const highPlan = strategy.buildExecution(highSignal, makeContext());
      const highLev = (highPlan.actions[0]! as { leverage: number }).leverage;
      expect(highLev).toBe(20);
    });

    it('has maxPositions of 5', () => {
      const strategy = new HyperliquidPerps({ tier: 'degen' });
      expect(strategy.maxPositions).toBe(5);
    });

    it('has wider take-profit via minimalRoi', () => {
      const growth = new HyperliquidPerps({ tier: 'growth' });
      const degen = new HyperliquidPerps({ tier: 'degen' });

      // Degen tier stoploss is wider (-0.10 vs -0.05) and take-profit is wider
      expect(degen.minimalRoi[0]).toBeGreaterThan(growth.minimalRoi[0]!);
    });

    it('passes validateConfig', () => {
      const strategy = new HyperliquidPerps({ tier: 'degen' });
      expect(() => strategy.validateConfig()).not.toThrow();
    });
  });

  // --- Max positions gate ---

  describe('max positions gate', () => {
    it('returns null when max positions reached', () => {
      const strategy = new HyperliquidPerps({ mode: 'funding_arb', tier: 'growth' });

      strategy.setMarketData(makeMarketData({
        fundingRates: new Map([
          ['ETH', { rate: 0.001, premium: 0.0005, timestamp: Date.now() }],
        ]),
      }));

      // Growth tier maxPositions = 3
      const positions = Array.from({ length: 3 }, (_, i) =>
        makePosition({ id: `pos-${i}` }),
      );

      const signal = strategy.shouldExecute(makeContext({ positions }));
      expect(signal).toBeNull();
    });
  });

  // --- Filters ---

  describe('filters', () => {
    it('rejects when no market data', () => {
      const strategy = new HyperliquidPerps();
      // No setMarketData call
      const result = strategy.evaluateFilters(makeContext());
      expect(result).toBe(false);
    });

    it('passes when market data is set and positions below limit', () => {
      const strategy = new HyperliquidPerps();
      strategy.setMarketData(makeMarketData({
        fundingRates: new Map([
          ['ETH', { rate: 0.001, premium: 0.0005, timestamp: Date.now() }],
        ]),
      }));

      const result = strategy.evaluateFilters(makeContext());
      expect(result).toBe(true);
    });

    it('rejects when max positions reached in filter', () => {
      const strategy = new HyperliquidPerps({ tier: 'growth' });
      strategy.setMarketData(makeMarketData({
        fundingRates: new Map([
          ['ETH', { rate: 0.001, premium: 0.0005, timestamp: Date.now() }],
        ]),
      }));

      const positions = Array.from({ length: 3 }, (_, i) =>
        makePosition({ id: `pos-${i}` }),
      );

      const result = strategy.evaluateFilters(makeContext({ positions }));
      expect(result).toBe(false);
    });
  });

  // --- confirmTradeEntry ---

  describe('confirmTradeEntry', () => {
    it('returns true when subStrategy metadata is present', () => {
      const strategy = new HyperliquidPerps();
      const plan = {
        id: 'plan-1',
        strategyName: 'HyperliquidPerps',
        actions: [],
        estimatedCostUsd: 2,
        estimatedDurationMs: 5000,
        metadata: { subStrategy: 'funding_arb' },
      };
      expect(strategy.confirmTradeEntry(plan)).toBe(true);
    });

    it('returns false when subStrategy metadata is absent', () => {
      const strategy = new HyperliquidPerps();
      const plan = {
        id: 'plan-1',
        strategyName: 'HyperliquidPerps',
        actions: [],
        estimatedCostUsd: 2,
        estimatedDurationMs: 5000,
        metadata: {},
      };
      expect(strategy.confirmTradeEntry(plan)).toBe(false);
    });
  });

  // --- setMarketData ---

  describe('setMarketData', () => {
    it('makes data available for shouldExecute', () => {
      const strategy = new HyperliquidPerps({ mode: 'funding_arb' });

      strategy.setMarketData(makeMarketData({
        fundingRates: new Map([
          ['ETH', { rate: 0.001, premium: 0.0005, timestamp: Date.now() }],
        ]),
      }));

      const signal = strategy.shouldExecute(makeContext());
      expect(signal).not.toBeNull();
    });

    it('replaces previous data', () => {
      const strategy = new HyperliquidPerps({ mode: 'funding_arb' });

      // First data: ETH with high funding
      strategy.setMarketData(makeMarketData({
        fundingRates: new Map([
          ['ETH', { rate: 0.001, premium: 0.0005, timestamp: Date.now() }],
        ]),
      }));

      // Replace with BTC only (ETH gone)
      strategy.setMarketData(makeMarketData({
        fundingRates: new Map([
          ['BTC', { rate: 0.002, premium: 0.001, timestamp: Date.now() }],
        ]),
      }));

      const signal = strategy.shouldExecute(makeContext());
      expect(signal).not.toBeNull();
      expect(signal!.metadata['symbol']).toBe('BTC');
    });
  });
});
