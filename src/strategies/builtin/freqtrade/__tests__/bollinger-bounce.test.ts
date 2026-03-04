import { describe, it, expect, beforeEach } from 'vitest';
import { BollingerBounce, addBollingerBands } from '../bollinger-bounce.js';
import { resetActionCounter } from '../../../adapters/freqtrade-adapter.js';
import type { DataFrame, DataFrameRow } from '../../../adapters/freqtrade-adapter.js';
import { Store } from '../../../../core/store.js';
import type { StrategyContext, TokenInfo } from '../../../../core/types.js';
import { tokenAddress } from '../../../../core/types.js';
import { CHAINS } from '../../../../core/constants.js';
import { calculateBollingerBands } from '../../../adapters/indicators.js';

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

function makeRow(close: number): DataFrameRow {
  return {
    open: close - 0.5,
    high: close + 1,
    low: close - 1,
    close,
    volume: 1000,
  };
}

const testToken: TokenInfo = {
  address: tokenAddress('0x0000000000000000000000000000000000000abc'),
  symbol: 'WETH',
  decimals: 18,
};

/**
 * Generate closes where the last candle drops below the lower Bollinger Band.
 * Use stable prices then a sudden drop.
 */
function generateLowerBandBreachCloses(): number[] {
  const closes: number[] = [];
  // 25 candles oscillating near 100 (low volatility)
  for (let i = 0; i < 25; i++) {
    closes.push(100 + (i % 2 === 0 ? 0.5 : -0.5));
  }
  // Sudden drop way below the band
  closes.push(85);
  return closes;
}

/**
 * Generate closes where the last candle exceeds the upper Bollinger Band.
 * Use stable prices then a sudden spike.
 */
function generateUpperBandBreachCloses(): number[] {
  const closes: number[] = [];
  // 25 candles oscillating near 100
  for (let i = 0; i < 25; i++) {
    closes.push(100 + (i % 2 === 0 ? 0.5 : -0.5));
  }
  // Sudden spike way above the band
  closes.push(115);
  return closes;
}

/**
 * Generate closes that stay within the bands.
 */
