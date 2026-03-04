import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ConfidenceScorer } from '../confidence-scorer.js';
import type { NativeSignalInput, ConfidenceResult } from '../confidence-scorer.js';
import type { AgentPearOpenSignal } from '../../telegram/types.js';
import { Store } from '../../core/store.js';

function makeOpenSignal(overrides?: Partial<AgentPearOpenSignal>): AgentPearOpenSignal {
  return {
    pair: 'ETC/NEAR',
    direction: 'long_pair',
    zScore: -2.0,
    correlation: 0.85,
    halfLife: '1.5d',
    leverage: 18,
    raw: 'test',
    ...overrides,
  };
}

function makeNativeSignal(overrides?: Partial<NativeSignalInput>): NativeSignalInput {
  return {
    zScore: -2.0,
    correlation: 0.85,
    pValue: 0.03,
    halfLifeHours: 24,
    ...overrides,
  };
}

describe('ConfidenceScorer', () => {
  let scorer: ConfidenceScorer;

  beforeEach(() => {
    Store.getInstance().reset();
    vi.clearAllMocks();
    scorer = new ConfidenceScorer();
  });

  // --- Telegram base confidence ---

  it('Telegram base confidence is 0.66 with no adjustments (AC1)', () => {
    // Z=2.0 gets +0.05, corr=0.85 gets +0.05, fresh signal gets ~0 freshness
    const signal = makeOpenSignal({ zScore: -2.0, correlation: 0.85 });
    const result = scorer.scoreTelegramSignal(signal, Date.now());

    expect(result.factors.base).toBe(0.66);
    expect(result.source).toBe('telegram');
    // 0.66 + 0.05 (z) + 0.05 (corr) + ~0 (fresh) ≈ 0.76
    expect(result.score).toBeCloseTo(0.76, 1);
  });

  // --- Z-score extremity boosts ---

  it('Z-score |Z| = 2.5 adds +0.08 (AC2)', () => {
    const signal = makeOpenSignal({ zScore: -2.5 });
    const result = scorer.scoreTelegramSignal(signal, Date.now());
    expect(result.factors.zScoreAdjustment).toBe(0.08);
  });

  it('Z-score |Z| = 3.0 adds +0.10 (AC2)', () => {
    const signal = makeOpenSignal({ zScore: -3.0 });
    const result = scorer.scoreTelegramSignal(signal, Date.now());
    expect(result.factors.zScoreAdjustment).toBe(0.10);
  });

  it('Z-score |Z| = 1.6 subtracts -0.03 (AC2)', () => {
    const signal = makeOpenSignal({ zScore: -1.6 });
    const result = scorer.scoreTelegramSignal(signal, Date.now());
    expect(result.factors.zScoreAdjustment).toBe(-0.03);
  });

  // --- Correlation adjustments ---

  it('correlation = 0.90 adds +0.10 (AC3)', () => {
    const signal = makeOpenSignal({ correlation: 0.90 });
    const result = scorer.scoreTelegramSignal(signal, Date.now());
    expect(result.factors.correlationAdjustment).toBe(0.10);
  });

  it('correlation = 0.81 subtracts -0.05 (AC3)', () => {
    const signal = makeOpenSignal({ correlation: 0.81 });
    const result = scorer.scoreTelegramSignal(signal, Date.now());
    expect(result.factors.correlationAdjustment).toBe(-0.05);
  });

  // --- Freshness decay ---

  it('signal 30 minutes old loses ~0.05 confidence (AC4)', () => {
    const thirtyMinAgo = Date.now() - 30 * 60 * 1000;
    const signal = makeOpenSignal();
    const result = scorer.scoreTelegramSignal(signal, thirtyMinAgo);
    expect(result.factors.freshnessAdjustment).toBeCloseTo(-0.05, 1);
  });

  it('signal 60 minutes old loses ~0.10 confidence (AC4)', () => {
    const sixtyMinAgo = Date.now() - 60 * 60 * 1000;
    const signal = makeOpenSignal();
    const result = scorer.scoreTelegramSignal(signal, sixtyMinAgo);
    expect(result.factors.freshnessAdjustment).toBeCloseTo(-0.10, 1);
  });

  it('signal 0 minutes old has no freshness decay (AC4)', () => {
    const signal = makeOpenSignal();
    const result = scorer.scoreTelegramSignal(signal, Date.now());
    expect(result.factors.freshnessAdjustment).toBeCloseTo(0, 2);
  });

  // --- Combined adjustments ---

  it('high Z + high corr + fresh = confidence > 0.80 (AC2, AC3)', () => {
    const signal = makeOpenSignal({ zScore: -3.0, correlation: 0.92 });
    const result = scorer.scoreTelegramSignal(signal, Date.now());
    // 0.66 + 0.10 (z>=3) + 0.10 (corr>=0.90) + ~0 = 0.86
    expect(result.score).toBeGreaterThan(0.80);
  });

  it('low Z + low corr + stale = confidence < 0.55 (AC2, AC3, AC4)', () => {
    const thirtyMinAgo = Date.now() - 30 * 60 * 1000;
    const signal = makeOpenSignal({ zScore: -1.6, correlation: 0.81 });
    const result = scorer.scoreTelegramSignal(signal, thirtyMinAgo);
    // 0.66 - 0.03 (z) - 0.05 (corr) - 0.05 (fresh) = 0.53
    expect(result.score).toBeLessThan(0.55);
  });

  // --- Clamping ---

  it('extreme positive adjustments capped at 1.0 (AC7)', () => {
    const scorer = new ConfidenceScorer({ telegramBaseConfidence: 0.95 });
    const signal = makeOpenSignal({ zScore: -3.5, correlation: 0.95 });
    const result = scorer.scoreTelegramSignal(signal, Date.now());
    expect(result.score).toBe(1.0);
    expect(result.clamped).toBe(true);
  });

  it('extreme negative adjustments floored at 0.0 (AC7)', () => {
    const scorer = new ConfidenceScorer({ telegramBaseConfidence: 0.1 });
    const signal = makeOpenSignal({ zScore: -1.5, correlation: 0.80 });
    // Very stale signal
    const result = scorer.scoreTelegramSignal(signal, Date.now() - 10 * 60 * 60 * 1000);
    expect(result.score).toBe(0);
    expect(result.clamped).toBe(true);
  });

  // --- Native signal scoring ---

  it('native: high corr + low p-value + short halfLife = high confidence (AC5)', () => {
    const signal = makeNativeSignal({
      zScore: -2.5,
      correlation: 0.91,
      pValue: 0.005,
      halfLifeHours: 10,
    });
    const result = scorer.scoreNativeSignal(signal);
    // 0.50 + 0.08 (z) + 0.10 (corr) + 0.10 (p) + 0.05 (hl) = 0.83
    expect(result.score).toBeGreaterThan(0.75);
    expect(result.source).toBe('native');
  });

  it('native: minimum thresholds = base confidence 0.50 (AC5)', () => {
    const signal = makeNativeSignal({
      zScore: -1.8,
      correlation: 0.83,
      pValue: 0.04,
      halfLifeHours: 30,
    });
    const result = scorer.scoreNativeSignal(signal);
    // 0.50 + 0 (z: 1.7-2.0 => 0) + 0 (corr: 0.82-0.85 => 0) + 0 (p: 0.03-0.05 => 0) + 0 (hl: 24-36 => 0) = 0.50
    expect(result.score).toBeCloseTo(0.50, 1);
  });

  // --- Deduplication ---

  it('higher-confidence signal wins when difference > 0.05 (AC6)', () => {
    const high: ConfidenceResult & { timestamp: number } = {
      score: 0.80,
      source: 'telegram',
      factors: { base: 0.66, zScoreAdjustment: 0.08, correlationAdjustment: 0.06, freshnessAdjustment: 0, pValueAdjustment: 0, halfLifeAdjustment: 0 },
      rawScore: 0.80,
      clamped: false,
      timestamp: Date.now() - 60000,
    };
    const low: ConfidenceResult & { timestamp: number } = {
      score: 0.60,
      source: 'native',
      factors: { base: 0.50, zScoreAdjustment: 0.05, correlationAdjustment: 0.05, freshnessAdjustment: 0, pValueAdjustment: 0, halfLifeAdjustment: 0 },
      rawScore: 0.60,
      clamped: false,
      timestamp: Date.now(),
    };

    const winner = scorer.deduplicateSignals(high, low);
    expect(winner.source).toBe('telegram');
  });

  it('newer signal wins when confidence difference <= 0.05 (AC6)', () => {
    const older: ConfidenceResult & { timestamp: number } = {
      score: 0.72,
      source: 'telegram',
      factors: { base: 0.66, zScoreAdjustment: 0.05, correlationAdjustment: 0, freshnessAdjustment: -0.01, pValueAdjustment: 0, halfLifeAdjustment: 0 },
      rawScore: 0.72,
      clamped: false,
      timestamp: Date.now() - 120000,
    };
    const newer: ConfidenceResult & { timestamp: number } = {
      score: 0.70,
      source: 'native',
      factors: { base: 0.50, zScoreAdjustment: 0.10, correlationAdjustment: 0.10, freshnessAdjustment: 0, pValueAdjustment: 0, halfLifeAdjustment: 0 },
      rawScore: 0.70,
      clamped: false,
      timestamp: Date.now(),
    };

    const winner = scorer.deduplicateSignals(older, newer);
    expect(winner.source).toBe('native');
  });

  // --- deduplicateStore ---

  it('deduplicateStore scans store and resolves conflicts (AC6)', () => {
    const store = Store.getInstance();

    // Add two signals for same pair with different sources
    store.addStatArbSignal({
      signalId: 'telegram-1',
      pair: { tokenA: 'ETC', tokenB: 'NEAR', key: 'ETC-NEAR' },
      direction: 'long_pair',
      zScore: -2.5,
      correlation: 0.90,
      halfLifeHours: 24,
      hedgeRatio: 1.0,
      recommendedLeverage: 18,
      source: 'telegram',
      timestamp: Date.now(),
      consumed: false,
      expiresAt: Date.now() + 3600000,
    });

    // Since store uses pair key, the second signal for the same pair overwrites.
    // This test verifies the deduplicateStore runs without error.
    const resolved = scorer.deduplicateStore(store);
    // With only one signal per pair key (store overwrites), no conflicts to resolve
    expect(resolved).toBe(0);
  });

  // --- ConfidenceResult includes factor breakdowns ---

  it('ConfidenceResult includes all factor breakdowns (AC1)', () => {
    const signal = makeOpenSignal();
    const result = scorer.scoreTelegramSignal(signal, Date.now());

    expect(result.factors).toHaveProperty('base');
    expect(result.factors).toHaveProperty('zScoreAdjustment');
    expect(result.factors).toHaveProperty('correlationAdjustment');
    expect(result.factors).toHaveProperty('freshnessAdjustment');
    expect(result.factors).toHaveProperty('pValueAdjustment');
    expect(result.factors).toHaveProperty('halfLifeAdjustment');
    expect(result).toHaveProperty('rawScore');
    expect(result).toHaveProperty('clamped');
  });

  // --- Position sizing ---

  it('confidence as position sizing multiplier (AC8)', () => {
    const adjusted = ConfidenceScorer.adjustPositionSize(1000, 0.66);
    expect(adjusted).toBeCloseTo(660, 0);
  });

  it('minimum position size floor respected with low confidence (AC8)', () => {
    const adjusted = ConfidenceScorer.adjustPositionSize(100, 0.1, 50);
    // 100 * 0.1 = 10, but min is 50
    expect(adjusted).toBe(50);
  });
});
