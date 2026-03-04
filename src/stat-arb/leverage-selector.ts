// Leverage Selection Logic — pure calculation module
// Waterfall tier evaluation: highest qualifying tier is selected

import { createLogger } from '../utils/logger.js';
import { LeverageSelectionError } from '../utils/errors.js';

const logger = createLogger('leverage-selector');

export interface LeverageTier {
  readonly name: string;
  readonly leverage: number;
  readonly minCorrelation: number;
  readonly minAbsZScore: number;
  readonly maxSpreadVol?: number;
}

export interface LeverageSelectionInput {
  readonly correlation: number;
  readonly absZScore: number;
  readonly spreadVolatility: number;
}

export interface LeverageSelectionResult {
  readonly leverage: number;
  readonly tier: string;
  readonly capped: boolean;
  readonly originalLeverage: number;
  readonly metrics: LeverageSelectionInput;
}

export interface LeverageSelectionConfig {
  readonly maxLeverage: number;
  readonly tiers?: readonly LeverageTier[];
  readonly ultraHighMaxSpreadVol?: number;
}

const DEFAULT_ULTRA_HIGH_MAX_SPREAD_VOL = 0.015;

const DEFAULT_TIERS: readonly LeverageTier[] = [
  { name: 'ultra-high', leverage: 23, minCorrelation: 0.87, minAbsZScore: 2.5 },
  { name: 'high', leverage: 18, minCorrelation: 0.85, minAbsZScore: 2.0 },
  { name: 'moderate', leverage: 9, minCorrelation: 0.82, minAbsZScore: 1.7 },
  { name: 'lower', leverage: 5, minCorrelation: 0.80, minAbsZScore: 1.5 },
] as const;

const MIN_CORRELATION = 0.80;
const MIN_ABS_Z_SCORE = 1.5;

function validateTierOrder(tiers: readonly LeverageTier[]): void {
  for (let i = 1; i < tiers.length; i++) {
    if (tiers[i].leverage >= tiers[i - 1].leverage) {
      throw new Error(
        `Leverage tiers must be sorted by leverage descending: tier "${tiers[i].name}" (${tiers[i].leverage}) must be less than tier "${tiers[i - 1].name}" (${tiers[i - 1].leverage})`,
      );
    }
  }
}

export function selectLeverage(
  input: LeverageSelectionInput,
  config: LeverageSelectionConfig,
): LeverageSelectionResult {
  const tiers = config.tiers ?? DEFAULT_TIERS;
  if (config.tiers) {
    validateTierOrder(tiers);
  }
  const ultraHighMaxSpreadVol = config.ultraHighMaxSpreadVol ?? DEFAULT_ULTRA_HIGH_MAX_SPREAD_VOL;

  for (const tier of tiers) {
    if (input.correlation < tier.minCorrelation) continue;
    if (input.absZScore < tier.minAbsZScore) continue;

    // Ultra-high tier has additional spread volatility check
    const spreadVolThreshold = tier.maxSpreadVol ?? (tier.name === 'ultra-high' ? ultraHighMaxSpreadVol : undefined);
    if (spreadVolThreshold !== undefined && input.spreadVolatility > spreadVolThreshold) {
      continue;
    }

    const originalLeverage = tier.leverage;
    const capped = originalLeverage > config.maxLeverage;
    const finalLeverage = capped ? config.maxLeverage : originalLeverage;

    if (capped) {
      logger.info(
        { tier: tier.name, originalLeverage, cappedTo: finalLeverage, ...input },
        'Leverage capped by maxLeverage config',
      );
    }

    logger.debug(
      { tier: tier.name, leverage: finalLeverage, capped, ...input },
      'Leverage selected',
    );

    return {
      leverage: finalLeverage,
      tier: tier.name,
      capped,
      originalLeverage,
      metrics: input,
    };
  }

  // No tier matched — signal below minimum thresholds
  logger.warn(
    { ...input, minCorrelation: MIN_CORRELATION, minAbsZScore: MIN_ABS_Z_SCORE },
    'Signal does not meet minimum leverage thresholds',
  );

  throw new LeverageSelectionError({
    correlation: input.correlation,
    absZScore: input.absZScore,
    spreadVolatility: input.spreadVolatility,
    minCorrelation: MIN_CORRELATION,
    minAbsZScore: MIN_ABS_Z_SCORE,
  });
}
