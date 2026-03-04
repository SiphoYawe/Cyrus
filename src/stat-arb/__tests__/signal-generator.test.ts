import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Store } from '../../core/store.js';
import {
  SignalGenerator,
  SIGNAL_GENERATOR_DEFAULTS,
  DEFAULT_LEVERAGE_TABLE,
} from '../signal-generator.js';
import type { SignalGeneratorConfig, LeverageTableEntry } from '../signal-generator.js';
import type { HourlyPriceFeed } from '../hourly-price-feed.js';
import type { UniverseScanner, EligiblePair } from '../universe-scanner.js';
import type { StatArbSignal, StatArbExitSignal, StatArbPosition } from '../../core/store-slices/stat-arb-slice.js';

// --- Mock rollingZScore ---

const mockRollingZScore = vi.fn();

vi.mock('../math-library.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../math-library.js')>();
  return {
    ...original,
    rollingZScore: (...args: unknown[]) => mockRollingZScore(...args),
  };
});

// --- Helpers ---

function makeEligiblePair(overrides?: Partial<EligiblePair>): EligiblePair {
  return {
    tokenA: 'BTC',
    tokenB: 'ETH',
    key: 'BTC-ETH',
    correlation: 0.92,
    pValue: 0.01,
    halfLifeHours: 12,
    hedgeRatio: 16.5,
    intercept: 100,
    rSquared: 0.95,
    lastScanTimestamp: Date.now(),
    scanId: 'scan-1',
    ...overrides,
  };
}

function createMockUniverseScanner(eligiblePairs: EligiblePair[] = []): UniverseScanner {
  return {
    getEligiblePairs: vi.fn().mockReturnValue(eligiblePairs),
    isEligible: vi.fn().mockReturnValue(true),
  } as unknown as UniverseScanner;
}

function createMockPriceFeed(): HourlyPriceFeed {
  const prices = Array.from({ length: 100 }, (_, i) => 50000 + Math.sin(i / 10) * 100);
  return {
    getHourlyPrices: vi.fn().mockResolvedValue({
      pricesA: prices,
      pricesB: prices.map((p) => p / 16),
      timestamps: Array.from({ length: 100 }, (_, i) => Date.now() - i * 3_600_000),
      tokenA: 'BTC',
      tokenB: 'ETH',
      source: 'coingecko',
    }),
  } as unknown as HourlyPriceFeed;
}

function setupZScore(currentZ: number) {
  mockRollingZScore.mockReturnValue({
    zScores: [currentZ],
    spread: [0],
    rollingMean: [0],
    rollingStd: [1],
    currentZScore: currentZ,
  });
}

function createActivePosition(overrides?: Partial<StatArbPosition>): StatArbPosition {
  return {
    positionId: 'pos-1',
    pair: { tokenA: 'BTC', tokenB: 'ETH', key: 'BTC-ETH' },
    direction: 'short_pair',
    hedgeRatio: 16.5,
    leverage: 18,
    legA: {
      symbol: 'BTC',
      side: 'short',
      size: 1,
      entryPrice: 50000,
      currentPrice: 50000,
      unrealizedPnl: 0,
      funding: 0,
    },
    legB: {
      symbol: 'ETH',
      side: 'long',
      size: 16.5,
      entryPrice: 3000,
      currentPrice: 3000,
      unrealizedPnl: 0,
      funding: 0,
    },
    openTimestamp: Date.now() - 24 * 3_600_000, // 24h ago
    halfLifeHours: 12,
    combinedPnl: 0,
    accumulatedFunding: 0,
    marginUsed: 10000,
    status: 'active',
    signalSource: 'native',
    ...overrides,
  };
}

function createGenerator(
  overrides?: Partial<SignalGeneratorConfig>,
  eligiblePairs?: EligiblePair[],
  priceFeed?: HourlyPriceFeed,
): { generator: SignalGenerator; store: Store; scanner: UniverseScanner } {
  const store = Store.getInstance();
  const scanner = createMockUniverseScanner(eligiblePairs ?? [makeEligiblePair()]);
  const feed = priceFeed ?? createMockPriceFeed();
  const generator = new SignalGenerator(overrides ?? {}, scanner, feed, store);
  return { generator, store, scanner };
}

