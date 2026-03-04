import { randomUUID } from 'node:crypto';
import { RunnableBase } from '../core/runnable-base.js';
import { Store } from '../core/store.js';
import { createPairKey } from '../core/store-slices/stat-arb-slice.js';
import {
  pearsonCorrelation,
  engleGrangerTest,
  ouHalfLife,
  olsHedgeRatio,
  STAT_ARB_MATH_CONSTANTS,
} from './math-library.js';
import type { HourlyPriceFeed } from './hourly-price-feed.js';

// --- Constants ---

export const UNIVERSE_SCANNER_DEFAULTS = {
  SCAN_INTERVAL_MS: 14_400_000, // 4 hours
  LOOKBACK_HOURS: 168,
  CORRELATION_THRESHOLD: 0.80,
  COINTEGRATION_P_THRESHOLD: 0.05,
  HALF_LIFE_MAX_HOURS: 48,
  MAX_CONCURRENT_EVALUATIONS: 20,
  MAX_SCAN_HISTORY: 24,
} as const;

// --- Types ---

export interface EligiblePair {
  readonly tokenA: string;
  readonly tokenB: string;
  readonly key: string;
  readonly correlation: number;
  readonly pValue: number;
  readonly halfLifeHours: number;
  readonly hedgeRatio: number;
  readonly intercept: number;
  readonly rSquared: number;
  readonly lastScanTimestamp: number;
  readonly scanId: string;
}

export interface UniverseScannerConfig {
  readonly scanIntervalMs: number;
  readonly lookbackHours: number;
  readonly correlationThreshold: number;
  readonly cointegrationPThreshold: number;
  readonly halfLifeMaxHours: number;
  readonly maxConcurrentPairEvaluations: number;
  readonly tokens: readonly string[];
}

export interface ScanResult {
  readonly scanId: string;
  readonly timestamp: number;
  readonly durationMs: number;
  readonly totalPairsScanned: number;
  readonly eligibleCount: number;
  readonly newlyAdded: readonly string[];
  readonly removed: readonly string[];
  readonly eligiblePairs: readonly EligiblePair[];
  readonly errors: readonly ScanError[];
}

export interface ScanError {
  readonly pair: string;
  readonly error: string;
  readonly phase: 'price_fetch' | 'correlation' | 'cointegration' | 'half_life';
}

export interface PairCandidate {
  readonly tokenA: string;
  readonly tokenB: string;
  readonly key: string;
}

// --- Pair generation ---

export function generatePairCandidates(tokens: readonly string[]): PairCandidate[] {
  const candidates: PairCandidate[] = [];
  const sorted = [...tokens].sort();
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      candidates.push({
        tokenA: sorted[i],
        tokenB: sorted[j],
        key: createPairKey(sorted[i], sorted[j]),
      });
    }
  }
  return candidates;
}

// --- Scanner class ---

export class UniverseScanner extends RunnableBase {
  private readonly config: UniverseScannerConfig;
  private readonly priceFeed: HourlyPriceFeed;
  private readonly store: Store;
  private readonly eligiblePairs: Map<string, EligiblePair> = new Map();
  private previousEligibleKeys: Set<string> = new Set();
  private readonly scanHistory: ScanResult[] = [];

  constructor(
    config: Partial<UniverseScannerConfig> & { tokens: readonly string[] },
    priceFeed: HourlyPriceFeed,
    store?: Store,
  ) {
    const scanIntervalMs = config.scanIntervalMs ?? UNIVERSE_SCANNER_DEFAULTS.SCAN_INTERVAL_MS;
    super(scanIntervalMs, 'universe-scanner');

    this.config = {
      scanIntervalMs,
      lookbackHours: config.lookbackHours ?? UNIVERSE_SCANNER_DEFAULTS.LOOKBACK_HOURS,
      correlationThreshold: config.correlationThreshold ?? UNIVERSE_SCANNER_DEFAULTS.CORRELATION_THRESHOLD,
      cointegrationPThreshold: config.cointegrationPThreshold ?? UNIVERSE_SCANNER_DEFAULTS.COINTEGRATION_P_THRESHOLD,
      halfLifeMaxHours: config.halfLifeMaxHours ?? UNIVERSE_SCANNER_DEFAULTS.HALF_LIFE_MAX_HOURS,
      maxConcurrentPairEvaluations: config.maxConcurrentPairEvaluations ?? UNIVERSE_SCANNER_DEFAULTS.MAX_CONCURRENT_EVALUATIONS,
      tokens: config.tokens,
    };

    this.priceFeed = priceFeed;
    this.store = store ?? Store.getInstance();
  }

