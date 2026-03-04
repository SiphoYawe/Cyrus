import { randomUUID } from 'node:crypto';
import { RunnableBase } from '../core/runnable-base.js';
import { Store } from '../core/store.js';
import {
  STAT_ARB_SIGNAL_EVENT,
  STAT_ARB_EXIT_SIGNAL_EVENT,
  createPairKey,
} from '../core/store-slices/stat-arb-slice.js';
import type {
  StatArbSignal,
  StatArbExitSignal,
  StatArbDirection,
  StatArbExitReason,
  StatArbPosition,
  StatArbPair,
} from '../core/store-slices/stat-arb-slice.js';
import { rollingZScore } from './math-library.js';
import type { HourlyPriceFeed } from './hourly-price-feed.js';
import type { UniverseScanner, EligiblePair } from './universe-scanner.js';

// --- Constants ---

export const SIGNAL_GENERATOR_DEFAULTS = {
  TICK_INTERVAL_MS: 3_600_000, // 1 hour
  ENTRY_THRESHOLD: 1.5,
  EXIT_THRESHOLD: 0.5,
  TIME_STOP_MULTIPLIER: 3,
  Z_SCORE_WINDOW: 72,
  SIGNAL_EXPIRY_MS: 3_600_000, // 60 min
} as const;

export interface LeverageTableEntry {
  readonly minCorrelation: number;
  readonly minAbsZScore: number;
  readonly leverage: number;
}

export const DEFAULT_LEVERAGE_TABLE: readonly LeverageTableEntry[] = [
  { minCorrelation: 0.87, minAbsZScore: 2.5, leverage: 23 },
  { minCorrelation: 0.85, minAbsZScore: 2.0, leverage: 18 },
  { minCorrelation: 0.82, minAbsZScore: 1.7, leverage: 9 },
  { minCorrelation: 0.80, minAbsZScore: 1.5, leverage: 5 },
] as const;

// --- Config ---

export interface SignalGeneratorConfig {
  readonly tickIntervalMs: number;
  readonly entryThreshold: number;
  readonly exitThreshold: number;
  readonly timeStopMultiplier: number;
  readonly zScoreWindow: number;
  readonly signalExpiryMs: number;
  readonly leverageTable: readonly LeverageTableEntry[];
}

// --- Signal Generator ---

export class SignalGenerator extends RunnableBase {
  private readonly config: SignalGeneratorConfig;
  private readonly universeScanner: UniverseScanner;
  private readonly priceFeed: HourlyPriceFeed;
  private readonly store: Store;
  private entrySignalsGenerated = 0;
  private exitSignalsGenerated = 0;

  constructor(
    config: Partial<SignalGeneratorConfig>,
    universeScanner: UniverseScanner,
    priceFeed: HourlyPriceFeed,
    store?: Store,
  ) {
    const tickIntervalMs = config.tickIntervalMs ?? SIGNAL_GENERATOR_DEFAULTS.TICK_INTERVAL_MS;
    super(tickIntervalMs, 'signal-generator');

    this.config = {
      tickIntervalMs,
      entryThreshold: config.entryThreshold ?? SIGNAL_GENERATOR_DEFAULTS.ENTRY_THRESHOLD,
      exitThreshold: config.exitThreshold ?? SIGNAL_GENERATOR_DEFAULTS.EXIT_THRESHOLD,
      timeStopMultiplier: config.timeStopMultiplier ?? SIGNAL_GENERATOR_DEFAULTS.TIME_STOP_MULTIPLIER,
      zScoreWindow: config.zScoreWindow ?? SIGNAL_GENERATOR_DEFAULTS.Z_SCORE_WINDOW,
      signalExpiryMs: config.signalExpiryMs ?? SIGNAL_GENERATOR_DEFAULTS.SIGNAL_EXPIRY_MS,
      leverageTable: config.leverageTable ?? DEFAULT_LEVERAGE_TABLE,
    };

    this.universeScanner = universeScanner;
    this.priceFeed = priceFeed;
    this.store = store ?? Store.getInstance();
  }

  async controlTask(): Promise<void> {
    this.store.pruneExpiredSignals();
    await this.evaluateAllPairs();
    await this.evaluateOpenPositions();
  }

  async onStop(): Promise<void> {
    this.logger.info(
      { entrySignals: this.entrySignalsGenerated, exitSignals: this.exitSignalsGenerated },
      'Signal generator stopped',
    );
  }

  // --- Entry signal evaluation ---

  private async evaluateAllPairs(): Promise<void> {
    const eligiblePairs = this.universeScanner.getEligiblePairs();

    for (const pair of eligiblePairs) {
      try {
        await this.evaluateEntryForPair(pair);
      } catch (error) {
        this.logger.warn(
          { pair: pair.key, error: (error as Error).message },
          `Entry evaluation error for ${pair.key}`,
        );
      }
    }
  }

  private async evaluateEntryForPair(pair: EligiblePair): Promise<void> {
    // Skip if position already exists
    const existingPosition = this.store.getActivePositionByPairKey(pair.key);
    if (existingPosition) {
      this.logger.debug({ pair: pair.key }, 'Skipping entry: position already open');
      return;
    }

    // Fetch prices and compute z-score
    const lookbackBuffer = 10;
    const priceResult = await this.priceFeed.getHourlyPrices(
      pair.tokenA,
      pair.tokenB,
      this.config.zScoreWindow + lookbackBuffer,
    );

    const pricesA = priceResult.pricesA as number[];
    const pricesB = priceResult.pricesB as number[];

    const zResult = rollingZScore(pricesA, pricesB, pair.hedgeRatio, this.config.zScoreWindow);
    const currentZ = zResult.currentZScore;

    // Generate entry signal based on z-score
    if (currentZ >= this.config.entryThreshold) {
      this.generateEntrySignal(pair, 'short_pair', currentZ);
    } else if (currentZ <= -this.config.entryThreshold) {
      this.generateEntrySignal(pair, 'long_pair', currentZ);
    }
  }

