import { describe, it, expect, beforeEach } from 'vitest';
import { RsiMeanReversion, addRsi } from '../rsi-mean-reversion.js';
import { resetActionCounter } from '../../../adapters/freqtrade-adapter.js';
import type { DataFrame, DataFrameRow } from '../../../adapters/freqtrade-adapter.js';
import { Store } from '../../../../core/store.js';
import type { StrategyContext, TokenInfo } from '../../../../core/types.js';
import { chainId, tokenAddress } from '../../../../core/types.js';
import { CHAINS } from '../../../../core/constants.js';
import { calculateRsi } from '../../../adapters/indicators.js';

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
 * Generate a series of closes that produce a known RSI value.
 * To get RSI < 30, we need a strong downtrend.
 * To get RSI > 70, we need a strong uptrend.
 */
function generateDowntrendCloses(length: number): number[] {
  // Start high, go steadily lower
  const closes: number[] = [];
  let price = 200;
  for (let i = 0; i < length; i++) {
    closes.push(price);
    price -= 3; // Strong consistent drops
  }
  return closes;
}

function generateUptrendCloses(length: number): number[] {
  const closes: number[] = [];
  let price = 100;
  for (let i = 0; i < length; i++) {
    closes.push(price);
    price += 3; // Strong consistent rises
  }
  return closes;
}

function generateFlatCloses(length: number, price: number = 100): number[] {
  return new Array(length).fill(price);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RsiMeanReversion', () => {
  let strategy: RsiMeanReversion;
  const store = Store.getInstance();

  beforeEach(() => {
    store.reset();
    resetActionCounter();
    strategy = new RsiMeanReversion();
  });

  describe('identity and risk params', () => {
    it('has correct name', () => {
      expect(strategy.name).toBe('RsiMeanReversion');
    });

    it('has correct timeframe', () => {
      expect(strategy.timeframe).toBe('5m');
    });

    it('has correct stoploss', () => {
      expect(strategy.stoploss).toBe(-0.10);
    });

    it('has correct minimalRoi', () => {
      expect(strategy.minimalRoi).toEqual({ 0: 0.05, 60: 0.02, 120: 0.01 });
    });

    it('passes config validation', () => {
      expect(() => strategy.validateConfig()).not.toThrow();
    });
  });

  describe('populateIndicators adds RSI column', () => {
    it('adds rsi column to dataframe', () => {
      // Need at least period + 1 rows for RSI to have a value
      const closes = generateDowntrendCloses(20);
      const df: DataFrame = closes.map((c) => makeRow(c));

      const result = strategy.populateIndicators(df);

      // First 14 rows should have null RSI (period = 14, first value at index 14)
      for (let i = 0; i < 14; i++) {
        expect(result[i].rsi).toBeNull();
      }

      // After period, RSI should be a number
      expect(result[14].rsi).not.toBeNull();
      expect(typeof result[14].rsi).toBe('number');
    });
  });

  describe('entry signal: RSI < 30', () => {
    it('generates enter_long when RSI drops below 30', () => {
      // Consistent downtrend produces RSI < 30
      const closes = generateDowntrendCloses(25);
      const df: DataFrame = closes.map((c) => makeRow(c));

      strategy.setOhlcvData(df);
      strategy.setTradeToken(testToken, CHAINS.ETHEREUM);

      // Verify RSI is actually < 30 at the end
      const rsiValues = calculateRsi(closes, 14);
      const lastRsi = rsiValues[rsiValues.length - 1];
      expect(lastRsi).toBeLessThan(30);

      const signal = strategy.shouldExecute(makeContext());

      expect(signal).not.toBeNull();
      expect(signal!.direction).toBe('long');
      expect(signal!.reason).toContain('enter_long');
    });

    it('does not generate enter_long when RSI is between 30 and 70', () => {
      // Flat prices should give RSI near 50
      const closes = generateFlatCloses(25, 100);
      // Add tiny fluctuation so RSI is computable
      const modifiedCloses = closes.map((c, i) => c + (i % 2 === 0 ? 0.01 : -0.01));
      const df: DataFrame = modifiedCloses.map((c) => makeRow(c));

      strategy.setOhlcvData(df);
      strategy.setTradeToken(testToken, CHAINS.ETHEREUM);

      const rsiValues = calculateRsi(modifiedCloses, 14);
      const lastRsi = rsiValues[rsiValues.length - 1];
      expect(lastRsi).toBeGreaterThanOrEqual(30);
      expect(lastRsi).toBeLessThanOrEqual(70);

      const signal = strategy.shouldExecute(makeContext());

      expect(signal).toBeNull();
    });
  });

  describe('exit signal: RSI > 70', () => {
    it('generates exit_long when RSI rises above 70', () => {
      // Consistent uptrend produces RSI > 70
      const closes = generateUptrendCloses(25);
      const df: DataFrame = closes.map((c) => makeRow(c));

      strategy.setOhlcvData(df);
      strategy.setTradeToken(testToken, CHAINS.ETHEREUM);

      // Verify RSI is actually > 70 at the end
      const rsiValues = calculateRsi(closes, 14);
      const lastRsi = rsiValues[rsiValues.length - 1];
      expect(lastRsi).toBeGreaterThan(70);

      const signal = strategy.shouldExecute(makeContext());

      expect(signal).not.toBeNull();
      // exit takes priority over entry
      expect(signal!.direction).toBe('exit');
      expect(signal!.reason).toContain('exit_long');
    });
  });

  describe('addRsi helper function', () => {
    it('returns null for insufficient data', () => {
      const df: DataFrame = [makeRow(100), makeRow(101)]; // only 2 rows, need > 14
      const result = addRsi(df, 14);

      for (const row of result) {
        expect(row.rsi).toBeNull();
      }
    });

    it('produces deterministic results for same input', () => {
      const closes = generateUptrendCloses(20);
      const df: DataFrame = closes.map((c) => makeRow(c));

      const result1 = addRsi(df, 14);
      const result2 = addRsi(df, 14);

      for (let i = 0; i < result1.length; i++) {
        expect(result1[i].rsi).toEqual(result2[i].rsi);
      }
    });
  });

  describe('buildExecution', () => {
    it('creates a valid execution plan', () => {
      const closes = generateDowntrendCloses(25);
      const df: DataFrame = closes.map((c) => makeRow(c));

      strategy.setOhlcvData(df);
      strategy.setTradeToken(testToken, CHAINS.ETHEREUM);

      const signal = strategy.shouldExecute(makeContext());
      expect(signal).not.toBeNull();

      const plan = strategy.buildExecution(signal!, makeContext());

      expect(plan.strategyName).toBe('RsiMeanReversion');
      expect(plan.actions.length).toBeGreaterThan(0);
      expect(plan.actions[0].type).toBe('swap');
      expect(plan.metadata.adapter).toBe('freqtrade');
    });
  });
});
