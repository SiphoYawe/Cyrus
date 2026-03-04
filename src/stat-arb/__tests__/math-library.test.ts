import { describe, it, expect, beforeEach } from 'vitest';
import { Store } from '../../core/store.js';
import {
  pearsonCorrelation,
  engleGrangerTest,
  ouHalfLife,
  rollingZScore,
  olsHedgeRatio,
  computeLogReturns,
  computeMean,
  computeStd,
  validatePriceSeries,
  isFiniteNumber,
  clamp,
  StatArbMathError,
  STAT_ARB_MATH_CONSTANTS,
} from '../math-library.js';

// Helper: generate N prices from a seed with linear trend + noise
function generatePriceSeries(n: number, start: number, trend: number, seed: number): number[] {
  const prices: number[] = [];
  let val = start;
  let rng = seed;
  for (let i = 0; i < n; i++) {
    // Simple LCG pseudorandom
    rng = (rng * 1103515245 + 12345) & 0x7fffffff;
    const noise = ((rng / 0x7fffffff) - 0.5) * 2;
    val += trend + noise;
    prices.push(Math.max(val, 0.01));
  }
  return prices;
}

// Helper: generate a random walk
function randomWalk(n: number, start: number, seed: number): number[] {
  const prices: number[] = [start];
  let rng = seed;
  for (let i = 1; i < n; i++) {
    rng = (rng * 1103515245 + 12345) & 0x7fffffff;
    const step = ((rng / 0x7fffffff) - 0.5) * 2;
    prices.push(Math.max(prices[i - 1] + step, 0.01));
  }
  return prices;
}

// Helper: generate cointegrated pair
function cointegratedPair(
  n: number,
  slope: number,
  intercept: number,
  seed: number,
): { seriesA: number[]; seriesB: number[] } {
  const seriesB = randomWalk(n, 100, seed);
  const seriesA: number[] = [];
  let rng = seed + 42;
  for (let i = 0; i < n; i++) {
    rng = (rng * 1103515245 + 12345) & 0x7fffffff;
    const noise = ((rng / 0x7fffffff) - 0.5) * 1.5;
    seriesA.push(slope * seriesB[i] + intercept + noise);
  }
  return { seriesA, seriesB };
}