describe('Signal Generator', () => {
  beforeEach(() => {
    Store.getInstance().reset();
    vi.clearAllMocks();
  });

  // --- Entry signals ---

  describe('entry signal generation', () => {
    it('generates short_pair signal when Z >= +1.5 (AC2)', async () => {
      setupZScore(2.0);
      const { generator, store } = createGenerator();

      await generator.controlTask();

      const signals = store.getPendingSignals();
      expect(signals).toHaveLength(1);
      expect(signals[0].direction).toBe('short_pair');
      expect(signals[0].zScore).toBe(2.0);
    });

    it('generates long_pair signal when Z <= -1.5 (AC3)', async () => {
      setupZScore(-2.0);
      const { generator, store } = createGenerator();

      await generator.controlTask();

      const signals = store.getPendingSignals();
      expect(signals).toHaveLength(1);
      expect(signals[0].direction).toBe('long_pair');
      expect(signals[0].zScore).toBe(-2.0);
    });

    it('generates no signal when Z is between -1.5 and +1.5', async () => {
      setupZScore(0.5);
      const { generator, store } = createGenerator();

      await generator.controlTask();

      expect(store.getPendingSignals()).toHaveLength(0);
    });

    it('generates short_pair at Z = +1.5 boundary', async () => {
      setupZScore(1.5);
      const { generator, store } = createGenerator();

      await generator.controlTask();

      const signals = store.getPendingSignals();
      expect(signals).toHaveLength(1);
      expect(signals[0].direction).toBe('short_pair');
    });

    it('generates long_pair at Z = -1.5 boundary', async () => {
      setupZScore(-1.5);
      const { generator, store } = createGenerator();

      await generator.controlTask();

      const signals = store.getPendingSignals();
      expect(signals).toHaveLength(1);
      expect(signals[0].direction).toBe('long_pair');
    });

    it('skips entry signal when position already exists for pair (AC7)', async () => {
      setupZScore(2.0);
      const { generator, store } = createGenerator();

      // Open a position first
      store.openStatArbPosition(createActivePosition());

      await generator.controlTask();

      expect(store.getPendingSignals()).toHaveLength(0);
    });
  });

  // --- Signal structure ---

  describe('signal structure', () => {
    it('entry signal has all required fields (AC2)', async () => {
      setupZScore(2.0);
      const { generator, store } = createGenerator();

      await generator.controlTask();

      const signal = store.getPendingSignals()[0];
      expect(signal.signalId).toBeTruthy();
      expect(signal.pair.tokenA).toBe('BTC');
      expect(signal.pair.tokenB).toBe('ETH');
      expect(signal.pair.key).toBe('BTC-ETH');
      expect(signal.direction).toBe('short_pair');
      expect(signal.zScore).toBe(2.0);
      expect(signal.correlation).toBe(0.92);
      expect(signal.halfLifeHours).toBe(12);
      expect(signal.hedgeRatio).toBe(16.5);
      expect(signal.recommendedLeverage).toBeGreaterThan(0);
      expect(signal.source).toBe('native');
      expect(signal.timestamp).toBeGreaterThan(0);
      expect(signal.consumed).toBe(false);
      expect(signal.expiresAt).toBeGreaterThan(signal.timestamp);
    });

    it('signal source is native for all generator-produced signals', async () => {
      setupZScore(2.5);
      const { generator, store } = createGenerator();

      await generator.controlTask();

      expect(store.getPendingSignals()[0].source).toBe('native');
    });
  });

  // --- Duplicate signal prevention ---

  describe('duplicate signal prevention (AC7)', () => {
    it('updates existing signal rather than creating duplicate', async () => {
      setupZScore(2.0);
      const { generator, store } = createGenerator();

      await generator.controlTask();
      const firstSignal = store.getSignalByPairKey('BTC-ETH')!;
      const firstId = firstSignal.signalId;

      // Trigger again with different z-score
      setupZScore(2.5);
      await generator.controlTask();

      // Should still have 1 signal (updated)
      const allSignals = store.getPendingSignals();
      expect(allSignals).toHaveLength(1);
      // The signal was replaced — signalId stays the same (from the update logic)
      expect(allSignals[0].zScore).toBe(2.5);
    });
  });

  // --- Mean reversion exit ---

  describe('mean reversion exit (AC4)', () => {
    it('emits exit signal when |Z| <= 0.5', async () => {
      setupZScore(0.3);
      const { generator, store } = createGenerator({}, []);

      // Create position
      store.openStatArbPosition(createActivePosition());

      let exitSignal: StatArbExitSignal | null = null;
      store.emitter.on('stat_arb_exit_signal', (signal: StatArbExitSignal) => {
        exitSignal = signal;
      });

      await generator.controlTask();

      expect(exitSignal).not.toBeNull();
      expect(exitSignal!.reason).toBe('mean_reversion');
      expect(exitSignal!.positionId).toBe('pos-1');
    });

    it('emits exit signal at |Z| = 0.5 boundary', async () => {
      setupZScore(0.5);
      const { generator, store } = createGenerator({}, []);

      store.openStatArbPosition(createActivePosition());

      let exitSignal: StatArbExitSignal | null = null;
      store.emitter.on('stat_arb_exit_signal', (signal: StatArbExitSignal) => {
        exitSignal = signal;
      });

      await generator.controlTask();

      expect(exitSignal).not.toBeNull();
      expect(exitSignal!.reason).toBe('mean_reversion');
    });

    it('does NOT emit exit signal at |Z| = 0.6', async () => {
      setupZScore(0.6);
      const { generator, store } = createGenerator({}, []);

      store.openStatArbPosition(createActivePosition());

      let exitSignal: StatArbExitSignal | null = null;
      store.emitter.on('stat_arb_exit_signal', (signal: StatArbExitSignal) => {
        exitSignal = signal;
      });

      await generator.controlTask();

      expect(exitSignal).toBeNull();
    });
  });

  // --- Time stop exit ---

  describe('time stop exit (AC5)', () => {
    it('emits time_stop when position held >= 3x half-life', async () => {
      const halfLifeHours = 12;
      const openTimestamp = Date.now() - (3 * halfLifeHours + 1) * 3_600_000; // 37h ago

      const { generator, store } = createGenerator({}, []);
      store.openStatArbPosition(createActivePosition({ openTimestamp, halfLifeHours }));

      let exitSignal: StatArbExitSignal | null = null;
      store.emitter.on('stat_arb_exit_signal', (signal: StatArbExitSignal) => {
        exitSignal = signal;
      });

      await generator.controlTask();

      expect(exitSignal).not.toBeNull();
      expect(exitSignal!.reason).toBe('time_stop');
      expect(exitSignal!.elapsedHours).toBeGreaterThan(3 * halfLifeHours);
    });

    it('does NOT emit time_stop when position held < 3x half-life', async () => {
      const halfLifeHours = 12;
      const openTimestamp = Date.now() - 2.9 * halfLifeHours * 3_600_000; // 34.8h ago

      setupZScore(1.0); // Not triggering mean reversion either

      const { generator, store } = createGenerator({}, []);
      store.openStatArbPosition(createActivePosition({ openTimestamp, halfLifeHours }));

      let exitSignal: StatArbExitSignal | null = null;
      store.emitter.on('stat_arb_exit_signal', (signal: StatArbExitSignal) => {
        exitSignal = signal;
      });

      await generator.controlTask();

      expect(exitSignal).toBeNull();
    });
  });

  // --- Leverage recommendation ---

  describe('leverage recommendation (AC6)', () => {
    it('returns x23 for correlation=0.88, |Z|=2.6', () => {
      const { generator } = createGenerator();
      expect(generator.recommendLeverage(0.88, 2.6)).toBe(23);
    });

    it('returns x18 for correlation=0.86, |Z|=2.1', () => {
      const { generator } = createGenerator();
      expect(generator.recommendLeverage(0.86, 2.1)).toBe(18);
    });

    it('returns x9 for correlation=0.83, |Z|=1.8', () => {
      const { generator } = createGenerator();
      expect(generator.recommendLeverage(0.83, 1.8)).toBe(9);
    });

    it('returns x5 for correlation=0.80, |Z|=1.5', () => {
      const { generator } = createGenerator();
      // 0.80 is NOT > 0.80, so falls to default
      expect(generator.recommendLeverage(0.80, 1.5)).toBe(5);
    });

    it('returns x5 as default minimum', () => {
      const { generator } = createGenerator();
      expect(generator.recommendLeverage(0.81, 1.5)).toBe(5);
    });
  });

  // --- Event emission ---

  describe('event emission (AC8)', () => {
    it('emits stat_arb_signal event on new signal', async () => {
      setupZScore(2.0);
      const { generator, store } = createGenerator();

      let emittedSignal: StatArbSignal | null = null;
      store.emitter.on('stat_arb_signal', (signal: StatArbSignal) => {
        emittedSignal = signal;
      });

      await generator.controlTask();

      expect(emittedSignal).not.toBeNull();
      expect(emittedSignal!.direction).toBe('short_pair');
    });

    it('emits stat_arb_exit_signal event on exit signal', async () => {
      setupZScore(0.2);
      const { generator, store } = createGenerator({}, []);

      store.openStatArbPosition(createActivePosition());

      let exitSignal: StatArbExitSignal | null = null;
      store.emitter.on('stat_arb_exit_signal', (signal: StatArbExitSignal) => {
        exitSignal = signal;
      });

      await generator.controlTask();

      expect(exitSignal).not.toBeNull();
      expect(exitSignal!.reason).toBe('mean_reversion');
    });
  });

  // --- Ineligible pairs (AC9) ---

  describe('ineligible pairs (AC9)', () => {
    it('does not generate entry signal for removed pair', async () => {
      setupZScore(2.0);
      // Empty eligible pairs = pair was removed
      const { generator, store } = createGenerator({}, []);

      await generator.controlTask();

      expect(store.getPendingSignals()).toHaveLength(0);
    });

    it('still evaluates exit signals for open positions on removed pairs', async () => {
      setupZScore(0.3);
      // Pair removed from eligible list
      const { generator, store } = createGenerator({}, []);

      // But position is still active
      store.openStatArbPosition(createActivePosition());

      let exitSignal: StatArbExitSignal | null = null;
      store.emitter.on('stat_arb_exit_signal', (signal: StatArbExitSignal) => {
        exitSignal = signal;
      });

      await generator.controlTask();

      expect(exitSignal).not.toBeNull();
      expect(exitSignal!.reason).toBe('mean_reversion');
    });
  });

  // --- Signal expiry ---

  describe('signal expiry (AC7)', () => {
    it('prunes expired signals on tick', async () => {
      setupZScore(2.0);
      const { generator, store } = createGenerator({ signalExpiryMs: 1 }); // 1ms expiry

      // Generate signal
      await generator.controlTask();
      expect(store.getPendingSignals()).toHaveLength(1);

      // Wait for expiry
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Clear z-score to avoid regeneration
      setupZScore(0.5);
      await generator.controlTask();

      expect(store.getPendingSignals()).toHaveLength(0);
    });

    it('does not prune signal before expiry', async () => {
      setupZScore(2.0);
      const { generator, store } = createGenerator({ signalExpiryMs: 60_000 }); // 60s

      await generator.controlTask();

      // Run again immediately — signal should still be there (updated, not pruned)
      setupZScore(0.5); // No new signal
      await generator.controlTask();

      // Signal still in store (not expired yet)
      const signal = store.getSignalByPairKey('BTC-ETH');
      expect(signal).toBeDefined();
    });
  });

  // --- Error handling ---

  describe('error handling', () => {
    it('handles individual pair evaluation failure gracefully', async () => {
      const priceFeed = {
        getHourlyPrices: vi.fn()
          .mockRejectedValueOnce(new Error('Network error'))
          .mockResolvedValueOnce({
            pricesA: Array.from({ length: 100 }, (_, i) => 50000 + i),
            pricesB: Array.from({ length: 100 }, (_, i) => 3000 + i),
            timestamps: Array.from({ length: 100 }, (_, i) => Date.now() - i * 3_600_000),
            tokenA: 'SOL',
            tokenB: 'AVAX',
            source: 'coingecko',
          }),
      } as unknown as HourlyPriceFeed;

      setupZScore(2.0);

      const pair1 = makeEligiblePair({ tokenA: 'BTC', tokenB: 'ETH', key: 'BTC-ETH' });
      const pair2 = makeEligiblePair({ tokenA: 'AVAX', tokenB: 'SOL', key: 'AVAX-SOL' });

      const { generator, store } = createGenerator({}, [pair1, pair2], priceFeed);

      await generator.controlTask();

      // Should have signal for the pair that didn't error
      const signals = store.getPendingSignals();
      expect(signals).toHaveLength(1);
      expect(signals[0].pair.key).toBe('AVAX-SOL');
    });
  });

  // --- controlTask ---

  describe('controlTask', () => {
    it('calls pruneExpiredSignals, evaluateAllPairs, and evaluateOpenPositions', async () => {
      setupZScore(2.0);
      const { generator, store } = createGenerator();

      // Add an expired signal manually
      const expiredSignal: StatArbSignal = {
        signalId: 'expired-1',
        pair: { tokenA: 'SOL', tokenB: 'AVAX', key: 'AVAX-SOL' },
        direction: 'short_pair',
        zScore: 2.0,
        correlation: 0.90,
        halfLifeHours: 10,
        hedgeRatio: 5,
        recommendedLeverage: 18,
        source: 'native',
        timestamp: Date.now() - 7_200_000,
        consumed: false,
        expiresAt: Date.now() - 1000, // Already expired
      };
      store.addStatArbSignal(expiredSignal);

      await generator.controlTask();

      // Expired signal should be pruned
      expect(store.getSignalByPairKey('AVAX-SOL')).toBeUndefined();
      // New signal should exist
      expect(store.getSignalByPairKey('BTC-ETH')).toBeDefined();
    });
  });

  // --- Constructor defaults ---

  describe('constructor', () => {
    it('uses default config values', () => {
      const { generator } = createGenerator();
      const config = generator.getConfig();
      expect(config.tickIntervalMs).toBe(SIGNAL_GENERATOR_DEFAULTS.TICK_INTERVAL_MS);
      expect(config.entryThreshold).toBe(SIGNAL_GENERATOR_DEFAULTS.ENTRY_THRESHOLD);
      expect(config.exitThreshold).toBe(SIGNAL_GENERATOR_DEFAULTS.EXIT_THRESHOLD);
      expect(config.timeStopMultiplier).toBe(SIGNAL_GENERATOR_DEFAULTS.TIME_STOP_MULTIPLIER);
      expect(config.zScoreWindow).toBe(SIGNAL_GENERATOR_DEFAULTS.Z_SCORE_WINDOW);
      expect(config.signalExpiryMs).toBe(SIGNAL_GENERATOR_DEFAULTS.SIGNAL_EXPIRY_MS);
    });

    it('accepts custom config values', () => {
      const { generator } = createGenerator({
        tickIntervalMs: 5000,
        entryThreshold: 2.0,
        exitThreshold: 0.3,
        timeStopMultiplier: 4,
        zScoreWindow: 48,
        signalExpiryMs: 120_000,
      });
      const config = generator.getConfig();
      expect(config.entryThreshold).toBe(2.0);
      expect(config.exitThreshold).toBe(0.3);
      expect(config.timeStopMultiplier).toBe(4);
      expect(config.zScoreWindow).toBe(48);
    });
  });
});
