import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Store } from '../../core/store.js';
import {
  UniverseScanner,
  generatePairCandidates,
  UNIVERSE_SCANNER_DEFAULTS,
} from '../universe-scanner.js';
import type { EligiblePair, ScanResult } from '../universe-scanner.js';
import type { HourlyPriceFeed } from '../hourly-price-feed.js';
import { STAT_ARB_MATH_CONSTANTS } from '../math-library.js';

// --- Mock math library ---

const mockPearsonCorrelation = vi.fn();
const mockEngleGrangerTest = vi.fn();
const mockOuHalfLife = vi.fn();
const mockOlsHedgeRatio = vi.fn();

vi.mock('../math-library.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../math-library.js')>();
  return {
    ...original,
    pearsonCorrelation: (...args: unknown[]) => mockPearsonCorrelation(...args),
    engleGrangerTest: (...args: unknown[]) => mockEngleGrangerTest(...args),
    ouHalfLife: (...args: unknown[]) => mockOuHalfLife(...args),
    olsHedgeRatio: (...args: unknown[]) => mockOlsHedgeRatio(...args),
  };
});

// --- Helpers ---

function generatePrices(n: number, base: number): number[] {
  const prices: number[] = [];
  for (let i = 0; i < n; i++) {
    prices.push(base + Math.sin(i / 10) * 50);
  }
  return prices;
}

function createMockPriceFeed(
  overrides?: Partial<{
    getHourlyPrices: HourlyPriceFeed['getHourlyPrices'];
  }>,
): HourlyPriceFeed {
  const defaultLookback = STAT_ARB_MATH_CONSTANTS.DEFAULT_LOOKBACK;
  return {
    getHourlyPrices: overrides?.getHourlyPrices ?? vi.fn().mockResolvedValue({
      pricesA: generatePrices(defaultLookback + 10, 50000),
      pricesB: generatePrices(defaultLookback + 10, 3000),
      timestamps: Array.from({ length: defaultLookback + 10 }, (_, i) => Date.now() - i * 3_600_000),
      tokenA: 'BTC',
      tokenB: 'ETH',
      source: 'coingecko',
    }),
  } as unknown as HourlyPriceFeed;
}

function setupPassingGates() {
  mockPearsonCorrelation.mockReturnValue({ correlation: 0.92, pValue: 0.001, n: 168 });
  mockEngleGrangerTest.mockReturnValue({
    cointegrated: true,
    pValue: 0.01,
    adfStatistic: -4.5,
    criticalValues: { '1%': -3.96, '5%': -3.41, '10%': -3.13 },
    residuals: new Array(168).fill(0),
  });
  mockOuHalfLife.mockReturnValue({ halfLifeHours: 12, theta: 0.06, mu: 0, sigma: 0.5, isStationary: true });
  mockOlsHedgeRatio.mockReturnValue({ slope: 16.5, intercept: 100, rSquared: 0.95, residuals: [] });
}

function setupFailingCorrelation() {
  mockPearsonCorrelation.mockReturnValue({ correlation: 0.50, pValue: 0.2, n: 168 });
}

function setupFailingCointegration() {
  mockPearsonCorrelation.mockReturnValue({ correlation: 0.92, pValue: 0.001, n: 168 });
  mockEngleGrangerTest.mockReturnValue({
    cointegrated: false,
    pValue: 0.15,
    adfStatistic: -2.0,
    criticalValues: { '1%': -3.96, '5%': -3.41, '10%': -3.13 },
    residuals: [],
  });
}

function setupFailingHalfLife() {
  mockPearsonCorrelation.mockReturnValue({ correlation: 0.92, pValue: 0.001, n: 168 });
  mockEngleGrangerTest.mockReturnValue({
    cointegrated: true,
    pValue: 0.01,
    adfStatistic: -4.5,
    criticalValues: { '1%': -3.96, '5%': -3.41, '10%': -3.13 },
    residuals: new Array(168).fill(0),
  });
  mockOuHalfLife.mockReturnValue({ halfLifeHours: 96, theta: 0.007, mu: 0, sigma: 0.5, isStationary: true });
}