describe('Stat Arb Math Library', () => {
  beforeEach(() => {
    Store.getInstance().reset();
  });

  // --- computeLogReturns ---

  describe('computeLogReturns', () => {
    it('computes log returns for known prices [100, 110, 105]', () => {
      const returns = computeLogReturns([100, 110, 105]);
      expect(returns).toHaveLength(2);
      expect(returns[0]).toBeCloseTo(Math.log(110 / 100), 10);
      expect(returns[1]).toBeCloseTo(Math.log(105 / 110), 10);
    });

    it('throws on single-element array', () => {
      expect(() => computeLogReturns([100])).toThrow(StatArbMathError);
    });

    it('throws on non-positive prices', () => {
      expect(() => computeLogReturns([100, 0, 50])).toThrow(StatArbMathError);
      expect(() => computeLogReturns([100, -5, 50])).toThrow(StatArbMathError);
    });
  });

  // --- pearsonCorrelation ---

  describe('pearsonCorrelation', () => {
    it('returns 1.0 for perfectly correlated series', () => {
      // Same uptrend: identical log returns → r = 1.0
      const series = Array.from({ length: 50 }, (_, i) => 100 + i * 2);
      const result = pearsonCorrelation(series, series);
      expect(result.correlation).toBeCloseTo(1.0, 6);
      expect(result.sampleSize).toBe(49);
    });

    it('returns -1.0 for perfectly anti-correlated series', () => {
      // Create series with inversely correlated log returns
      // When A's log return is positive, B's is negative by same magnitude
      const n = 50;
      const seriesA: number[] = [100];
      const seriesB: number[] = [100];
      let rng = 42;
      for (let i = 1; i < n; i++) {
        rng = (rng * 1103515245 + 12345) & 0x7fffffff;
        const logReturn = ((rng / 0x7fffffff) - 0.5) * 0.1;
        seriesA.push(seriesA[i - 1] * Math.exp(logReturn));
        seriesB.push(seriesB[i - 1] * Math.exp(-logReturn));
      }
      const result = pearsonCorrelation(seriesA, seriesB);
      expect(result.correlation).toBeCloseTo(-1.0, 4);
    });

    it('returns ~0 for uncorrelated series', () => {
      const seriesA = generatePriceSeries(100, 100, 0.1, 12345);
      const seriesB = generatePriceSeries(100, 100, 0.1, 99999);
      const result = pearsonCorrelation(seriesA, seriesB);
      expect(Math.abs(result.correlation)).toBeLessThan(0.5);
    });

    it('returns correct sampleSize (n-1 due to log returns)', () => {
      const series = Array.from({ length: 40 }, (_, i) => 100 + i);
      const result = pearsonCorrelation(series, series);
      expect(result.sampleSize).toBe(39);
    });

    it('throws on unequal-length arrays', () => {
      const a = Array.from({ length: 40 }, (_, i) => 100 + i);
      const b = Array.from({ length: 50 }, (_, i) => 100 + i);
      expect(() => pearsonCorrelation(a, b)).toThrow(StatArbMathError);
    });

    it('throws on arrays shorter than MIN_SAMPLE_SIZE', () => {
      const short = Array.from({ length: 10 }, (_, i) => 100 + i);
      expect(() => pearsonCorrelation(short, short)).toThrow(StatArbMathError);
    });

    it('returns 0 for constant series (zero variance)', () => {
      const constant = new Array(40).fill(100);
      const varying = Array.from({ length: 40 }, (_, i) => 100 + i);
      // constant series has zero log returns → zero std → correlation = 0
      // But computeLogReturns of constant gives all zeros, std=0
      const result = pearsonCorrelation(constant, varying);
      expect(result.correlation).toBe(0);
    });
  });

  // --- engleGrangerTest ---

  describe('engleGrangerTest', () => {
    it('detects cointegration in series with shared trend', () => {
      const { seriesA, seriesB } = cointegratedPair(200, 2.0, 5.0, 42);
      const result = engleGrangerTest(seriesA, seriesB);
      expect(result.cointegrated).toBe(true);
      expect(result.pValue).toBeLessThan(0.05);
      expect(result.slope).toBeCloseTo(2.0, 0);
      expect(result.residuals).toHaveLength(200);
    });

    it('rejects cointegration for independent random walks', () => {
      const seriesA = randomWalk(200, 100, 111);
      const seriesB = randomWalk(200, 100, 999);
      const result = engleGrangerTest(seriesA, seriesB);
      // Most of the time, independent random walks are not cointegrated
      // We can't guarantee this every time but for these seeds it should hold
      expect(result.pValue).toBeGreaterThan(0.01);
    });

    it('returns correct slope and residuals', () => {
      // Perfect linear relationship: A = 3*B + 10
      const seriesB = randomWalk(200, 50, 777);
      const seriesA = seriesB.map((b) => 3 * b + 10);
      const result = engleGrangerTest(seriesA, seriesB);
      expect(result.slope).toBeCloseTo(3.0, 4);
      expect(result.intercept).toBeCloseTo(10.0, 2);
      // Residuals should be near zero
      const maxResidual = Math.max(...result.residuals.map(Math.abs));
      expect(maxResidual).toBeLessThan(0.01);
    });

    it('throws on series shorter than DEFAULT_LOOKBACK', () => {
      const short = Array.from({ length: 100 }, (_, i) => 100 + i);
      expect(() => engleGrangerTest(short, short)).toThrow(StatArbMathError);
    });

    it('throws on unequal-length arrays', () => {
      const a = randomWalk(200, 100, 1);
      const b = randomWalk(180, 100, 2);
      expect(() => engleGrangerTest(a, b)).toThrow(StatArbMathError);
    });
  });

  // --- ouHalfLife ---

  describe('ouHalfLife', () => {
    it('computes correct half-life for mean-reverting spread', () => {
      // Simulate OU process: x_{t+1} = x_t + theta * x_t + noise
      // theta = -0.05 → half-life ≈ ln(2) / -ln(1 + (-0.05)) ≈ 13.5h
      const n = 200;
      const theta = -0.05;
      const spread: number[] = [0];
      let rng = 42;
      for (let i = 1; i < n; i++) {
        rng = (rng * 1103515245 + 12345) & 0x7fffffff;
        const noise = ((rng / 0x7fffffff) - 0.5) * 0.5;
        spread.push(spread[i - 1] + theta * spread[i - 1] + noise);
      }
      const result = ouHalfLife(spread);
      expect(result.theta).toBeLessThan(0);
      expect(result.halfLifeHours).toBeGreaterThan(0);
      expect(result.halfLifeHours).toBeLessThan(100);
      expect(result.isStationary).toBe(true);
    });

    it('returns isStationary=false for explosive series (theta >= 0)', () => {
      // Explosive: each step increases spread
      const spread = Array.from({ length: 50 }, (_, i) => i * i);
      const result = ouHalfLife(spread);
      expect(result.isStationary).toBe(false);
      expect(result.halfLifeHours).toBe(Infinity);
    });

    it('returns Infinity half-life for non-stationary random walk', () => {
      const walk = randomWalk(100, 0, 321);
      const result = ouHalfLife(walk);
      // Random walk has theta ~ 0, so halfLife should be very large or Infinity
      if (result.theta >= 0) {
        expect(result.halfLifeHours).toBe(Infinity);
        expect(result.isStationary).toBe(false);
      } else {
        // If theta is slightly negative by chance, half-life will be very large
        expect(result.halfLifeHours).toBeGreaterThan(48);
      }
    });

    it('throws on arrays shorter than 10', () => {
      expect(() => ouHalfLife([1, 2, 3, 4, 5])).toThrow(StatArbMathError);
    });

    it('throws on arrays with NaN', () => {
      const spread = Array.from({ length: 20 }, (_, i) => i);
      spread[5] = NaN;
      expect(() => ouHalfLife(spread)).toThrow(StatArbMathError);
    });

    it('throws on arrays with Infinity', () => {
      const spread = Array.from({ length: 20 }, (_, i) => i);
      spread[10] = Infinity;
      expect(() => ouHalfLife(spread)).toThrow(StatArbMathError);
    });
  });

  // --- rollingZScore ---

  describe('rollingZScore', () => {
    it('computes z-scores for known spread with window=3', () => {
      // Simple test: seriesA = spread, seriesB = zeros, hedgeRatio = 0
      const seriesA = [1, 2, 3, 2, 1, 0, -1, 0, 1, 2];
      const seriesB = new Array(10).fill(0);
      const result = rollingZScore(seriesA, seriesB, 0, 3);

      // First 2 elements should be NaN (indices 0, 1)
      expect(result.zScores[0]).toBeNaN();
      expect(result.zScores[1]).toBeNaN();

      // Index 2: window [1,2,3], mean=2, std=1, z=(3-2)/1 = 1
      expect(result.zScores[2]).toBeCloseTo(1.0, 4);

      // Check spread is just seriesA since hedgeRatio=0
      expect(result.spread).toEqual(seriesA);
    });

    it('returns NaN for indices before window', () => {
      const n = 20;
      const seriesA = Array.from({ length: n }, (_, i) => 100 + i);
      const seriesB = Array.from({ length: n }, (_, i) => 50 + i * 0.5);
      const result = rollingZScore(seriesA, seriesB, 1.0, 5);

      for (let i = 0; i < 4; i++) {
        expect(result.zScores[i]).toBeNaN();
      }
      // Index 4 (window=5) should have a value
      expect(isFiniteNumber(result.zScores[4])).toBe(true);
    });

    it('handles zero standard deviation (constant spread) with z=0', () => {
      // A - hedgeRatio * B is constant
      const seriesA = new Array(10).fill(100);
      const seriesB = new Array(10).fill(50);
      const result = rollingZScore(seriesA, seriesB, 2.0, 3);
      // spread = 100 - 2*50 = 0 for all points → std = 0 → z = 0
      for (let i = 2; i < 10; i++) {
        expect(result.zScores[i]).toBe(0);
      }
    });

    it('currentZScore is the last valid z-score', () => {
      const seriesA = Array.from({ length: 20 }, (_, i) => 100 + Math.sin(i));
      const seriesB = Array.from({ length: 20 }, (_, i) => 50 + Math.cos(i));
      const result = rollingZScore(seriesA, seriesB, 1.5, 5);
      expect(result.currentZScore).toBe(result.zScores[19]);
    });

    it('throws on window < 2', () => {
      const s = Array.from({ length: 10 }, (_, i) => i);
      expect(() => rollingZScore(s, s, 1, 1)).toThrow(StatArbMathError);
    });

    it('throws on window > series length', () => {
      const s = Array.from({ length: 5 }, (_, i) => i);
      expect(() => rollingZScore(s, s, 1, 10)).toThrow(StatArbMathError);
    });

    it('throws on unequal-length arrays', () => {
      const a = [1, 2, 3, 4, 5];
      const b = [1, 2, 3];
      expect(() => rollingZScore(a, b, 1, 2)).toThrow(StatArbMathError);
    });
  });

  // --- olsHedgeRatio ---

  describe('olsHedgeRatio', () => {
    it('returns slope=2.0, intercept=1.0, R²=1.0 for y = 2x + 1', () => {
      const x = Array.from({ length: 50 }, (_, i) => 10 + i);
      const y = x.map((xi) => 2 * xi + 1);
      const result = olsHedgeRatio(y, x);
      expect(result.slope).toBeCloseTo(2.0, 6);
      expect(result.intercept).toBeCloseTo(1.0, 4);
      expect(result.rSquared).toBeCloseTo(1.0, 6);
    });

    it('returns R² < 1 for noisy linear relationship', () => {
      const x = Array.from({ length: 50 }, (_, i) => 10 + i);
      let rng = 55;
      const y = x.map((xi) => {
        rng = (rng * 1103515245 + 12345) & 0x7fffffff;
        const noise = ((rng / 0x7fffffff) - 0.5) * 10;
        return 2 * xi + 1 + noise;
      });
      const result = olsHedgeRatio(y, x);
      expect(result.slope).toBeCloseTo(2.0, 0); // Within 1 decimal
      expect(result.rSquared).toBeLessThan(1.0);
      expect(result.rSquared).toBeGreaterThan(0.5);
    });

    it('throws on arrays containing NaN', () => {
      const x = Array.from({ length: 40 }, (_, i) => 10 + i);
      const y = [...x];
      y[5] = NaN;
      expect(() => olsHedgeRatio(y, x)).toThrow(StatArbMathError);
    });

    it('throws on arrays containing Infinity', () => {
      const x = Array.from({ length: 40 }, (_, i) => 10 + i);
      const y = [...x];
      y[10] = Infinity;
      expect(() => olsHedgeRatio(y, x)).toThrow(StatArbMathError);
    });

    it('throws on unequal-length arrays', () => {
      const a = Array.from({ length: 40 }, (_, i) => i);
      const b = Array.from({ length: 50 }, (_, i) => i);
      expect(() => olsHedgeRatio(a, b)).toThrow(StatArbMathError);
    });

    it('throws on arrays shorter than MIN_SAMPLE_SIZE', () => {
      const short = [1, 2, 3, 4, 5];
      expect(() => olsHedgeRatio(short, short)).toThrow(StatArbMathError);
    });
  });

  // --- Utility functions ---

  describe('computeMean', () => {
    it('returns correct mean for simple array', () => {
      expect(computeMean([1, 2, 3, 4, 5])).toBeCloseTo(3.0, 10);
    });

    it('returns 0 for empty array', () => {
      expect(computeMean([])).toBe(0);
    });

    it('handles large arrays with small increments (Kahan summation)', () => {
      const n = 100000;
      const values = Array.from({ length: n }, () => 0.1);
      const mean = computeMean(values);
      expect(mean).toBeCloseTo(0.1, 8);
    });
  });

  describe('computeStd', () => {
    it('returns correct sample std dev', () => {
      // [2, 4, 4, 4, 5, 5, 7, 9] → mean=5, sample std ≈ 2.138
      const std = computeStd([2, 4, 4, 4, 5, 5, 7, 9]);
      expect(std).toBeCloseTo(2.138, 2);
    });

    it('returns 0 for single-element array', () => {
      expect(computeStd([42])).toBe(0);
    });

    it('returns 0 for constant array', () => {
      expect(computeStd([5, 5, 5, 5])).toBe(0);
    });
  });

  describe('validatePriceSeries', () => {
    it('passes for valid series', () => {
      expect(() =>
        validatePriceSeries([1, 2, 3, 4, 5], 'test', 3),
      ).not.toThrow();
    });

    it('throws on empty array', () => {
      expect(() => validatePriceSeries([], 'test', 1)).toThrow(StatArbMathError);
    });

    it('throws on too-short array', () => {
      expect(() => validatePriceSeries([1, 2], 'test', 5)).toThrow(StatArbMathError);
    });

    it('throws on NaN value', () => {
      expect(() => validatePriceSeries([1, NaN, 3], 'test', 2)).toThrow(StatArbMathError);
    });

    it('throws on Infinity value', () => {
      expect(() => validatePriceSeries([1, Infinity, 3], 'test', 2)).toThrow(StatArbMathError);
    });
  });

  describe('isFiniteNumber', () => {
    it('returns true for finite numbers', () => {
      expect(isFiniteNumber(42)).toBe(true);
      expect(isFiniteNumber(-3.14)).toBe(true);
      expect(isFiniteNumber(0)).toBe(true);
    });

    it('returns false for NaN and Infinity', () => {
      expect(isFiniteNumber(NaN)).toBe(false);
      expect(isFiniteNumber(Infinity)).toBe(false);
      expect(isFiniteNumber(-Infinity)).toBe(false);
    });
  });

  describe('clamp', () => {
    it('clamps to min and max', () => {
      expect(clamp(5, 0, 10)).toBe(5);
      expect(clamp(-5, 0, 10)).toBe(0);
      expect(clamp(15, 0, 10)).toBe(10);
    });
  });

  // --- Numerical stability ---

  describe('numerical stability', () => {
    it('handles very large price values (1e10)', () => {
      const series = Array.from({ length: 50 }, (_, i) => 1e10 + i * 1e6);
      const result = pearsonCorrelation(series, series);
      expect(result.correlation).toBeCloseTo(1.0, 4);
    });

    it('handles very small price values (1e-5)', () => {
      const series = Array.from({ length: 50 }, (_, i) => 1e-5 + i * 1e-7);
      const result = pearsonCorrelation(series, series);
      expect(result.correlation).toBeCloseTo(1.0, 4);
    });
  });
});
