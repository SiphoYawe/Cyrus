import { createLogger } from '../utils/logger.js';
import type { PositionSizeInput, PositionSizeResult, PositionSizeCap } from './types.js';

const logger = createLogger('kelly-criterion');

/** Max 25% of tier capital in a single position regardless of Kelly output */
export const KELLY_SAFETY_CAP = 0.25;

/**
 * Calculate the raw Kelly fraction.
 *
 * Formula: f = p - (1-p)/b
 * where p = win probability, b = payoff ratio
 *
 * @param p - Win probability (0 to 1)
 * @param b - Payoff ratio (average win / average loss, > 0)
 * @returns Raw Kelly fraction (can be negative)
 */
export function calculateKellyFraction(p: number, b: number): number {
  return p - (1 - p) / b;
}

/**
 * Calculate optimal position size using Kelly Criterion.
 *
 * Cap chain: raw Kelly → fractional Kelly → safety cap → maxPositionSizeUsd.
 * Invalid inputs fail safe to zero — never crash, never allocate on garbage data.
 *
 * @param input - Position sizing parameters
 * @returns Position size result with size, applied fraction, and which cap was binding
 */
export function calculatePositionSize(input: PositionSizeInput): PositionSizeResult {
  // Validate winProbability
  if (!Number.isFinite(input.winProbability) || input.winProbability < 0 || input.winProbability > 1) {
    logger.warn({ winProbability: input.winProbability }, 'Invalid win probability — rejecting position');
    return {
      recommendedSizeUsd: 0,
      kellyFractionRaw: 0,
      kellyFractionApplied: 0,
      cappedBy: 'rejected',
      reason: `Invalid win probability: ${input.winProbability} (must be finite number in [0, 1])`,
    };
  }

  // Validate payoffRatio
  if (!Number.isFinite(input.payoffRatio) || input.payoffRatio <= 0) {
    logger.warn({ payoffRatio: input.payoffRatio }, 'Invalid payoff ratio — rejecting position');
    return {
      recommendedSizeUsd: 0,
      kellyFractionRaw: 0,
      kellyFractionApplied: 0,
      cappedBy: 'rejected',
      reason: `Invalid payoff ratio: ${input.payoffRatio} (must be finite number > 0)`,
    };
  }

  // Validate tierAvailableCapital
  if (!Number.isFinite(input.tierAvailableCapital) || input.tierAvailableCapital < 0) {
    logger.warn({ tierAvailableCapital: input.tierAvailableCapital }, 'Invalid tier capital — rejecting position');
    return {
      recommendedSizeUsd: 0,
      kellyFractionRaw: 0,
      kellyFractionApplied: 0,
      cappedBy: 'rejected',
      reason: `Invalid tier available capital: ${input.tierAvailableCapital} (must be finite number >= 0)`,
    };
  }

  // Zero capital → zero size (valid, not an error)
  if (input.tierAvailableCapital === 0) {
    return {
      recommendedSizeUsd: 0,
      kellyFractionRaw: 0,
      kellyFractionApplied: 0,
      cappedBy: 'none',
      reason: 'Zero available capital',
    };
  }

  // Calculate raw Kelly fraction
  const rawKelly = calculateKellyFraction(input.winProbability, input.payoffRatio);

  // Negative Kelly → reject (expected loss)
  if (rawKelly <= 0) {
    logger.info(
      { rawKelly, winProbability: input.winProbability, payoffRatio: input.payoffRatio },
      'Kelly fraction negative, rejecting position — expected loss',
    );
    return {
      recommendedSizeUsd: 0,
      kellyFractionRaw: rawKelly,
      kellyFractionApplied: 0,
      cappedBy: 'rejected',
      reason: `Kelly fraction negative (${rawKelly.toFixed(4)}): expected loss with p=${input.winProbability}, b=${input.payoffRatio}`,
    };
  }

  // Apply fractional Kelly
  let effectiveFraction = rawKelly * input.kellyFraction;
  let cappedBy: PositionSizeCap = 'none';

  // Apply safety cap
  if (effectiveFraction > KELLY_SAFETY_CAP) {
    effectiveFraction = KELLY_SAFETY_CAP;
    cappedBy = 'safety-cap';
  }

  // Calculate position size
  let size = effectiveFraction * input.tierAvailableCapital;

  // Apply maxPositionSizeUsd cap
  if (size > input.maxPositionSizeUsd) {
    size = input.maxPositionSizeUsd;
    cappedBy = 'max-position-size';
  }

  return {
    recommendedSizeUsd: size,
    kellyFractionRaw: rawKelly,
    kellyFractionApplied: effectiveFraction,
    cappedBy,
    reason: cappedBy === 'none'
      ? `Kelly sizing: raw=${rawKelly.toFixed(4)}, applied=${effectiveFraction.toFixed(4)}`
      : cappedBy === 'safety-cap'
        ? `Safety cap applied: raw fraction ${rawKelly.toFixed(4)} capped to ${KELLY_SAFETY_CAP}`
        : `Max position size cap: $${input.maxPositionSizeUsd}`,
  };
}