  private generateEntrySignal(pair: EligiblePair, direction: StatArbDirection, zScore: number): void {
    const leverage = this.recommendLeverage(pair.correlation, Math.abs(zScore));

    const existingSignal = this.store.getSignalByPairKey(pair.key);
    if (existingSignal) {
      // Update existing signal (refresh z-score and timestamp)
      const updated: StatArbSignal = {
        ...existingSignal,
        zScore,
        direction,
        timestamp: Date.now(),
        expiresAt: Date.now() + this.config.signalExpiryMs,
        recommendedLeverage: leverage,
      };
      this.store.removeSignal(pair.key);
      this.store.addStatArbSignal(updated);

      this.logger.info(
        { pair: pair.key, direction, zScore: zScore.toFixed(3), leverage },
        `Entry signal updated: ${direction} ${pair.key} Z=${zScore.toFixed(3)} leverage=x${leverage}`,
      );
      return;
    }

    const signal: StatArbSignal = {
      signalId: randomUUID().slice(0, 8),
      pair: { tokenA: pair.tokenA, tokenB: pair.tokenB, key: pair.key },
      direction,
      zScore,
      correlation: pair.correlation,
      halfLifeHours: pair.halfLifeHours,
      hedgeRatio: pair.hedgeRatio,
      recommendedLeverage: leverage,
      source: 'native',
      timestamp: Date.now(),
      consumed: false,
      expiresAt: Date.now() + this.config.signalExpiryMs,
    };

    this.store.addStatArbSignal(signal);
    this.entrySignalsGenerated++;

    this.logger.info(
      { pair: pair.key, direction, zScore: zScore.toFixed(3), leverage },
      `Entry signal: ${direction} ${pair.key} Z=${zScore.toFixed(3)} leverage=x${leverage}`,
    );
  }

  // --- Leverage recommendation ---

  recommendLeverage(correlation: number, absZScore: number): number {
    for (const entry of this.config.leverageTable) {
      if (correlation > entry.minCorrelation && absZScore > entry.minAbsZScore) {
        return entry.leverage;
      }
    }
    // Default minimum
    return DEFAULT_LEVERAGE_TABLE[DEFAULT_LEVERAGE_TABLE.length - 1].leverage;
  }

  // --- Exit signal evaluation ---

  private async evaluateOpenPositions(): Promise<void> {
    const activePositions = this.store.getAllActiveStatArbPositions();

    for (const position of activePositions) {
      try {
        await this.evaluateExitForPosition(position);
      } catch (error) {
        this.logger.warn(
          { positionId: position.positionId, pair: position.pair.key, error: (error as Error).message },
          `Exit evaluation error for ${position.pair.key}`,
        );
      }
    }
  }

  private async evaluateExitForPosition(position: StatArbPosition): Promise<void> {
    // Check time stop first (doesn't need price data)
    const elapsedHours = (Date.now() - position.openTimestamp) / 3_600_000;
    const timeStopThreshold = this.config.timeStopMultiplier * position.halfLifeHours;

    if (elapsedHours >= timeStopThreshold) {
      this.emitExitSignal(position, 'time_stop', 0, elapsedHours);
      return;
    }

    // Fetch prices and compute current z-score for mean reversion check
    const lookbackBuffer = 10;
    const priceResult = await this.priceFeed.getHourlyPrices(
      position.pair.tokenA,
      position.pair.tokenB,
      this.config.zScoreWindow + lookbackBuffer,
    );

    const pricesA = priceResult.pricesA as number[];
    const pricesB = priceResult.pricesB as number[];

    const zResult = rollingZScore(pricesA, pricesB, position.hedgeRatio, this.config.zScoreWindow);
    const currentZ = zResult.currentZScore;

    // Check mean reversion exit
    if (Math.abs(currentZ) <= this.config.exitThreshold) {
      this.emitExitSignal(position, 'mean_reversion', currentZ, elapsedHours);
    }
  }

  private emitExitSignal(
    position: StatArbPosition,
    reason: StatArbExitReason,
    zScore: number,
    elapsedHours: number,
  ): void {
    const exitSignal: StatArbExitSignal = {
      signalId: randomUUID().slice(0, 8),
      positionId: position.positionId,
      pair: position.pair,
      reason,
      zScore,
      elapsedHours,
      halfLifeHours: position.halfLifeHours,
      timestamp: Date.now(),
    };

    this.store.emitter.emit(STAT_ARB_EXIT_SIGNAL_EVENT, exitSignal);
    this.exitSignalsGenerated++;

    this.logger.info(
      { positionId: position.positionId, pair: position.pair.key, reason, zScore: zScore.toFixed(3), elapsedHours: elapsedHours.toFixed(1) },
      `Exit signal: ${reason} ${position.pair.key} Z=${zScore.toFixed(3)} elapsed=${elapsedHours.toFixed(1)}h`,
    );
  }

  // --- Public accessors ---

  getConfig(): Readonly<SignalGeneratorConfig> {
    return this.config;
  }

  getStats(): { entrySignalsGenerated: number; exitSignalsGenerated: number } {
    return {
      entrySignalsGenerated: this.entrySignalsGenerated,
      exitSignalsGenerated: this.exitSignalsGenerated,
    };
  }
}
