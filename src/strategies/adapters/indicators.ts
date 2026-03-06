// Pure, deterministic technical indicator functions.
// No external TA libraries — all calculations implemented from scratch.

/**
 * Simple Moving Average.
 * Returns an array of length `data.length` where indices before `period - 1` are NaN.
 */
export function calculateSma(data: number[], period: number): number[] {
  const result: number[] = new Array(data.length).fill(NaN);
  if (period < 1 || data.length < period) return result;

  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += data[i];
  }
  result[period - 1] = sum / period;

  for (let i = period; i < data.length; i++) {
    sum += data[i] - data[i - period];
    result[i] = sum / period;
  }

  return result;
}

/**
 * Exponential Moving Average.
 * Uses the standard smoothing factor: multiplier = 2 / (period + 1).
 * First EMA value is seeded with the SMA of the first `period` data points.
 * Returns an array of length `data.length` where indices before `period - 1` are NaN.
 */
export function calculateEma(data: number[], period: number): number[] {
  const result: number[] = new Array(data.length).fill(NaN);
  if (period < 1 || data.length < period) return result;

  const multiplier = 2 / (period + 1);

  // Seed with SMA of first `period` values
  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += data[i];
  }
  result[period - 1] = sum / period;

  // Subsequent values use EMA formula
  for (let i = period; i < data.length; i++) {
    result[i] = (data[i] - result[i - 1]) * multiplier + result[i - 1];
  }

  return result;
}

/**
 * Wilder's RSI (Relative Strength Index).
 * Uses Wilder's smoothing method (exponential moving average with alpha = 1/period).
 * Returns an array of length `closes.length` where indices before `period` are NaN.
 */
export function calculateRsi(closes: number[], period: number): number[] {
  const result: number[] = new Array(closes.length).fill(NaN);
  if (period < 1 || closes.length <= period) return result;

  // Calculate price changes
  const changes: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    changes.push(closes[i] - closes[i - 1]);
  }

  // Seed average gain and average loss with SMA over first `period` changes
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 0; i < period; i++) {
    if (changes[i] >= 0) {
      avgGain += changes[i];
    } else {
      avgLoss += Math.abs(changes[i]);
    }
  }
  avgGain /= period;
  avgLoss /= period;

  // First RSI value at index `period`
  if (avgLoss === 0) {
    result[period] = 100;
  } else {
    const rs = avgGain / avgLoss;
    result[period] = 100 - 100 / (1 + rs);
  }

  // Subsequent values use Wilder's smoothing
  for (let i = period; i < changes.length; i++) {
    const change = changes[i];
    const gain = change >= 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;

    if (avgLoss === 0) {
      result[i + 1] = 100;
    } else {
      const rs = avgGain / avgLoss;
      result[i + 1] = 100 - 100 / (1 + rs);
    }
  }

  return result;
}

/**
 * MACD (Moving Average Convergence Divergence).
 * Returns MACD line, signal line, and histogram arrays.
 * Each array is of length `closes.length` with NaN for insufficient data.
 */
export function calculateMacd(
  closes: number[],
  fast: number,
  slow: number,
  signal: number,
): { macd: number[]; signal: number[]; histogram: number[] } {
  const fastEma = calculateEma(closes, fast);
  const slowEma = calculateEma(closes, slow);

  // MACD line = fast EMA - slow EMA
  const macdLine: number[] = new Array(closes.length).fill(NaN);
  for (let i = 0; i < closes.length; i++) {
    if (!isNaN(fastEma[i]) && !isNaN(slowEma[i])) {
      macdLine[i] = fastEma[i] - slowEma[i];
    }
  }

  // Signal line = EMA of MACD line (only over defined values)
  // Find the first valid MACD value
  let firstValid = -1;
  for (let i = 0; i < macdLine.length; i++) {
    if (!isNaN(macdLine[i])) {
      firstValid = i;
      break;
    }
  }

  const signalLine: number[] = new Array(closes.length).fill(NaN);
  const histogram: number[] = new Array(closes.length).fill(NaN);

  if (firstValid === -1) {
    return { macd: macdLine, signal: signalLine, histogram };
  }

  // Extract valid MACD values and compute EMA over them
  const validMacd = macdLine.slice(firstValid).filter((v) => !isNaN(v));
  if (validMacd.length < signal) {
    return { macd: macdLine, signal: signalLine, histogram };
  }

  const signalEma = calculateEma(validMacd, signal);

  // Map signal EMA back to original indices
  let validIdx = 0;
  for (let i = firstValid; i < closes.length; i++) {
    if (!isNaN(macdLine[i])) {
      if (!isNaN(signalEma[validIdx])) {
        signalLine[i] = signalEma[validIdx];
        histogram[i] = macdLine[i] - signalEma[validIdx];
      }
      validIdx++;
    }
  }

  return { macd: macdLine, signal: signalLine, histogram };
}

