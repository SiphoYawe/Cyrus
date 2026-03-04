// Confidence Scorer — stateless scoring for Telegram and native stat arb signals

import { createLogger } from '../utils/logger.js';
import { Store } from '../core/store.js';
import type { StatArbSignal } from '../core/store-slices/stat-arb-slice.js';
import type { AgentPearOpenSignal } from '../telegram/types.js';

const logger = createLogger('confidence-scorer');

// --- Types ---

export type SignalSource = 'telegram' | 'native';

export interface ConfidenceFactors {
  readonly base: number;
  readonly zScoreAdjustment: number;
  readonly correlationAdjustment: number;
  readonly freshnessAdjustment: number;
  readonly pValueAdjustment: number;
  readonly halfLifeAdjustment: number;
}

export interface ConfidenceResult {
  readonly score: number;
  readonly source: SignalSource;
  readonly factors: ConfidenceFactors;
  readonly rawScore: number;
  readonly clamped: boolean;
}

export interface ConfidenceScorerConfig {
  readonly telegramBaseConfidence: number;
  readonly freshnessDecayPerMinute: number;
  readonly zScoreBoostThreshold: number;
  readonly correlationBoostThreshold: number;
  readonly nativeBaseConfidence: number;
  readonly deduplicationTolerance: number;
}

const DEFAULT_CONFIG: ConfidenceScorerConfig = {
  telegramBaseConfidence: 0.66,
  freshnessDecayPerMinute: 0.10 / 60, // lose 0.10 over 60 minutes
  zScoreBoostThreshold: 2.0,
  correlationBoostThreshold: 0.85,
  nativeBaseConfidence: 0.50,
  deduplicationTolerance: 0.05,
};

// --- Scorer class ---

export class ConfidenceScorer {
  private readonly config: ConfidenceScorerConfig;

