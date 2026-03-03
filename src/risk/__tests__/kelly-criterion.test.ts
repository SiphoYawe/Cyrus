import { describe, it, expect } from 'vitest';
import {
  calculateKellyFraction,
  calculatePositionSize,
  KELLY_SAFETY_CAP,
} from '../kelly-criterion.js';
import type { PositionSizeInput } from '../types.js';

describe('Kelly Criterion', () => {
  describe('calculateKellyFraction', () => {
    it('computes correct Kelly fraction for p=0.6, b=2.0', () => {
      // f = 0.6 - (1 - 0.6) / 2.0 = 0.6 - 0.2 = 0.4
      expect(calculateKellyFraction(0.6, 2.0)).toBeCloseTo(0.4);
    });

    it('returns negative for p=0.3, b=0.5', () => {
      // f = 0.3 - (1 - 0.3) / 0.5 = 0.3 - 1.4 = -1.1
      expect(calculateKellyFraction(0.3, 0.5)).toBeCloseTo(-1.1);
    });

    it('edge case: p=0, b=1 → f = 0 - 1/1 = -1', () => {
      expect(calculateKellyFraction(0, 1)).toBeCloseTo(-1.0);
    });

    it('edge case: p=1, b=1 → f = 1 - 0/1 = 1', () => {
      expect(calculateKellyFraction(1, 1)).toBeCloseTo(1.0);
    });
  });

  describe('calculatePositionSize', () => {
    const defaultInput: PositionSizeInput = {
      winProbability: 0.6,
      payoffRatio: 2.0,
      tierAvailableCapital: 10000,
      maxPositionSizeUsd: 5000,
      kellyFraction: 1.0, // full Kelly
    };

    // --- Basic Kelly calculation ---

    it('basic Kelly: p=0.6, b=2.0 → f=0.4, size=0.4 * 10000 = $4000', () => {
      const result = calculatePositionSize(defaultInput);
      // raw Kelly = 0.4, but safety cap is 0.25 → capped
      expect(result.kellyFractionRaw).toBeCloseTo(0.4);
      expect(result.kellyFractionApplied).toBe(KELLY_SAFETY_CAP);
      expect(result.recommendedSizeUsd).toBe(2500); // 0.25 * 10000
      expect(result.cappedBy).toBe('safety-cap');
    });

    it('concrete example from AC4: capital=$10,000, Kelly fraction results in $1,000', () => {
      // f raw = 0.10 → with full Kelly and no cap → $1,000
      // p - (1-p)/b = 0.10 → solve: p = 0.55, b = 9 → f = 0.55 - 0.45/9 = 0.55 - 0.05 = 0.50
      // Better: p = 0.52, b = 5 → f = 0.52 - 0.48/5 = 0.52 - 0.096 = 0.424
      // Let's use p=0.55, b=10 → f = 0.55 - 0.45/10 = 0.55 - 0.045 = 0.505
      // Use half-Kelly: 0.505 * 0.5 = 0.2525 → still > 0.25 safety cap
      // Let's use quarter-Kelly: p=0.6, b=2 → f=0.4 * 0.25 = 0.10 → size = 0.10 * 10000 = $1000
      const input: PositionSizeInput = {
        ...defaultInput,
        kellyFraction: 0.25, // quarter-Kelly
      };
      const result = calculatePositionSize(input);
      expect(result.kellyFractionRaw).toBeCloseTo(0.4);
      expect(result.kellyFractionApplied).toBeCloseTo(0.10);
      expect(result.recommendedSizeUsd).toBeCloseTo(1000);
      expect(result.cappedBy).toBe('none');
    });

    // --- Negative Kelly rejection ---

    it('rejects position when Kelly fraction is negative', () => {
      const input: PositionSizeInput = {
        ...defaultInput,
        winProbability: 0.3,
        payoffRatio: 0.5,
      };
      const result = calculatePositionSize(input);
      expect(result.recommendedSizeUsd).toBe(0);
      expect(result.cappedBy).toBe('rejected');
      expect(result.kellyFractionRaw).toBeLessThan(0);
    });

    // --- Fractional Kelly ---

    it('applies half-Kelly: raw f=0.4, fraction=0.5 → effective f=0.2', () => {
      const input: PositionSizeInput = {
        ...defaultInput,
        kellyFraction: 0.5,
      };
      const result = calculatePositionSize(input);
      expect(result.kellyFractionRaw).toBeCloseTo(0.4);
      expect(result.kellyFractionApplied).toBeCloseTo(0.2);
      expect(result.recommendedSizeUsd).toBeCloseTo(2000);
    });

    // --- Safety cap ---

    it('caps at KELLY_SAFETY_CAP (25%) when effective fraction exceeds it', () => {
      // raw f = 0.4, half-Kelly → 0.2 (under cap), full Kelly → 0.4 (over cap)
      const input: PositionSizeInput = {
        ...defaultInput,
        kellyFraction: 1.0,
      };
      const result = calculatePositionSize(input);
      expect(result.kellyFractionApplied).toBe(KELLY_SAFETY_CAP);
      expect(result.recommendedSizeUsd).toBe(2500); // 0.25 * 10000
      expect(result.cappedBy).toBe('safety-cap');
    });

    // --- maxPositionSizeUsd cap ---

    it('caps at maxPositionSizeUsd when Kelly recommends more', () => {
      const input: PositionSizeInput = {
        ...defaultInput,
        tierAvailableCapital: 100000,
        maxPositionSizeUsd: 3000,
        kellyFraction: 0.5,
      };
      const result = calculatePositionSize(input);
      // raw f = 0.4, half-Kelly → 0.2, size = 0.2 * 100000 = 20000 → capped to 3000
      expect(result.recommendedSizeUsd).toBe(3000);
      expect(result.cappedBy).toBe('max-position-size');
    });

    // --- Invalid inputs ---

    it('rejects NaN win probability', () => {
      const input: PositionSizeInput = { ...defaultInput, winProbability: NaN };
      const result = calculatePositionSize(input);
      expect(result.recommendedSizeUsd).toBe(0);
      expect(result.cappedBy).toBe('rejected');
    });

    it('rejects Infinity payoff ratio', () => {
      const input: PositionSizeInput = { ...defaultInput, payoffRatio: Infinity };
      const result = calculatePositionSize(input);
      expect(result.recommendedSizeUsd).toBe(0);
      expect(result.cappedBy).toBe('rejected');
    });

    it('rejects undefined-like inputs (negative payoff)', () => {
      const input: PositionSizeInput = { ...defaultInput, payoffRatio: -1 };
      const result = calculatePositionSize(input);
      expect(result.recommendedSizeUsd).toBe(0);
      expect(result.cappedBy).toBe('rejected');
    });

    it('rejects win probability > 1', () => {
      const input: PositionSizeInput = { ...defaultInput, winProbability: 1.5 };
      const result = calculatePositionSize(input);
      expect(result.recommendedSizeUsd).toBe(0);
      expect(result.cappedBy).toBe('rejected');
    });

    it('rejects negative win probability', () => {
      const input: PositionSizeInput = { ...defaultInput, winProbability: -0.1 };
      const result = calculatePositionSize(input);
      expect(result.recommendedSizeUsd).toBe(0);
      expect(result.cappedBy).toBe('rejected');
    });

    it('rejects negative tier capital', () => {
      const input: PositionSizeInput = { ...defaultInput, tierAvailableCapital: -1000 };
      const result = calculatePositionSize(input);
      expect(result.recommendedSizeUsd).toBe(0);
      expect(result.cappedBy).toBe('rejected');
    });

    // --- Edge cases ---

    it('zero available capital returns zero size (valid, not an error)', () => {
      const input: PositionSizeInput = { ...defaultInput, tierAvailableCapital: 0 };
      const result = calculatePositionSize(input);
      expect(result.recommendedSizeUsd).toBe(0);
      expect(result.cappedBy).toBe('none');
    });

    it('p=1, b=1 → f=1 → full capital, capped by safety', () => {
      const input: PositionSizeInput = {
        ...defaultInput,
        winProbability: 1.0,
        payoffRatio: 1.0,
        kellyFraction: 1.0,
      };
      const result = calculatePositionSize(input);
      expect(result.kellyFractionRaw).toBeCloseTo(1.0);
      expect(result.kellyFractionApplied).toBe(KELLY_SAFETY_CAP);
      expect(result.cappedBy).toBe('safety-cap');
    });
  });
});