  async controlTask(): Promise<void> {
    await this.scanUniverse();
  }

  async onStop(): Promise<void> {
    this.logger.info(
      { eligibleCount: this.eligiblePairs.size },
      'Universe scanner stopped',
    );
  }

  // --- Single pair evaluation ---

  private async evaluatePair(candidate: PairCandidate): Promise<{
    pair: EligiblePair | null;
    error: ScanError | null;
  }> {
    try {
      // Step 1: Fetch hourly prices
      const priceResult = await this.priceFeed.getHourlyPrices(
        candidate.tokenA,
        candidate.tokenB,
        this.config.lookbackHours,
      );

      const pricesA = priceResult.pricesA as number[];
      const pricesB = priceResult.pricesB as number[];

      if (pricesA.length < STAT_ARB_MATH_CONSTANTS.DEFAULT_LOOKBACK) {
        this.logger.debug(
          { pair: candidate.key, length: pricesA.length },
          'Insufficient price data',
        );
        return { pair: null, error: null };
      }

      // Gate 1: Correlation
      const corrResult = pearsonCorrelation(pricesA, pricesB);
      if (corrResult.correlation < this.config.correlationThreshold) {
        this.logger.debug(
          { pair: candidate.key, correlation: corrResult.correlation },
          'Failed correlation gate',
        );
        return { pair: null, error: null };
      }

      // Gate 2: Cointegration
      const egResult = engleGrangerTest(pricesA, pricesB);
      if (!egResult.cointegrated || egResult.pValue >= this.config.cointegrationPThreshold) {
        this.logger.debug(
          { pair: candidate.key, pValue: egResult.pValue },
          'Failed cointegration gate',
        );
        return { pair: null, error: null };
      }

      // Gate 3: Half-life
      const hlResult = ouHalfLife(egResult.residuals);
      if (!hlResult.isStationary || hlResult.halfLifeHours > this.config.halfLifeMaxHours) {
        this.logger.debug(
          { pair: candidate.key, halfLifeHours: hlResult.halfLifeHours },
          'Failed half-life gate',
        );
        return { pair: null, error: null };
      }

      // Compute hedge ratio
      const hedgeResult = olsHedgeRatio(pricesA, pricesB);

      const eligible: EligiblePair = {
        tokenA: candidate.tokenA,
        tokenB: candidate.tokenB,
        key: candidate.key,
        correlation: corrResult.correlation,
        pValue: egResult.pValue,
        halfLifeHours: hlResult.halfLifeHours,
        hedgeRatio: hedgeResult.slope,
        intercept: hedgeResult.intercept,
        rSquared: hedgeResult.rSquared,
        lastScanTimestamp: Date.now(),
        scanId: '',
      };

      return { pair: eligible, error: null };
    } catch (error) {
      const phase = this.classifyErrorPhase(error);
      return {
        pair: null,
        error: {
          pair: candidate.key,
          error: (error as Error).message,
          phase,
        },
      };
    }
  }

  private classifyErrorPhase(error: unknown): ScanError['phase'] {
    const msg = (error as Error).message ?? '';
    if (msg.includes('PriceFeed')) return 'price_fetch';
    if (msg.includes('pearsonCorrelation') || msg.includes('correlation')) return 'correlation';
    if (msg.includes('engleGranger') || msg.includes('cointegration')) return 'cointegration';
    return 'half_life';
  }

