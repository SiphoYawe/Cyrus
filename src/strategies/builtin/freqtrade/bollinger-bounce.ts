import { FreqtradeAdapter } from '../../adapters/freqtrade-adapter.js';
import type { DataFrame } from '../../adapters/freqtrade-adapter.js';
import { calculateBollingerBands } from '../../adapters/indicators.js';

// ---------------------------------------------------------------------------
// Bollinger Bands helper — adds 'bb_upper', 'bb_middle', 'bb_lower' columns
// ---------------------------------------------------------------------------

export function addBollingerBands(
  dataframe: DataFrame,
  period: number,
  stdDevMultiplier: number,
): DataFrame {
  const closes = dataframe.map((row) => row.close);
  const { upper, middle, lower } = calculateBollingerBands(closes, period, stdDevMultiplier);

  return dataframe.map((row, i) => ({
    ...row,
    bb_upper: isNaN(upper[i]) ? null : upper[i],
    bb_middle: isNaN(middle[i]) ? null : middle[i],
    bb_lower: isNaN(lower[i]) ? null : lower[i],
  }));
}

// ---------------------------------------------------------------------------
// Strategy
// ---------------------------------------------------------------------------

/**
 * Bollinger Bounce — Freqtrade-style strategy.
 *
 * Enters long when price touches or dips below the lower Bollinger Band (oversold).
 * Exits when price touches or exceeds the upper Bollinger Band (overbought).
 *
 * Classic mean-reversion strategy using volatility bands.
 */
export class BollingerBounce extends FreqtradeAdapter {
  readonly name = 'BollingerBounce';
  readonly timeframe = '5m';

  // Freqtrade-style risk params
  override readonly stoploss = -0.07;
  override readonly minimalRoi: Readonly<Record<number, number>> = { 0: 0.04, 30: 0.02 };
  override readonly trailingStop = false;
  override readonly maxPositions = 3;

  // Bollinger Bands configuration
  readonly bbPeriod = 20;
  readonly bbStdDev = 2;

  populateIndicators(dataframe: DataFrame): DataFrame {
    return addBollingerBands(dataframe, this.bbPeriod, this.bbStdDev);
  }

  populateEntryTrend(dataframe: DataFrame): DataFrame {
    return dataframe.map((row) => ({
      ...row,
      enter_long:
        row.bb_lower !== null &&
        row.close <= (row.bb_lower as number),
    }));
  }

  populateExitTrend(dataframe: DataFrame): DataFrame {
    return dataframe.map((row) => ({
      ...row,
      exit_long:
        row.bb_upper !== null &&
        row.close >= (row.bb_upper as number),
    }));
  }
}
