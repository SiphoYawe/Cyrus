import { describe, it, expect, beforeEach } from 'vitest';
import { Store } from '../../core/store.js';
import { LeverageSelectionError } from '../../utils/errors.js';
import {
  selectLeverage,
  type LeverageSelectionInput,
  type LeverageSelectionConfig,
} from '../leverage-selector.js';

function makeInput(overrides?: Partial<LeverageSelectionInput>): LeverageSelectionInput {
  return {
    correlation: 0.86,
    absZScore: 2.2,
    spreadVolatility: 0.01,
    ...overrides,
  };
}

function makeConfig(overrides?: Partial<LeverageSelectionConfig>): LeverageSelectionConfig {
  return {
    maxLeverage: 25,
    ...overrides,
  };
}

describe('LeverageSelector', () => {
  beforeEach(() => {
    Store.getInstance().reset();
  });

  // --- Ultra-high tier (x23) ---

  it('selects x23 for ultra-high confidence: corr=0.90, |Z|=3.0, low spread vol', () => {
    const result = selectLeverage(
      makeInput({ correlation: 0.90, absZScore: 3.0, spreadVolatility: 0.005 }),
      makeConfig(),
    );
    expect(result.leverage).toBe(23);
    expect(result.tier).toBe('ultra-high');
    expect(result.capped).toBe(false);
  });

  it('selects x23 at boundary: corr=0.871, |Z|=2.51, low spread vol', () => {
    const result = selectLeverage(
      makeInput({ correlation: 0.871, absZScore: 2.51, spreadVolatility: 0.005 }),
      makeConfig(),
    );
    expect(result.leverage).toBe(23);
    expect(result.tier).toBe('ultra-high');
  });

  // --- High tier (x18) ---

  it('selects x18 for high confidence: corr=0.86, |Z|=2.2', () => {
    const result = selectLeverage(makeInput(), makeConfig());
    expect(result.leverage).toBe(18);
    expect(result.tier).toBe('high');
  });

  it('falls back to x18 when ultra-high spread vol check fails: corr=0.90, |Z|=3.0, high spread vol', () => {
    const result = selectLeverage(
      makeInput({ correlation: 0.90, absZScore: 3.0, spreadVolatility: 0.05 }),
      makeConfig(),
    );
    expect(result.leverage).toBe(18);
    expect(result.tier).toBe('high');
  });

  // --- Moderate tier (x9) ---

  it('selects x9 for moderate confidence: corr=0.83, |Z|=1.8', () => {
    const result = selectLeverage(
      makeInput({ correlation: 0.83, absZScore: 1.8, spreadVolatility: 0.01 }),
      makeConfig(),
    );
    expect(result.leverage).toBe(9);
    expect(result.tier).toBe('moderate');
  });

  // --- Lower tier (x5) ---

  it('selects x5 for lower confidence: corr=0.80, |Z|=1.5', () => {
    const result = selectLeverage(
      makeInput({ correlation: 0.80, absZScore: 1.5, spreadVolatility: 0.01 }),
      makeConfig(),
    );
    expect(result.leverage).toBe(5);
    expect(result.tier).toBe('lower');
  });

  it('selects x5 at exact boundary: corr=0.80, |Z|=1.5 (inclusive)', () => {
    const result = selectLeverage(
      makeInput({ correlation: 0.80, absZScore: 1.5, spreadVolatility: 0.01 }),
      makeConfig(),
    );
    expect(result.leverage).toBe(5);
    expect(result.tier).toBe('lower');
    expect(result.capped).toBe(false);
  });

  // --- Below minimum thresholds ---

  it('throws LeverageSelectionError when corr < 0.80', () => {
    expect(() =>
      selectLeverage(
        makeInput({ correlation: 0.79, absZScore: 1.5 }),
        makeConfig(),
      ),
    ).toThrow(LeverageSelectionError);
  });

  it('throws LeverageSelectionError when |Z| < 1.5', () => {
    expect(() =>
      selectLeverage(
        makeInput({ correlation: 0.80, absZScore: 1.4 }),
        makeConfig(),
      ),
    ).toThrow(LeverageSelectionError);
  });

  it('throws LeverageSelectionError when both below minimum', () => {
    expect(() =>
      selectLeverage(
        makeInput({ correlation: 0.75, absZScore: 1.2 }),
        makeConfig(),
      ),
    ).toThrow(LeverageSelectionError);
  });

  it('LeverageSelectionError includes metrics in context', () => {
    try {
      selectLeverage(
        makeInput({ correlation: 0.75, absZScore: 1.2, spreadVolatility: 0.02 }),
        makeConfig(),
      );
      expect.fail('Should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(LeverageSelectionError);
      const err = e as LeverageSelectionError;
      expect(err.context.correlation).toBe(0.75);
      expect(err.context.absZScore).toBe(1.2);
    }
  });

  // --- Max leverage cap ---

  it('caps leverage when tier selects 23 but maxLeverage=15', () => {
    const result = selectLeverage(
      makeInput({ correlation: 0.90, absZScore: 3.0, spreadVolatility: 0.005 }),
      makeConfig({ maxLeverage: 15 }),
    );
    expect(result.leverage).toBe(15);
    expect(result.capped).toBe(true);
    expect(result.originalLeverage).toBe(23);
  });

  it('does not cap when tier selects 18 and maxLeverage=20', () => {
    const result = selectLeverage(
      makeInput({ correlation: 0.86, absZScore: 2.2 }),
      makeConfig({ maxLeverage: 20 }),
    );
    expect(result.leverage).toBe(18);
    expect(result.capped).toBe(false);
    expect(result.originalLeverage).toBe(18);
  });

  it('caps x5 to 3 when maxLeverage=3', () => {
    const result = selectLeverage(
      makeInput({ correlation: 0.80, absZScore: 1.5 }),
      makeConfig({ maxLeverage: 3 }),
    );
    expect(result.leverage).toBe(3);
    expect(result.capped).toBe(true);
    expect(result.originalLeverage).toBe(5);
  });

  // --- Waterfall behavior ---

  it('selects highest qualifying tier (waterfall)', () => {
    // This signal qualifies for ultra-high, high, moderate, and lower
    const result = selectLeverage(
      makeInput({ correlation: 0.90, absZScore: 3.0, spreadVolatility: 0.005 }),
      makeConfig(),
    );
    expect(result.tier).toBe('ultra-high');
    expect(result.leverage).toBe(23);
  });

  // --- Result includes metrics ---

  it('result includes all input metrics for auditability', () => {
    const input = makeInput({ correlation: 0.86, absZScore: 2.2, spreadVolatility: 0.012 });
    const result = selectLeverage(input, makeConfig());
    expect(result.metrics).toEqual(input);
  });

  // --- Custom tier config ---

  it('accepts custom tier thresholds via config override', () => {
    const customTiers = [
      { name: 'custom-high', leverage: 20, minCorrelation: 0.90, minAbsZScore: 2.0 },
      { name: 'custom-low', leverage: 3, minCorrelation: 0.70, minAbsZScore: 1.0 },
    ];
    const result = selectLeverage(
      makeInput({ correlation: 0.75, absZScore: 1.2 }),
      makeConfig({ tiers: customTiers }),
    );
    expect(result.leverage).toBe(3);
    expect(result.tier).toBe('custom-low');
  });

  it('uses configurable spread volatility threshold for ultra-high tier', () => {
    // With higher max spread vol, ultra-high tier should be selected
    const result = selectLeverage(
      makeInput({ correlation: 0.90, absZScore: 3.0, spreadVolatility: 0.04 }),
      makeConfig({ ultraHighMaxSpreadVol: 0.05 }),
    );
    expect(result.leverage).toBe(23);
    expect(result.tier).toBe('ultra-high');
  });
});