  // --- Batch scanning ---

  async scanUniverse(): Promise<ScanResult> {
    const scanId = randomUUID().slice(0, 8);
    const startTime = Date.now();

    const candidates = generatePairCandidates(this.config.tokens);
    const allResults: Array<{ pair: EligiblePair | null; error: ScanError | null }> = [];

    // Process in batches
    for (let i = 0; i < candidates.length; i += this.config.maxConcurrentPairEvaluations) {
      const batch = candidates.slice(i, i + this.config.maxConcurrentPairEvaluations);
      const batchResults = await Promise.allSettled(
        batch.map((c) => this.evaluatePair(c)),
      );

      for (const result of batchResults) {
        if (result.status === 'fulfilled') {
          allResults.push(result.value);
        } else {
          allResults.push({
            pair: null,
            error: { pair: 'unknown', error: result.reason?.message ?? 'Unknown', phase: 'price_fetch' },
          });
        }
      }
    }

    // Collect eligible pairs
    const newEligibleMap = new Map<string, EligiblePair>();
    const errors: ScanError[] = [];

    for (const result of allResults) {
      if (result.error) {
        errors.push(result.error);
      }
      if (result.pair) {
        const pair = { ...result.pair, scanId };
        newEligibleMap.set(pair.key, pair);
      }
    }

    // Determine additions and removals
    const newKeys = new Set(newEligibleMap.keys());
    const newlyAdded: string[] = [];
    const removed: string[] = [];

    for (const key of newKeys) {
      if (!this.previousEligibleKeys.has(key)) {
        newlyAdded.push(key);
        const pair = newEligibleMap.get(key)!;
        this.logger.info(
          { pair: key, correlation: pair.correlation, pValue: pair.pValue, halfLife: pair.halfLifeHours },
          `New eligible pair: ${key}`,
        );
      }
    }

    for (const key of this.previousEligibleKeys) {
      if (!newKeys.has(key)) {
        removed.push(key);
        this.logger.info({ pair: key }, `Pair removed from universe: ${key}`);
      }
    }

    // Update state
    this.eligiblePairs.clear();
    for (const [key, pair] of newEligibleMap) {
      this.eligiblePairs.set(key, pair);
    }
    this.previousEligibleKeys = newKeys;

    // Log errors
    for (const err of errors) {
      this.logger.warn({ pair: err.pair, phase: err.phase }, err.error);
    }

    const durationMs = Date.now() - startTime;

    const scanResult: ScanResult = {
      scanId,
      timestamp: startTime,
      durationMs,
      totalPairsScanned: candidates.length,
      eligibleCount: newEligibleMap.size,
      newlyAdded,
      removed,
      eligiblePairs: Array.from(newEligibleMap.values()),
      errors,
    };

    // Store scan history
    this.scanHistory.push(scanResult);
    if (this.scanHistory.length > UNIVERSE_SCANNER_DEFAULTS.MAX_SCAN_HISTORY) {
      this.scanHistory.shift();
    }

    this.logger.info(
      {
        scanId,
        eligible: newEligibleMap.size,
        total: candidates.length,
        added: newlyAdded.length,
        removed: removed.length,
        durationMs,
        errors: errors.length,
      },
      `Scan ${scanId}: ${newEligibleMap.size} eligible / ${candidates.length} scanned | +${newlyAdded.length} / -${removed.length} | ${durationMs}ms`,
    );

    return scanResult;
  }

  // --- Public accessors ---

  getEligiblePairs(): EligiblePair[] {
    return Array.from(this.eligiblePairs.values());
  }

  isEligible(tokenA: string, tokenB: string): boolean {
    const key = createPairKey(tokenA, tokenB);
    return this.eligiblePairs.has(key);
  }

  getLastScanResult(): ScanResult | undefined {
    return this.scanHistory.length > 0
      ? this.scanHistory[this.scanHistory.length - 1]
      : undefined;
  }

  getScanHistory(): readonly ScanResult[] {
    return this.scanHistory;
  }
}
