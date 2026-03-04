import { describe, it, expect } from 'vitest';
import {
  calculateSma,
  calculateEma,
  calculateRsi,
  calculateMacd,
  calculateBollingerBands,
} from '../indicators.js';

// ---------------------------------------------------------------------------
// Known test data
// ---------------------------------------------------------------------------

// 10 known close prices for testing
const CLOSES_10 = [44, 44.34, 44.09, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08];

// 20 close prices for Bollinger Band testing
const CLOSES_20 = [
  86.16, 89.09, 88.78, 90.32, 89.07, 91.15, 89.44, 89.18, 86.93, 87.68,
  86.96, 89.43, 89.32, 88.72, 87.45, 87.26, 89.50, 87.90, 89.13, 90.70,
];

// ---------------------------------------------------------------------------
// calculateSma
// ---------------------------------------------------------------------------

describe('calculateSma', () => {
  it('returns correct SMA for period 3', () => {
    const data = [1, 2, 3, 4, 5];
    const result = calculateSma(data, 3);

    expect(result[0]).toBeNaN();
    expect(result[1]).toBeNaN();
    expect(result[2]).toBeCloseTo(2, 10);     // (1+2+3)/3 = 2
    expect(result[3]).toBeCloseTo(3, 10);     // (2+3+4)/3 = 3
    expect(result[4]).toBeCloseTo(4, 10);     // (3+4+5)/3 = 4
  });

  it('returns all NaN when data shorter than period', () => {
    const result = calculateSma([1, 2], 5);
    expect(result.every((v) => isNaN(v))).toBe(true);
  });

  it('returns correct length', () => {
    const result = calculateSma([1, 2, 3, 4, 5], 3);
    expect(result).toHaveLength(5);
  });

  it('handles period of 1', () => {
    const data = [10, 20, 30];
    const result = calculateSma(data, 1);

    expect(result[0]).toBe(10);
    expect(result[1]).toBe(20);
    expect(result[2]).toBe(30);
  });

  it('is deterministic', () => {
    const result1 = calculateSma(CLOSES_10, 5);
    const result2 = calculateSma(CLOSES_10, 5);

    for (let i = 0; i < result1.length; i++) {
      if (isNaN(result1[i])) {
        expect(isNaN(result2[i])).toBe(true);
      } else {
        expect(result1[i]).toBe(result2[i]);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// calculateEma
// ---------------------------------------------------------------------------

describe('calculateEma', () => {
  it('first EMA value equals SMA of first period values', () => {
    const data = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const ema = calculateEma(data, 5);
    const sma = calculateSma(data, 5);

    expect(ema[4]).toBeCloseTo(sma[4], 10); // Both should be 3
  });

  it('subsequent values differ from SMA (EMA weighs recent data more)', () => {
    const data = [1, 2, 3, 4, 5, 10, 15, 20, 25, 30]; // Accelerating uptrend
    const ema = calculateEma(data, 5);
    const sma = calculateSma(data, 5);

    // EMA should be higher than SMA for uptrend (more weight on recent)
    expect(ema[9]).toBeGreaterThan(sma[9]);
  });

  it('returns NaN for indices before period - 1', () => {
    const ema = calculateEma(CLOSES_10, 5);

    for (let i = 0; i < 4; i++) {
      expect(ema[i]).toBeNaN();
    }
    expect(ema[4]).not.toBeNaN();
  });

  it('returns all NaN when data shorter than period', () => {
    const result = calculateEma([1, 2], 5);
    expect(result.every((v) => isNaN(v))).toBe(true);
  });

  it('is deterministic', () => {
    const result1 = calculateEma(CLOSES_10, 5);
    const result2 = calculateEma(CLOSES_10, 5);

    for (let i = 0; i < result1.length; i++) {
      if (isNaN(result1[i])) {
        expect(isNaN(result2[i])).toBe(true);
      } else {
        expect(result1[i]).toBe(result2[i]);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// calculateRsi
// ---------------------------------------------------------------------------

describe('calculateRsi', () => {
  it('returns NaN for indices before period', () => {
    const closes = [44, 44.34, 44.09, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08,
      45.89, 46.03, 45.61, 46.28, 46.28, 46.00];
    const rsi = calculateRsi(closes, 14);

    for (let i = 0; i <= 13; i++) {
      expect(rsi[i]).toBeNaN();
    }
    // First value at index 14
    expect(rsi[14]).not.toBeNaN();
  });

  it('returns value between 0 and 100', () => {
    const closes = CLOSES_10.concat([45, 46, 47, 48, 49, 50]);
    const rsi = calculateRsi(closes, 5);

    for (const val of rsi) {
      if (!isNaN(val)) {
        expect(val).toBeGreaterThanOrEqual(0);
        expect(val).toBeLessThanOrEqual(100);
      }
    }
  });

  it('returns high RSI (>70) for strong uptrend', () => {
    // Consistent uptrend
    const closes: number[] = [];
    let price = 100;
    for (let i = 0; i < 30; i++) {
      closes.push(price);
      price += 2;
    }
    const rsi = calculateRsi(closes, 14);
    const lastRsi = rsi[rsi.length - 1];

    expect(lastRsi).toBeGreaterThan(70);
  });

  it('returns low RSI (<30) for strong downtrend', () => {
    const closes: number[] = [];
    let price = 200;
    for (let i = 0; i < 30; i++) {
      closes.push(price);
      price -= 2;
    }
    const rsi = calculateRsi(closes, 14);
    const lastRsi = rsi[rsi.length - 1];

    expect(lastRsi).toBeLessThan(30);
  });

  it('returns 100 when all changes are gains (avgLoss = 0)', () => {
    // Strict monotonic increase
    const closes = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
    const rsi = calculateRsi(closes, 14);

    expect(rsi[14]).toBe(100);
    expect(rsi[15]).toBe(100);
  });

  it('is deterministic', () => {
    const result1 = calculateRsi(CLOSES_10, 5);
    const result2 = calculateRsi(CLOSES_10, 5);

    for (let i = 0; i < result1.length; i++) {
      if (isNaN(result1[i])) {
        expect(isNaN(result2[i])).toBe(true);
      } else {
        expect(result1[i]).toBe(result2[i]);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// calculateMacd
// ---------------------------------------------------------------------------

describe('calculateMacd', () => {
  it('MACD line equals fast EMA minus slow EMA', () => {
    // Generate enough data for MACD(12, 26, 9)
    const closes: number[] = [];
    let price = 100;
    for (let i = 0; i < 50; i++) {
      closes.push(price);
      price += (i % 5 === 0 ? 2 : -0.5);
    }

    const { macd } = calculateMacd(closes, 12, 26, 9);
    const fastEma = calculateEma(closes, 12);
    const slowEma = calculateEma(closes, 26);

    // Check valid MACD values
    for (let i = 25; i < closes.length; i++) {
      if (!isNaN(macd[i]) && !isNaN(fastEma[i]) && !isNaN(slowEma[i])) {
        expect(macd[i]).toBeCloseTo(fastEma[i] - slowEma[i], 10);
      }
    }
  });

  it('histogram equals MACD minus signal', () => {
    const closes: number[] = [];
    let price = 100;
    for (let i = 0; i < 50; i++) {
      closes.push(price);
      price += (i % 3 === 0 ? 1 : -0.3);
    }

    const { macd, signal, histogram } = calculateMacd(closes, 12, 26, 9);

    for (let i = 0; i < closes.length; i++) {
      if (!isNaN(histogram[i])) {
        expect(histogram[i]).toBeCloseTo(macd[i] - signal[i], 10);
      }
    }
  });

  it('returns all NaN for insufficient data', () => {
    const closes = [1, 2, 3]; // Not enough for MACD(12, 26, 9)
    const { macd, signal, histogram } = calculateMacd(closes, 12, 26, 9);

    expect(macd.every((v) => isNaN(v))).toBe(true);
    expect(signal.every((v) => isNaN(v))).toBe(true);
    expect(histogram.every((v) => isNaN(v))).toBe(true);
  });

  it('MACD is positive in uptrend (fast EMA > slow EMA)', () => {
    const closes: number[] = [];
    let price = 100;
    for (let i = 0; i < 60; i++) {
      closes.push(price);
      price += 1;
    }

    const { macd } = calculateMacd(closes, 12, 26, 9);
    const lastMacd = macd[macd.length - 1];

    expect(lastMacd).toBeGreaterThan(0);
  });

  it('is deterministic', () => {
    const closes: number[] = [];
    for (let i = 0; i < 50; i++) closes.push(100 + i * 0.5);

    const r1 = calculateMacd(closes, 12, 26, 9);
    const r2 = calculateMacd(closes, 12, 26, 9);

    for (let i = 0; i < closes.length; i++) {
      if (isNaN(r1.macd[i])) {
        expect(isNaN(r2.macd[i])).toBe(true);
      } else {
        expect(r1.macd[i]).toBe(r2.macd[i]);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// calculateBollingerBands
// ---------------------------------------------------------------------------

describe('calculateBollingerBands', () => {
  it('middle band equals SMA', () => {
    const { middle } = calculateBollingerBands(CLOSES_20, 20, 2);
    const sma = calculateSma(CLOSES_20, 20);

    for (let i = 0; i < CLOSES_20.length; i++) {
      if (isNaN(middle[i])) {
        expect(isNaN(sma[i])).toBe(true);
      } else {
        expect(middle[i]).toBeCloseTo(sma[i], 10);
      }
    }
  });

  it('upper band is above middle, lower band is below middle', () => {
    const { upper, middle, lower } = calculateBollingerBands(CLOSES_20, 20, 2);

    const lastIdx = CLOSES_20.length - 1;
    expect(upper[lastIdx]).toBeGreaterThan(middle[lastIdx]);
    expect(lower[lastIdx]).toBeLessThan(middle[lastIdx]);
  });

  it('band width is 2 * stdDevMultiplier * stdDev', () => {
    const { upper, lower } = calculateBollingerBands(CLOSES_20, 20, 2);

    const lastIdx = CLOSES_20.length - 1;
    const bandwidth = upper[lastIdx] - lower[lastIdx];

    // Calculate expected std dev manually
    const sma = CLOSES_20.reduce((s, v) => s + v, 0) / 20;
    let sumSq = 0;
    for (const c of CLOSES_20) {
      sumSq += (c - sma) * (c - sma);
    }
    const stdDev = Math.sqrt(sumSq / 20);

    expect(bandwidth).toBeCloseTo(2 * 2 * stdDev, 5);
  });

  it('returns NaN before period', () => {
    const { upper, middle, lower } = calculateBollingerBands(CLOSES_20, 20, 2);

    for (let i = 0; i < 19; i++) {
      expect(upper[i]).toBeNaN();
      expect(middle[i]).toBeNaN();
      expect(lower[i]).toBeNaN();
    }
  });

  it('handles constant prices (zero std dev)', () => {
    const closes = new Array(20).fill(100);
    const { upper, middle, lower } = calculateBollingerBands(closes, 20, 2);

    const lastIdx = closes.length - 1;
    expect(upper[lastIdx]).toBeCloseTo(100, 10);
    expect(middle[lastIdx]).toBeCloseTo(100, 10);
    expect(lower[lastIdx]).toBeCloseTo(100, 10);
  });

  it('is deterministic', () => {
    const r1 = calculateBollingerBands(CLOSES_20, 20, 2);
    const r2 = calculateBollingerBands(CLOSES_20, 20, 2);

    for (let i = 0; i < CLOSES_20.length; i++) {
      if (isNaN(r1.upper[i])) {
        expect(isNaN(r2.upper[i])).toBe(true);
      } else {
        expect(r1.upper[i]).toBe(r2.upper[i]);
        expect(r1.middle[i]).toBe(r2.middle[i]);
        expect(r1.lower[i]).toBe(r2.lower[i]);
      }
    }
  });
});