  constructor(config?: Partial<ConfidenceScorerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // --- Telegram signal scoring ---

  scoreTelegramSignal(signal: AgentPearOpenSignal, timestamp: number): ConfidenceResult {
    const base = this.config.telegramBaseConfidence;
    const zScoreAdjustment = this.calculateZScoreAdjustment(Math.abs(signal.zScore));
    const correlationAdjustment = this.calculateCorrelationAdjustment(signal.correlation);
    const freshnessAdjustment = this.calculateFreshnessAdjustment(timestamp);

    const rawScore = base + zScoreAdjustment + correlationAdjustment + freshnessAdjustment;
    const score = clamp(rawScore, 0, 1);

    return {
      score,
      source: 'telegram',
      factors: {
        base,
        zScoreAdjustment,
        correlationAdjustment,
        freshnessAdjustment,
        pValueAdjustment: 0,
        halfLifeAdjustment: 0,
      },
      rawScore,
      clamped: rawScore !== score,
    };
  }

  // --- Native signal scoring ---

  scoreNativeSignal(signal: NativeSignalInput): ConfidenceResult {
    const base = this.config.nativeBaseConfidence;
    const zScoreAdjustment = this.calculateZScoreAdjustment(Math.abs(signal.zScore));
    const correlationAdjustment = this.calculateCorrelationAdjustment(signal.correlation);
    const pValueAdjustment = this.calculatePValueAdjustment(signal.pValue);
    const halfLifeAdjustment = this.calculateHalfLifeAdjustment(signal.halfLifeHours);

    const rawScore = base + zScoreAdjustment + correlationAdjustment + pValueAdjustment + halfLifeAdjustment;
    const score = clamp(rawScore, 0, 1);

    return {
      score,
      source: 'native',
      factors: {
        base,
        zScoreAdjustment,
        correlationAdjustment,
        freshnessAdjustment: 0,
        pValueAdjustment,
        halfLifeAdjustment,
      },
      rawScore,
      clamped: rawScore !== score,
    };
  }

  // --- Deduplication ---

  deduplicateSignals(
    telegramResult: ConfidenceResult & { timestamp: number },
    nativeResult: ConfidenceResult & { timestamp: number },
  ): ConfidenceResult & { timestamp: number } {
    const diff = Math.abs(telegramResult.score - nativeResult.score);

    if (diff > this.config.deduplicationTolerance) {
      // Keep higher confidence
      const winner = telegramResult.score > nativeResult.score ? telegramResult : nativeResult;
      const loser = winner === telegramResult ? nativeResult : telegramResult;
      logger.debug(
        {
          keepSource: winner.source,
          keepScore: winner.score,
          dropSource: loser.source,
          dropScore: loser.score,
        },
        'Dedup: keeping higher-confidence signal',
      );
      return winner;
    }

    // Within tolerance — keep newer
    const winner = telegramResult.timestamp > nativeResult.timestamp ? telegramResult : nativeResult;
    const loser = winner === telegramResult ? nativeResult : telegramResult;
    logger.debug(
      {
        keepSource: winner.source,
        keepTimestamp: winner.timestamp,
        dropSource: loser.source,
        dropTimestamp: loser.timestamp,
      },
      'Dedup: keeping newer signal (scores within tolerance)',
    );
    return winner;
  }

  deduplicateStore(store: Store): number {
    const signals = store.getAllStatArbSignals();
    const byPair = new Map<string, StatArbSignal[]>();

    for (const signal of signals) {
      const existing = byPair.get(signal.pair.key);
      if (existing) {
        existing.push(signal);
      } else {
        byPair.set(signal.pair.key, [signal]);
      }
    }

    let resolved = 0;
    for (const [pairKey, pairSignals] of byPair) {
      if (pairSignals.length <= 1) continue;

      // Find telegram and native signals
      const telegram = pairSignals.find((s) => s.source === 'telegram');
      const native = pairSignals.find((s) => s.source === 'native');

      if (!telegram || !native) continue;

      // Score both
      const telegramScore = this.scoreTelegramSignalFromStatArb(telegram);
      const nativeScore = this.scoreNativeSignalFromStatArb(native);

      const winner = this.deduplicateSignals(
        { ...telegramScore, timestamp: telegram.timestamp },
        { ...nativeScore, timestamp: native.timestamp },
      );

      // Remove the loser
      const loserSource = winner.source === 'telegram' ? 'native' : 'telegram';
      const loserSignal = pairSignals.find((s) => s.source === loserSource);
      if (loserSignal) {
        // Since we can only store one signal per pair key, the latest addStatArbSignal
        // already overwrites. We just need to re-add the winner if it's not already the latest.
        const currentStored = store.getSignalByPairKey(pairKey);
        if (currentStored && currentStored.source !== winner.source) {
          const winnerSignal = pairSignals.find((s) => s.source === winner.source);
          if (winnerSignal) {
            store.addStatArbSignal(winnerSignal);
          }
        }
        resolved++;
      }
    }

    return resolved;
  }

  // --- Scoring helpers ---

  private calculateZScoreAdjustment(absZ: number): number {
    if (absZ >= 3.0) return 0.10;
    if (absZ >= 2.5) return 0.08;
    if (absZ >= 2.0) return 0.05;
    if (absZ < 1.7) return -0.03;
    return 0;
  }

  private calculateCorrelationAdjustment(correlation: number): number {
    if (correlation >= 0.90) return 0.10;
    if (correlation >= 0.87) return 0.08;
    if (correlation >= 0.85) return 0.05;
    if (correlation < 0.82) return -0.05;
    return 0;
  }

  private calculateFreshnessAdjustment(timestamp: number): number {
    const ageMinutes = (Date.now() - timestamp) / 60000;
    if (ageMinutes <= 0) return 0;
    return -(ageMinutes * this.config.freshnessDecayPerMinute);
  }

  private calculatePValueAdjustment(pValue: number): number {
    if (pValue < 0.01) return 0.10;
    if (pValue < 0.03) return 0.05;
    if (pValue < 0.05) return 0;
    return -0.10; // Should not happen if filter is working
  }

  private calculateHalfLifeAdjustment(halfLifeHours: number): number {
    if (halfLifeHours <= 12) return 0.05;
    if (halfLifeHours <= 24) return 0.03;
    if (halfLifeHours <= 36) return 0;
    if (halfLifeHours <= 48) return -0.05;
    return -0.05;
  }

  // --- Convenience scoring from StatArbSignal ---

  private scoreTelegramSignalFromStatArb(signal: StatArbSignal): ConfidenceResult {
    return this.scoreTelegramSignal(
      {
        pair: `${signal.pair.tokenA}/${signal.pair.tokenB}`,
        direction: signal.direction,
        zScore: signal.zScore,
        correlation: signal.correlation,
        halfLife: `${signal.halfLifeHours}h`,
        leverage: signal.recommendedLeverage,
        raw: '',
      },
      signal.timestamp,
    );
  }

  private scoreNativeSignalFromStatArb(signal: StatArbSignal): ConfidenceResult {
    return this.scoreNativeSignal({
      zScore: signal.zScore,
      correlation: signal.correlation,
      pValue: 0.03, // Default when not available
      halfLifeHours: signal.halfLifeHours,
    });
  }

  // --- Position sizing ---

  static adjustPositionSize(
    kellySize: number,
    confidence: number,
    minPositionSizeUsd: number = 0,
  ): number {
    const adjusted = kellySize * confidence;
    return Math.max(adjusted, minPositionSizeUsd);
  }
}

// --- Helper types ---

export interface NativeSignalInput {
  readonly zScore: number;
  readonly correlation: number;
  readonly pValue: number;
  readonly halfLifeHours: number;
}

// --- Utility ---

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