/**
 * Bollinger Bands.
 * Returns upper, middle (SMA), and lower bands.
 * Each array is of length `closes.length` with NaN for insufficient data.
 */
export function calculateBollingerBands(
  closes: number[],
  period: number,
  stdDevMultiplier: number,
): { upper: number[]; middle: number[]; lower: number[] } {
  const middle = calculateSma(closes, period);
  const upper: number[] = new Array(closes.length).fill(NaN);
  const lower: number[] = new Array(closes.length).fill(NaN);

  for (let i = period - 1; i < closes.length; i++) {
    // Calculate standard deviation over the window
    let sumSquaredDiff = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const diff = closes[j] - middle[i];
      sumSquaredDiff += diff * diff;
    }
    const stdDev = Math.sqrt(sumSquaredDiff / period);

    upper[i] = middle[i] + stdDevMultiplier * stdDev;
    lower[i] = middle[i] - stdDevMultiplier * stdDev;
  }

  return { upper, middle, lower };
}

/**
 * Average True Range (ATR).
 * Measures market volatility using high, low, and close prices.
 * Uses Wilder's smoothing method (same as RSI).
 * Returns an array of length equal to the input arrays, with NaN for insufficient data.
 */
export function calculateAtr(
  highs: number[],
  lows: number[],
  closes: number[],
  period: number,
): number[] {
  const len = highs.length;
  const result: number[] = new Array(len).fill(NaN);
  if (period < 1 || len < period + 1) return result;

  // Calculate True Range for each bar (starting at index 1)
  const tr: number[] = new Array(len).fill(0);
  for (let i = 1; i < len; i++) {
    const highLow = highs[i] - lows[i];
    const highClose = Math.abs(highs[i] - closes[i - 1]);
    const lowClose = Math.abs(lows[i] - closes[i - 1]);
    tr[i] = Math.max(highLow, highClose, lowClose);
  }

  // Seed ATR with SMA of first `period` true ranges (from index 1)
  let atr = 0;
  for (let i = 1; i <= period; i++) {
    atr += tr[i];
  }
  atr /= period;
  result[period] = atr;

  // Wilder's smoothing for subsequent values
  for (let i = period + 1; i < len; i++) {
    atr = (atr * (period - 1) + tr[i]) / period;
    result[i] = atr;
  }

  return result;
}

/**
 * Stochastic Oscillator (%K and %D).
 * %K = (Close - Lowest Low) / (Highest High - Lowest Low) * 100
 * %D = SMA of %K over `dPeriod` periods.
 * Returns arrays of length equal to closes, with NaN for insufficient data.
 */
export function calculateStochastic(
  highs: number[],
  lows: number[],
  closes: number[],
  kPeriod: number,
  dPeriod: number,
): { k: number[]; d: number[] } {
  const len = closes.length;
  const k: number[] = new Array(len).fill(NaN);
  const d: number[] = new Array(len).fill(NaN);
  if (kPeriod < 1 || len < kPeriod) return { k, d };

  // Calculate %K
  for (let i = kPeriod - 1; i < len; i++) {
    let lowestLow = Infinity;
    let highestHigh = -Infinity;
    for (let j = i - kPeriod + 1; j <= i; j++) {
      if (lows[j] < lowestLow) lowestLow = lows[j];
      if (highs[j] > highestHigh) highestHigh = highs[j];
    }
    const range = highestHigh - lowestLow;
    k[i] = range === 0 ? 50 : ((closes[i] - lowestLow) / range) * 100;
  }

  // Calculate %D = SMA of %K
  const validK = k.filter((v) => !isNaN(v));
  if (validK.length >= dPeriod) {
    const dSma = calculateSma(
      k.slice(kPeriod - 1), // only valid %K values
      dPeriod,
    );
    for (let i = 0; i < dSma.length; i++) {
      if (!isNaN(dSma[i])) {
        d[kPeriod - 1 + i] = dSma[i];
      }
    }
  }

  return { k, d };
}
