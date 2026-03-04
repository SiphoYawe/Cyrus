import { FreqtradeAdapter } from '../../adapters/freqtrade-adapter.js';
import type { DataFrame } from '../../adapters/freqtrade-adapter.js';
import { calculateRsi } from '../../adapters/indicators.js';

// ---------------------------------------------------------------------------
// RSI helper — adds 'rsi' column to DataFrame using Wilder's RSI(period)
// ---------------------------------------------------------------------------

export function addRsi(dataframe: DataFrame, period: number): DataFrame {
  const closes = dataframe.map((row) => row.close);
  const rsiValues = calculateRsi(closes, period);

  return dataframe.map((row, i) => ({
    ...row,
    rsi: isNaN(rsiValues[i]) ? null : rsiValues[i],
  }));
}

// ---------------------------------------------------------------------------
// Strategy
// ---------------------------------------------------------------------------

/**
 * RSI Mean Reversion — Freqtrade-style strategy.
 *
 * Buys when RSI(14) drops below 30 (oversold), exits when RSI rises above 70 (overbought).
 * Classic mean-reversion play: prices that deviate far from the mean tend to revert.
 */
export class RsiMeanReversion extends FreqtradeAdapter {
  readonly name = 'RsiMeanReversion';
  readonly timeframe = '5m';

  // Freqtrade-style risk params
  override readonly stoploss = -0.10;
  override readonly minimalRoi: Readonly<Record<number, number>> = { 0: 0.05, 60: 0.02, 120: 0.01 };
  override readonly trailingStop = false;
  override readonly maxPositions = 3;

  // RSI configuration
  readonly rsiPeriod = 14;
  readonly rsiBuyThreshold = 30;
  readonly rsiSellThreshold = 70;

  populateIndicators(dataframe: DataFrame): DataFrame {
    return addRsi(dataframe, this.rsiPeriod);
  }

  populateEntryTrend(dataframe: DataFrame): DataFrame {
    return dataframe.map((row) => ({
      ...row,
      enter_long: row.rsi !== null && (row.rsi as number) < this.rsiBuyThreshold,
    }));
  }

  populateExitTrend(dataframe: DataFrame): DataFrame {
    return dataframe.map((row) => ({
      ...row,
      exit_long: row.rsi !== null && (row.rsi as number) > this.rsiSellThreshold,
    }));
  }
}