function generateWithinBandsCloses(): number[] {
  const closes: number[] = [];
  for (let i = 0; i < 25; i++) {
    closes.push(100 + (i % 2 === 0 ? 0.5 : -0.5));
  }
  // Stay near middle
  closes.push(100);
  return closes;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BollingerBounce', () => {
  let strategy: BollingerBounce;
  const store = Store.getInstance();

  beforeEach(() => {
    store.reset();
    resetActionCounter();
    strategy = new BollingerBounce();
  });

  describe('identity and risk params', () => {
    it('has correct name', () => {
      expect(strategy.name).toBe('BollingerBounce');
    });

    it('has correct timeframe', () => {
      expect(strategy.timeframe).toBe('5m');
    });

    it('has correct stoploss', () => {
      expect(strategy.stoploss).toBe(-0.07);
    });

    it('has correct minimalRoi', () => {
      expect(strategy.minimalRoi).toEqual({ 0: 0.04, 30: 0.02 });
    });

    it('has trailing stop disabled', () => {
      expect(strategy.trailingStop).toBe(false);
    });

    it('passes config validation', () => {
      expect(() => strategy.validateConfig()).not.toThrow();
    });
  });

  describe('populateIndicators adds Bollinger Bands columns', () => {
    it('adds bb_upper, bb_middle, bb_lower columns', () => {
      const closes = generateLowerBandBreachCloses();
      const df: DataFrame = closes.map((c) => makeRow(c));

      const result = strategy.populateIndicators(df);

      // After period (20), BB columns should be populated
      const lastRow = result[result.length - 1];
      expect(lastRow).toHaveProperty('bb_upper');
      expect(lastRow).toHaveProperty('bb_middle');
      expect(lastRow).toHaveProperty('bb_lower');
      expect(lastRow.bb_upper).not.toBeNull();
      expect(lastRow.bb_middle).not.toBeNull();
      expect(lastRow.bb_lower).not.toBeNull();
    });

    it('returns null for rows before period', () => {
      const closes = generateLowerBandBreachCloses();
      const df: DataFrame = closes.map((c) => makeRow(c));

      const result = strategy.populateIndicators(df);

      // First 19 rows should have null (period = 20, first value at index 19)
      for (let i = 0; i < 19; i++) {
        expect(result[i].bb_upper).toBeNull();
        expect(result[i].bb_middle).toBeNull();
        expect(result[i].bb_lower).toBeNull();
      }
    });
  });

  describe('entry signal: close <= lower band', () => {
    it('generates enter_long when close drops to lower band', () => {
      const closes = generateLowerBandBreachCloses();
      const df: DataFrame = closes.map((c) => makeRow(c));

      strategy.setOhlcvData(df);
      strategy.setTradeToken(testToken, CHAINS.ETHEREUM);

      // Verify that the last close is actually below the lower band
      const { lower } = calculateBollingerBands(closes, 20, 2);
      const lastClose = closes[closes.length - 1];
      const lastLower = lower[lower.length - 1];
      expect(lastClose).toBeLessThanOrEqual(lastLower);

      const signal = strategy.shouldExecute(makeContext());

      expect(signal).not.toBeNull();
      expect(signal!.direction).toBe('long');
      expect(signal!.reason).toContain('enter_long');
    });

    it('does not generate entry when price is within bands', () => {
      const closes = generateWithinBandsCloses();
      const df: DataFrame = closes.map((c) => makeRow(c));

      strategy.setOhlcvData(df);
      strategy.setTradeToken(testToken, CHAINS.ETHEREUM);

      // Verify that the last close is within the bands
      const { upper, lower } = calculateBollingerBands(closes, 20, 2);
      const lastClose = closes[closes.length - 1];
      const lastUpper = upper[upper.length - 1];
      const lastLower = lower[lower.length - 1];
      expect(lastClose).toBeGreaterThan(lastLower);
      expect(lastClose).toBeLessThan(lastUpper);

      const signal = strategy.shouldExecute(makeContext());

      expect(signal).toBeNull();
    });
  });

  describe('exit signal: close >= upper band', () => {
    it('generates exit_long when close exceeds upper band', () => {
      const closes = generateUpperBandBreachCloses();
      const df: DataFrame = closes.map((c) => makeRow(c));

      strategy.setOhlcvData(df);
      strategy.setTradeToken(testToken, CHAINS.ETHEREUM);

      // Verify that the last close is above the upper band
      const { upper } = calculateBollingerBands(closes, 20, 2);
      const lastClose = closes[closes.length - 1];
      const lastUpper = upper[upper.length - 1];
      expect(lastClose).toBeGreaterThanOrEqual(lastUpper);

      const signal = strategy.shouldExecute(makeContext());

      expect(signal).not.toBeNull();
      // exit takes priority over entry in the adapter
      expect(signal!.direction).toBe('exit');
      expect(signal!.reason).toContain('exit_long');
    });
  });

  describe('addBollingerBands helper', () => {
    it('returns null columns for insufficient data', () => {
      const df: DataFrame = [makeRow(100), makeRow(101)]; // only 2 rows, need 20
      const result = addBollingerBands(df, 20, 2);

      for (const row of result) {
        expect(row.bb_upper).toBeNull();
        expect(row.bb_middle).toBeNull();
        expect(row.bb_lower).toBeNull();
      }
    });

    it('produces deterministic results', () => {
      const closes = generateLowerBandBreachCloses();
      const df: DataFrame = closes.map((c) => makeRow(c));

      const result1 = addBollingerBands(df, 20, 2);
      const result2 = addBollingerBands(df, 20, 2);

      for (let i = 0; i < result1.length; i++) {
        expect(result1[i].bb_upper).toEqual(result2[i].bb_upper);
        expect(result1[i].bb_middle).toEqual(result2[i].bb_middle);
        expect(result1[i].bb_lower).toEqual(result2[i].bb_lower);
      }
    });

    it('upper band is always above lower band when defined', () => {
      const closes = generateLowerBandBreachCloses();
      const df: DataFrame = closes.map((c) => makeRow(c));

      const result = addBollingerBands(df, 20, 2);

      for (const row of result) {
        if (row.bb_upper !== null && row.bb_lower !== null) {
          expect(row.bb_upper as number).toBeGreaterThan(row.bb_lower as number);
        }
      }
    });
  });

  describe('buildExecution', () => {
    it('creates a valid execution plan for entry', () => {
      const closes = generateLowerBandBreachCloses();
      const df: DataFrame = closes.map((c) => makeRow(c));

      strategy.setOhlcvData(df);
      strategy.setTradeToken(testToken, CHAINS.ETHEREUM);

      const signal = strategy.shouldExecute(makeContext());
      expect(signal).not.toBeNull();

      const plan = strategy.buildExecution(signal!, makeContext());

      expect(plan.strategyName).toBe('BollingerBounce');
      expect(plan.actions.length).toBeGreaterThan(0);
      expect(plan.actions[0].type).toBe('swap');
      expect(plan.metadata.adapter).toBe('freqtrade');
    });
  });
});