describe('Universe Scanner', () => {
  beforeEach(() => {
    Store.getInstance().reset();
    vi.clearAllMocks();
  });

  // --- generatePairCandidates ---

  describe('generatePairCandidates', () => {
    it('generates N*(N-1)/2 unique pairs from N tokens', () => {
      const tokens = ['BTC', 'ETH', 'SOL', 'AVAX'];
      const candidates = generatePairCandidates(tokens);
      expect(candidates).toHaveLength(6); // 4 choose 2 = 6
    });

    it('sorts tokens alphabetically for canonical ordering', () => {
      const candidates = generatePairCandidates(['ETH', 'BTC']);
      expect(candidates[0].tokenA).toBe('BTC');
      expect(candidates[0].tokenB).toBe('ETH');
    });

    it('returns empty array for 0 or 1 tokens', () => {
      expect(generatePairCandidates([])).toHaveLength(0);
      expect(generatePairCandidates(['BTC'])).toHaveLength(0);
    });

    it('generates correct keys using createPairKey', () => {
      const candidates = generatePairCandidates(['SOL', 'BTC']);
      expect(candidates[0].key).toBe('BTC-SOL');
    });

    it('handles large token sets correctly', () => {
      const tokens = Array.from({ length: 10 }, (_, i) => `TOKEN${i}`);
      const candidates = generatePairCandidates(tokens);
      expect(candidates).toHaveLength(45); // 10 choose 2 = 45
    });

    it('produces no duplicate keys', () => {
      const tokens = ['BTC', 'ETH', 'SOL', 'AVAX', 'LINK'];
      const candidates = generatePairCandidates(tokens);
      const keys = candidates.map((c) => c.key);
      expect(new Set(keys).size).toBe(keys.length);
    });
  });

  // --- UniverseScanner constructor ---

  describe('constructor', () => {
    it('uses default config values when not provided', () => {
      const scanner = new UniverseScanner(
        { tokens: ['BTC', 'ETH'] },
        createMockPriceFeed(),
      );
      expect(scanner).toBeDefined();
      // Defaults are internal — verify via scan behavior
    });

    it('accepts custom config values', () => {
      const scanner = new UniverseScanner(
        {
          tokens: ['BTC', 'ETH'],
          scanIntervalMs: 1000,
          lookbackHours: 72,
          correlationThreshold: 0.90,
          cointegrationPThreshold: 0.01,
          halfLifeMaxHours: 24,
          maxConcurrentPairEvaluations: 5,
        },
        createMockPriceFeed(),
      );
      expect(scanner).toBeDefined();
    });
  });

  // --- Three-gate eligibility filter ---

  describe('eligibility gates', () => {
    it('marks pair eligible when all three gates pass', async () => {
      setupPassingGates();

      const scanner = new UniverseScanner(
        { tokens: ['BTC', 'ETH'] },
        createMockPriceFeed(),
      );

      const result = await scanner.scanUniverse();
      expect(result.eligibleCount).toBe(1);
      expect(result.eligiblePairs).toHaveLength(1);
      expect(result.eligiblePairs[0].tokenA).toBe('BTC');
      expect(result.eligiblePairs[0].tokenB).toBe('ETH');
    });

    it('rejects pair when correlation is below threshold', async () => {
      setupFailingCorrelation();

      const scanner = new UniverseScanner(
        { tokens: ['BTC', 'ETH'] },
        createMockPriceFeed(),
      );

      const result = await scanner.scanUniverse();
      expect(result.eligibleCount).toBe(0);
      // Cointegration should not even be called
      expect(mockEngleGrangerTest).not.toHaveBeenCalled();
    });

    it('rejects pair when cointegration fails', async () => {
      setupFailingCointegration();

      const scanner = new UniverseScanner(
        { tokens: ['BTC', 'ETH'] },
        createMockPriceFeed(),
      );

      const result = await scanner.scanUniverse();
      expect(result.eligibleCount).toBe(0);
      // Half-life should not be called
      expect(mockOuHalfLife).not.toHaveBeenCalled();
    });

    it('rejects pair when half-life exceeds maximum', async () => {
      setupFailingHalfLife();

      const scanner = new UniverseScanner(
        { tokens: ['BTC', 'ETH'] },
        createMockPriceFeed(),
      );

      const result = await scanner.scanUniverse();
      expect(result.eligibleCount).toBe(0);
      // olsHedgeRatio should not be called for rejected pairs
      expect(mockOlsHedgeRatio).not.toHaveBeenCalled();
    });

    it('rejects pair when half-life is not stationary', async () => {
      mockPearsonCorrelation.mockReturnValue({ correlation: 0.92, pValue: 0.001, n: 168 });
      mockEngleGrangerTest.mockReturnValue({
        cointegrated: true,
        pValue: 0.01,
        adfStatistic: -4.5,
        criticalValues: { '1%': -3.96, '5%': -3.41, '10%': -3.13 },
        residuals: new Array(168).fill(0),
      });
      mockOuHalfLife.mockReturnValue({ halfLifeHours: 10, theta: -0.01, mu: 0, sigma: 0.5, isStationary: false });

      const scanner = new UniverseScanner(
        { tokens: ['BTC', 'ETH'] },
        createMockPriceFeed(),
      );

      const result = await scanner.scanUniverse();
      expect(result.eligibleCount).toBe(0);
    });

    it('respects custom correlation threshold', async () => {
      mockPearsonCorrelation.mockReturnValue({ correlation: 0.85, pValue: 0.001, n: 168 });

      const scannerStrict = new UniverseScanner(
        { tokens: ['BTC', 'ETH'], correlationThreshold: 0.90 },
        createMockPriceFeed(),
      );

      const resultStrict = await scannerStrict.scanUniverse();
      expect(resultStrict.eligibleCount).toBe(0);
    });

    it('respects custom half-life max', async () => {
      setupPassingGates();
      mockOuHalfLife.mockReturnValue({ halfLifeHours: 30, theta: 0.02, mu: 0, sigma: 0.5, isStationary: true });

      const scanner = new UniverseScanner(
        { tokens: ['BTC', 'ETH'], halfLifeMaxHours: 24 },
        createMockPriceFeed(),
      );

      const result = await scanner.scanUniverse();
      expect(result.eligibleCount).toBe(0);
    });
  });

  // --- Eligible pair structure ---

  describe('eligible pair entry', () => {
    it('contains all required fields', async () => {
      setupPassingGates();

      const scanner = new UniverseScanner(
        { tokens: ['BTC', 'ETH'] },
        createMockPriceFeed(),
      );

      const result = await scanner.scanUniverse();
      const pair = result.eligiblePairs[0];

      expect(pair.tokenA).toBe('BTC');
      expect(pair.tokenB).toBe('ETH');
      expect(pair.key).toBe('BTC-ETH');
      expect(pair.correlation).toBe(0.92);
      expect(pair.pValue).toBe(0.01);
      expect(pair.halfLifeHours).toBe(12);
      expect(pair.hedgeRatio).toBe(16.5);
      expect(pair.intercept).toBe(100);
      expect(pair.rSquared).toBe(0.95);
      expect(pair.lastScanTimestamp).toBeGreaterThan(0);
      expect(pair.scanId).toBeTruthy();
    });
  });

  // --- Scan result structure ---

  describe('scan result', () => {
    it('contains correct metadata', async () => {
      setupPassingGates();

      const scanner = new UniverseScanner(
        { tokens: ['BTC', 'ETH', 'SOL'] },
        createMockPriceFeed(),
      );

      const result = await scanner.scanUniverse();
      expect(result.scanId).toBeTruthy();
      expect(result.timestamp).toBeGreaterThan(0);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.totalPairsScanned).toBe(3); // 3 choose 2
      expect(result.eligibleCount).toBe(3);
      expect(result.errors).toHaveLength(0);
    });

    it('tracks newly added pairs on first scan', async () => {
      setupPassingGates();

      const scanner = new UniverseScanner(
        { tokens: ['BTC', 'ETH'] },
        createMockPriceFeed(),
      );

      const result = await scanner.scanUniverse();
      expect(result.newlyAdded).toContain('BTC-ETH');
      expect(result.removed).toHaveLength(0);
    });
  });

  // --- Addition/removal tracking ---

  describe('scan-to-scan tracking', () => {
    it('detects removed pairs between scans', async () => {
      // First scan: all pass
      setupPassingGates();

      const scanner = new UniverseScanner(
        { tokens: ['BTC', 'ETH'] },
        createMockPriceFeed(),
      );

      await scanner.scanUniverse();

      // Second scan: fail correlation
      setupFailingCorrelation();
      const result2 = await scanner.scanUniverse();

      expect(result2.removed).toContain('BTC-ETH');
      expect(result2.eligibleCount).toBe(0);
    });

    it('detects newly added pairs on rescan', async () => {
      // First scan: fail
      setupFailingCorrelation();

      const scanner = new UniverseScanner(
        { tokens: ['BTC', 'ETH'] },
        createMockPriceFeed(),
      );

      await scanner.scanUniverse();

      // Second scan: pass
      setupPassingGates();
      const result2 = await scanner.scanUniverse();

      expect(result2.newlyAdded).toContain('BTC-ETH');
    });

    it('does not report unchanged pairs as added or removed', async () => {
      setupPassingGates();

      const scanner = new UniverseScanner(
        { tokens: ['BTC', 'ETH'] },
        createMockPriceFeed(),
      );

      await scanner.scanUniverse();
      const result2 = await scanner.scanUniverse();

      expect(result2.newlyAdded).toHaveLength(0);
      expect(result2.removed).toHaveLength(0);
      expect(result2.eligibleCount).toBe(1);
    });
  });

  // --- Insufficient data ---

  describe('insufficient data handling', () => {
    it('skips pair with insufficient price data without error', async () => {
      const shortPrices = generatePrices(10, 50000); // Less than DEFAULT_LOOKBACK

      const priceFeed = createMockPriceFeed({
        getHourlyPrices: vi.fn().mockResolvedValue({
          pricesA: shortPrices,
          pricesB: shortPrices,
          timestamps: Array.from({ length: 10 }, (_, i) => Date.now() - i * 3_600_000),
          tokenA: 'BTC',
          tokenB: 'ETH',
          source: 'coingecko',
        }),
      });

      const scanner = new UniverseScanner(
        { tokens: ['BTC', 'ETH'] },
        priceFeed,
      );

      const result = await scanner.scanUniverse();
      expect(result.eligibleCount).toBe(0);
      expect(result.errors).toHaveLength(0); // Not an error, just skipped
    });
  });

  // --- Error handling ---

  describe('error handling', () => {
    it('captures price feed errors without failing scan', async () => {
      const priceFeed = createMockPriceFeed({
        getHourlyPrices: vi.fn().mockRejectedValue(new Error('PriceFeed: rate limited')),
      });

      const scanner = new UniverseScanner(
        { tokens: ['BTC', 'ETH'] },
        priceFeed,
      );

      const result = await scanner.scanUniverse();
      expect(result.eligibleCount).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].phase).toBe('price_fetch');
      expect(result.errors[0].error).toContain('PriceFeed');
    });

    it('classifies correlation errors correctly', async () => {
      const priceFeed = createMockPriceFeed({
        getHourlyPrices: vi.fn().mockRejectedValue(new Error('pearsonCorrelation: invalid input')),
      });

      const scanner = new UniverseScanner(
        { tokens: ['BTC', 'ETH'] },
        priceFeed,
      );

      const result = await scanner.scanUniverse();
      expect(result.errors[0].phase).toBe('correlation');
    });

    it('classifies cointegration errors correctly', async () => {
      const priceFeed = createMockPriceFeed({
        getHourlyPrices: vi.fn().mockRejectedValue(new Error('engleGranger: computation failed')),
      });

      const scanner = new UniverseScanner(
        { tokens: ['BTC', 'ETH'] },
        priceFeed,
      );

      const result = await scanner.scanUniverse();
      expect(result.errors[0].phase).toBe('cointegration');
    });

    it('defaults to half_life phase for unknown errors', async () => {
      const priceFeed = createMockPriceFeed({
        getHourlyPrices: vi.fn().mockRejectedValue(new Error('something unexpected')),
      });

      const scanner = new UniverseScanner(
        { tokens: ['BTC', 'ETH'] },
        priceFeed,
      );

      const result = await scanner.scanUniverse();
      expect(result.errors[0].phase).toBe('half_life');
    });

    it('continues scanning remaining pairs after one pair errors', async () => {
      let callCount = 0;
      const defaultLookback = STAT_ARB_MATH_CONSTANTS.DEFAULT_LOOKBACK;

      const priceFeed = createMockPriceFeed({
        getHourlyPrices: vi.fn().mockImplementation(async (tokenA: string, tokenB: string) => {
          callCount++;
          if (tokenA === 'AVAX' || tokenB === 'AVAX') {
            throw new Error('PriceFeed: token not supported');
          }
          return {
            pricesA: generatePrices(defaultLookback + 10, 50000),
            pricesB: generatePrices(defaultLookback + 10, 3000),
            timestamps: Array.from({ length: defaultLookback + 10 }, (_, i) => Date.now() - i * 3_600_000),
            tokenA,
            tokenB,
            source: 'coingecko' as const,
          };
        }),
      });

      setupPassingGates();

      const scanner = new UniverseScanner(
        { tokens: ['AVAX', 'BTC', 'ETH'] },
        priceFeed,
      );

      const result = await scanner.scanUniverse();
      // 3 pairs total: AVAX::BTC (error), AVAX::ETH (error), BTC-ETH (passes)
      expect(result.totalPairsScanned).toBe(3);
      expect(result.errors.length).toBeGreaterThanOrEqual(2);
      expect(result.eligibleCount).toBe(1);
    });
  });

  // --- Batch processing ---

  describe('batch processing', () => {
    it('processes pairs in batches of configured size', async () => {
      setupPassingGates();

      const getHourlyPricesMock = vi.fn().mockImplementation(async (tokenA: string, tokenB: string) => {
        const defaultLookback = STAT_ARB_MATH_CONSTANTS.DEFAULT_LOOKBACK;
        return {
          pricesA: generatePrices(defaultLookback + 10, 50000),
          pricesB: generatePrices(defaultLookback + 10, 3000),
          timestamps: Array.from({ length: defaultLookback + 10 }, (_, i) => Date.now() - i * 3_600_000),
          tokenA,
          tokenB,
          source: 'coingecko' as const,
        };
      });

      const priceFeed = createMockPriceFeed({
        getHourlyPrices: getHourlyPricesMock,
      });

      // 5 tokens = 10 pairs, batch size 3
      const scanner = new UniverseScanner(
        {
          tokens: ['A', 'B', 'C', 'D', 'E'],
          maxConcurrentPairEvaluations: 3,
        },
        priceFeed,
      );

      const result = await scanner.scanUniverse();
      expect(result.totalPairsScanned).toBe(10);
      expect(getHourlyPricesMock).toHaveBeenCalledTimes(10);
    });
  });

  // --- Scan history ---

  describe('scan history', () => {
    it('stores scan results in history', async () => {
      setupPassingGates();

      const scanner = new UniverseScanner(
        { tokens: ['BTC', 'ETH'] },
        createMockPriceFeed(),
      );

      await scanner.scanUniverse();
      await scanner.scanUniverse();

      const history = scanner.getScanHistory();
      expect(history).toHaveLength(2);
      expect(history[0].scanId).not.toBe(history[1].scanId);
    });

    it('caps history at MAX_SCAN_HISTORY entries', async () => {
      setupPassingGates();

      const scanner = new UniverseScanner(
        { tokens: ['BTC', 'ETH'] },
        createMockPriceFeed(),
      );

      for (let i = 0; i < UNIVERSE_SCANNER_DEFAULTS.MAX_SCAN_HISTORY + 5; i++) {
        await scanner.scanUniverse();
      }

      expect(scanner.getScanHistory()).toHaveLength(UNIVERSE_SCANNER_DEFAULTS.MAX_SCAN_HISTORY);
    });

    it('getLastScanResult returns most recent scan', async () => {
      setupPassingGates();

      const scanner = new UniverseScanner(
        { tokens: ['BTC', 'ETH'] },
        createMockPriceFeed(),
      );

      const result1 = await scanner.scanUniverse();
      const result2 = await scanner.scanUniverse();

      expect(scanner.getLastScanResult()?.scanId).toBe(result2.scanId);
    });

    it('getLastScanResult returns undefined before first scan', () => {
      const scanner = new UniverseScanner(
        { tokens: ['BTC', 'ETH'] },
        createMockPriceFeed(),
      );

      expect(scanner.getLastScanResult()).toBeUndefined();
    });
  });

  // --- Public accessors ---

  describe('public accessors', () => {
    it('getEligiblePairs returns current eligible pairs', async () => {
      setupPassingGates();

      const scanner = new UniverseScanner(
        { tokens: ['BTC', 'ETH'] },
        createMockPriceFeed(),
      );

      await scanner.scanUniverse();
      const eligible = scanner.getEligiblePairs();
      expect(eligible).toHaveLength(1);
      expect(eligible[0].key).toBe('BTC-ETH');
    });

    it('getEligiblePairs returns empty before scan', () => {
      const scanner = new UniverseScanner(
        { tokens: ['BTC', 'ETH'] },
        createMockPriceFeed(),
      );

      expect(scanner.getEligiblePairs()).toHaveLength(0);
    });

    it('isEligible returns true for eligible pair', async () => {
      setupPassingGates();

      const scanner = new UniverseScanner(
        { tokens: ['BTC', 'ETH'] },
        createMockPriceFeed(),
      );

      await scanner.scanUniverse();
      expect(scanner.isEligible('BTC', 'ETH')).toBe(true);
      expect(scanner.isEligible('ETH', 'BTC')).toBe(true); // Order shouldn't matter
    });

    it('isEligible returns false for non-eligible pair', async () => {
      setupFailingCorrelation();

      const scanner = new UniverseScanner(
        { tokens: ['BTC', 'ETH'] },
        createMockPriceFeed(),
      );

      await scanner.scanUniverse();
      expect(scanner.isEligible('BTC', 'ETH')).toBe(false);
    });
  });

  // --- controlTask ---

  describe('controlTask', () => {
    it('delegates to scanUniverse', async () => {
      setupPassingGates();

      const scanner = new UniverseScanner(
        { tokens: ['BTC', 'ETH'] },
        createMockPriceFeed(),
      );

      await scanner.controlTask();
      expect(scanner.getEligiblePairs()).toHaveLength(1);
    });
  });
});
