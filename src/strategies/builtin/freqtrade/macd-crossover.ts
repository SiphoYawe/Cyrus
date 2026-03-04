import { FreqtradeAdapter } from '../../adapters/freqtrade-adapter.js';
import type { DataFrame } from '../../adapters/freqtrade-adapter.js';
import { calculateMacd } from '../../adapters/indicators.js';

// ---------------------------------------------------------------------------
// MACD helper — adds 'macd', 'macd_signal', 'macd_histogram' columns
// ---------------------------------------------------------------------------

export function addMacd(
  dataframe: DataFrame,
  fast: number,
  slow: number,
  signal: number,
): DataFrame {
  const closes = dataframe.map((row) => row.close);
  const { macd, signal: signalLine, histogram } = calculateMacd(closes, fast, slow, signal);

  return dataframe.map((row, i) => ({
    ...row,
    macd: isNaN(macd[i]) ? null : macd[i],
    macd_signal: isNaN(signalLine[i]) ? null : signalLine[i],
    macd_histogram: isNaN(histogram[i]) ? null : histogram[i],
  }));
}

// ---------------------------------------------------------------------------
// Strategy
// ---------------------------------------------------------------------------

/**
 * MACD Crossover — Freqtrade-style strategy.
 *
 * Enters long when the MACD line crosses above the signal line (bullish crossover).
 * Exits long when the MACD line crosses below the signal line (bearish crossover).
 *
 * Uses a trailing stop with offset for profit protection.
 */
export class MacdCrossover extends FreqtradeAdapter {
  readonly name = 'MacdCrossover';
  readonly timeframe = '5m';

  // Freqtrade-style risk params
  override readonly stoploss = -0.08;
  override readonly minimalRoi: Readonly<Record<number, number>> = { 0: 0.10 };
  override readonly trailingStop = true;
  override readonly trailingStopPositive: number | undefined = 0.02;
  override readonly maxPositions = 3;

  // MACD configuration
  readonly macdFast = 12;
  readonly macdSlow = 26;
  readonly macdSignal = 9;

  // Trailing stop offset params (stored as metadata for risk engine)
  readonly trailingStopPositiveOffset = 0.04;
  readonly trailingOnlyOffsetIsReached = true;

  populateIndicators(dataframe: DataFrame): DataFrame {
    return addMacd(dataframe, this.macdFast, this.macdSlow, this.macdSignal);
  }

  populateEntryTrend(dataframe: DataFrame): DataFrame {
    return dataframe.map((row, i) => {
      // Need at least one previous row to detect crossover
      if (i === 0 || row.macd === null || row.macd_signal === null) {
        return { ...row, enter_long: false };
      }

      const prevRow = dataframe[i - 1];
      // Note: we use the input `dataframe` which already has indicators from populateIndicators
      // But for safety, check that previous row has the indicators
      if (prevRow.macd === null || prevRow.macd === undefined ||
          prevRow.macd_signal === null || prevRow.macd_signal === undefined) {
        return { ...row, enter_long: false };
      }

      const prevMacd = prevRow.macd as number;
      const prevSignal = prevRow.macd_signal as number;
      const currMacd = row.macd as number;
      const currSignal = row.macd_signal as number;

      // Bullish crossover: MACD crosses above signal
      const crossedAbove = prevMacd <= prevSignal && currMacd > currSignal;

      return { ...row, enter_long: crossedAbove };
    });
  }

  populateExitTrend(dataframe: DataFrame): DataFrame {
    return dataframe.map((row, i) => {
      if (i === 0 || row.macd === null || row.macd_signal === null) {
        return { ...row, exit_long: false };
      }

      const prevRow = dataframe[i - 1];
      if (prevRow.macd === null || prevRow.macd === undefined ||
          prevRow.macd_signal === null || prevRow.macd_signal === undefined) {
        return { ...row, exit_long: false };
      }

      const prevMacd = prevRow.macd as number;
      const prevSignal = prevRow.macd_signal as number;
      const currMacd = row.macd as number;
      const currSignal = row.macd_signal as number;

      // Bearish crossover: MACD crosses below signal
      const crossedBelow = prevMacd >= prevSignal && currMacd < currSignal;

      return { ...row, exit_long: crossedBelow };
    });
  }

  /** Return the Freqtrade risk config including offset params. */
  override getFreqtradeRiskConfig() {
    const base = super.getFreqtradeRiskConfig();
    return {
      ...base,
      trailing_stop_positive_offset: this.trailingStopPositiveOffset,
      trailing_only_offset_is_reached: this.trailingOnlyOffsetIsReached,
    };
  }
}
