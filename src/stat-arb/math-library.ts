import { createLogger } from '../utils/logger.js';

const logger = createLogger('stat-arb-math');

// --- Constants ---

export const STAT_ARB_MATH_CONSTANTS = {
  MIN_SAMPLE_SIZE: 30,
  DEFAULT_Z_WINDOW: 72,
  DEFAULT_LOOKBACK: 168,
  CORRELATION_THRESHOLD: 0.80,
  COINTEGRATION_P_THRESHOLD: 0.05,
  HALF_LIFE_MAX_HOURS: 48,
} as const;

// Dickey-Fuller critical values (with constant, no trend)
// Used for ADF p-value interpolation
const ADF_CRITICAL_VALUES = [
  { n: 25,  cv1: -3.75, cv5: -3.00, cv10: -2.63 },
  { n: 50,  cv1: -3.58, cv5: -2.93, cv10: -2.60 },
  { n: 100, cv1: -3.51, cv5: -2.89, cv10: -2.58 },
  { n: 250, cv1: -3.46, cv5: -2.88, cv10: -2.57 },
  { n: 500, cv1: -3.44, cv5: -2.87, cv10: -2.57 },
  { n: 1000, cv1: -3.43, cv5: -2.86, cv10: -2.57 },
] as const;

// --- Result types ---

export interface PearsonCorrelationResult {
  readonly correlation: number;
  readonly logReturnsA: readonly number[];
  readonly logReturnsB: readonly number[];
  readonly sampleSize: number;
}

export interface EngleGrangerResult {
  readonly cointegrated: boolean;
  readonly pValue: number;
  readonly residuals: readonly number[];
  readonly slope: number;
  readonly intercept: number;
  readonly adfStatistic: number;
}

export interface HalfLifeResult {
  readonly halfLifeHours: number;
  readonly theta: number;
  readonly isStationary: boolean;
}

export interface RollingZScoreResult {
  readonly zScores: readonly number[];
  readonly spread: readonly number[];
  readonly rollingMean: readonly number[];
  readonly rollingStd: readonly number[];
  readonly currentZScore: number;
}

export interface OlsResult {
  readonly slope: number;
  readonly intercept: number;
  readonly rSquared: number;
  readonly standardError: number;
}

// --- Error class ---

export class StatArbMathError extends Error {
  readonly context: { functionName: string; details: Record<string, unknown> };

  constructor(functionName: string, message: string, details: Record<string, unknown> = {}) {
    super(`[${functionName}] ${message}`);
    this.name = 'StatArbMathError';
    this.context = { functionName, details };
  }
}

// --- Utility functions ---

export function isFiniteNumber(value: number): boolean {
  return Number.isFinite(value);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function validatePriceSeries(
  series: readonly number[],
  label: string,
  minLength: number,
): void {
  if (!series || series.length === 0) {
    throw new StatArbMathError('validatePriceSeries', `${label} is empty`, {
      label,
      length: 0,
    });
  }
  if (series.length < minLength) {
    throw new StatArbMathError(
      'validatePriceSeries',
      `${label} has ${series.length} elements, minimum ${minLength} required`,
      { label, length: series.length, minLength },
    );
  }
  for (let i = 0; i < series.length; i++) {
    if (!isFiniteNumber(series[i])) {
      throw new StatArbMathError(
        'validatePriceSeries',
        `${label} contains invalid value at index ${i}: ${series[i]}`,
        { label, index: i, value: series[i] },
      );
    }
  }
}

/**
 * Kahan summation for numerical stability on large arrays.
 */
export function computeMean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  let compensation = 0;
  for (const v of values) {
    const y = v - compensation;
    const t = sum + y;
    compensation = (t - sum) - y;
    sum = t;
  }
  return sum / values.length;
}

/**
 * Sample standard deviation using Welford's online algorithm.
 */
export function computeStd(values: readonly number[]): number {
  const n = values.length;
  if (n < 2) return 0;

  let mean = 0;
  let m2 = 0;
  for (let i = 0; i < n; i++) {
    const delta = values[i] - mean;
    mean += delta / (i + 1);
    const delta2 = values[i] - mean;
    m2 += delta * delta2;
  }

  return Math.sqrt(m2 / (n - 1));
}

/**
 * Compute log returns: ln(p_t / p_{t-1}).
 */
export function computeLogReturns(prices: readonly number[]): number[] {
  if (prices.length < 2) {
    throw new StatArbMathError('computeLogReturns', 'Need at least 2 prices', {
      length: prices.length,
    });
  }

  const returns: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i] <= 0 || prices[i - 1] <= 0) {
      throw new StatArbMathError(
        'computeLogReturns',
        `Non-positive price at index ${i}`,
        { index: i, priceT: prices[i], priceTMinus1: prices[i - 1] },
      );
    }
    returns.push(Math.log(prices[i] / prices[i - 1]));
  }
  return returns;
}

// --- Internal OLS helper ---

function olsRegression(y: readonly number[], x: readonly number[]): OlsResult {
  const n = y.length;
  if (n !== x.length) {
    throw new StatArbMathError('olsRegression', 'Arrays must be equal length', {
      yLen: n,
      xLen: x.length,
    });
  }
  if (n < 2) {
    throw new StatArbMathError('olsRegression', 'Need at least 2 data points', { n });
  }

  const meanX = computeMean(x);
  const meanY = computeMean(y);

  let ssXY = 0;
  let ssXX = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - meanX;
    const dy = y[i] - meanY;
    ssXY += dx * dy;
    ssXX += dx * dx;
  }

  if (ssXX === 0) {
    return { slope: 0, intercept: meanY, rSquared: 0, standardError: Infinity };
  }

  const slope = ssXY / ssXX;
  const intercept = meanY - slope * meanX;

  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i++) {
    const predicted = slope * x[i] + intercept;
    const residual = y[i] - predicted;
    ssRes += residual * residual;
    ssTot += (y[i] - meanY) * (y[i] - meanY);
  }

  const rSquared = ssTot === 0 ? 1 : clamp(1 - ssRes / ssTot, 0, 1);

  const mse = n > 2 ? ssRes / (n - 2) : 0;
  const standardError = ssXX > 0 ? Math.sqrt(mse / ssXX) : Infinity;

  return { slope, intercept, rSquared, standardError };
}

// --- ADF test ---

interface AdfTestResult {
  readonly adfStatistic: number;
  readonly pValue: number;
}

function interpolateCriticalValue(n: number, level: 'cv1' | 'cv5' | 'cv10'): number {
  const table = ADF_CRITICAL_VALUES;
  if (n <= table[0].n) return table[0][level];

  for (let i = 1; i < table.length; i++) {
    if (n <= table[i].n) {
      const prev = table[i - 1];
      const curr = table[i];
      const t = (n - prev.n) / (curr.n - prev.n);
      return prev[level] + t * (curr[level] - prev[level]);
    }
  }

  return table[table.length - 1][level];
}

function adfTest(series: readonly number[]): AdfTestResult {
  const n = series.length;
  if (n < 10) {
    throw new StatArbMathError('adfTest', 'Need at least 10 data points', { n });
  }

  // Δy_t = y_t - y_{t-1}
  const dy: number[] = [];
  const yLag: number[] = [];
  for (let i = 1; i < n; i++) {
    dy.push(series[i] - series[i - 1]);
    yLag.push(series[i - 1]);
  }

  // Regress Δy on y_{t-1}: Δy_t = α + γ * y_{t-1} + ε
  const result = olsRegression(dy, yLag);

  // ADF statistic = t-statistic for γ
  const tStat =
    result.standardError > 0 && isFiniteNumber(result.standardError)
      ? result.slope / result.standardError
      : -Infinity;

  // Interpolate p-value from critical values
  const cv1 = interpolateCriticalValue(n, 'cv1');
  const cv5 = interpolateCriticalValue(n, 'cv5');
  const cv10 = interpolateCriticalValue(n, 'cv10');

  let pValue: number;
  if (tStat <= cv1) {
    pValue = 0.005;
  } else if (tStat <= cv5) {
    const t = (tStat - cv1) / (cv5 - cv1);
    pValue = 0.01 + t * (0.05 - 0.01);
  } else if (tStat <= cv10) {
    const t = (tStat - cv5) / (cv10 - cv5);
    pValue = 0.05 + t * (0.10 - 0.05);
  } else {
    const t = Math.min((tStat - cv10) / Math.abs(cv10), 1);
    pValue = 0.10 + t * 0.90;
  }

  pValue = clamp(pValue, 0.0001, 1.0);

  return { adfStatistic: tStat, pValue };
}

// --- Public API ---

/**
 * Pearson correlation on log returns of two price series.
 */
export function pearsonCorrelation(
  seriesA: readonly number[],
  seriesB: readonly number[],
): PearsonCorrelationResult {
  validatePriceSeries(seriesA, 'seriesA', STAT_ARB_MATH_CONSTANTS.MIN_SAMPLE_SIZE);
  validatePriceSeries(seriesB, 'seriesB', STAT_ARB_MATH_CONSTANTS.MIN_SAMPLE_SIZE);

  if (seriesA.length !== seriesB.length) {
    throw new StatArbMathError('pearsonCorrelation', 'Series must be equal length', {
      lengthA: seriesA.length,
      lengthB: seriesB.length,
    });
  }

  const logReturnsA = computeLogReturns(seriesA);
  const logReturnsB = computeLogReturns(seriesB);

  const n = logReturnsA.length;
  const meanA = computeMean(logReturnsA);
  const meanB = computeMean(logReturnsB);

  let cov = 0;
  let varA = 0;
  let varB = 0;
  for (let i = 0; i < n; i++) {
    const dA = logReturnsA[i] - meanA;
    const dB = logReturnsB[i] - meanB;
    cov += dA * dB;
    varA += dA * dA;
    varB += dB * dB;
  }

  const stdA = Math.sqrt(varA);
  const stdB = Math.sqrt(varB);

  if (stdA === 0 || stdB === 0) {
    logger.warn('Zero standard deviation in correlation calculation');
    return { correlation: 0, logReturnsA, logReturnsB, sampleSize: n };
  }

  const correlation = clamp(cov / (stdA * stdB), -1, 1);

  return { correlation, logReturnsA, logReturnsB, sampleSize: n };
}

/**
 * Engle-Granger two-step cointegration test.
 * Step 1: OLS regression of A on B.
 * Step 2: ADF test on OLS residuals.
 */
export function engleGrangerTest(
  seriesA: readonly number[],
  seriesB: readonly number[],
): EngleGrangerResult {
  validatePriceSeries(seriesA, 'seriesA', STAT_ARB_MATH_CONSTANTS.DEFAULT_LOOKBACK);
  validatePriceSeries(seriesB, 'seriesB', STAT_ARB_MATH_CONSTANTS.DEFAULT_LOOKBACK);

  if (seriesA.length !== seriesB.length) {
    throw new StatArbMathError('engleGrangerTest', 'Series must be equal length', {
      lengthA: seriesA.length,
      lengthB: seriesB.length,
    });
  }

  // Step 1: OLS regression of A on B
  const ols = olsRegression(seriesA, seriesB);

  // Compute residuals
  const residuals: number[] = [];
  for (let i = 0; i < seriesA.length; i++) {
    residuals.push(seriesA[i] - (ols.slope * seriesB[i] + ols.intercept));
  }

  // Step 2: ADF test on residuals
  const { adfStatistic, pValue } = adfTest(residuals);

  return {
    cointegrated: pValue < STAT_ARB_MATH_CONSTANTS.COINTEGRATION_P_THRESHOLD,
    pValue,
    residuals,
    slope: ols.slope,
    intercept: ols.intercept,
    adfStatistic,
  };
}

/**
 * Ornstein-Uhlenbeck half-life from AR(1) fit on spread.
 * Half-life = ln(2) / -ln(1 + theta) where theta is the AR(1) coefficient.
 */
export function ouHalfLife(spread: readonly number[]): HalfLifeResult {
  if (spread.length < 10) {
    throw new StatArbMathError('ouHalfLife', 'Need at least 10 data points', {
      length: spread.length,
    });
  }

  // Validate no NaN/Infinity
  for (let i = 0; i < spread.length; i++) {
    if (!isFiniteNumber(spread[i])) {
      throw new StatArbMathError('ouHalfLife', `Invalid value at index ${i}`, {
        index: i,
        value: spread[i],
      });
    }
  }

  // Δspread_t = spread_t - spread_{t-1}
  const deltaSpread: number[] = [];
  const laggedSpread: number[] = [];
  for (let i = 1; i < spread.length; i++) {
    deltaSpread.push(spread[i] - spread[i - 1]);
    laggedSpread.push(spread[i - 1]);
  }

  // Regress Δspread on lagged spread
  const result = olsRegression(deltaSpread, laggedSpread);
  const theta = result.slope;

  // theta >= 0 means explosive / not mean-reverting
  if (theta >= 0) {
    return { halfLifeHours: Infinity, theta, isStationary: false };
  }

  // theta <= -1: instantaneous reversion
  if (theta <= -1) {
    return { halfLifeHours: 0, theta, isStationary: true };
  }

  // Half-life formula
  const halfLifeHours = Math.log(2) / -Math.log(1 + theta);

  const isStationary =
    halfLifeHours > 0 && halfLifeHours <= STAT_ARB_MATH_CONSTANTS.HALF_LIFE_MAX_HOURS;

  return { halfLifeHours, theta, isStationary };
}

/**
 * Rolling z-score of the spread between two series.
 */
export function rollingZScore(
  seriesA: readonly number[],
  seriesB: readonly number[],
  hedgeRatio: number,
  window: number = STAT_ARB_MATH_CONSTANTS.DEFAULT_Z_WINDOW,
): RollingZScoreResult {
  if (seriesA.length !== seriesB.length) {
    throw new StatArbMathError('rollingZScore', 'Series must be equal length', {
      lengthA: seriesA.length,
      lengthB: seriesB.length,
    });
  }
  if (window < 2) {
    throw new StatArbMathError('rollingZScore', 'Window must be >= 2', { window });
  }
  if (window > seriesA.length) {
    throw new StatArbMathError('rollingZScore', 'Window exceeds series length', {
      window,
      seriesLength: seriesA.length,
    });
  }

  // Compute spread: A - hedgeRatio * B
  const spread: number[] = [];
  for (let i = 0; i < seriesA.length; i++) {
    spread.push(seriesA[i] - hedgeRatio * seriesB[i]);
  }

  const zScores: number[] = new Array(seriesA.length).fill(NaN);
  const rollingMeanArr: number[] = new Array(seriesA.length).fill(NaN);
  const rollingStdArr: number[] = new Array(seriesA.length).fill(NaN);

  for (let i = window - 1; i < spread.length; i++) {
    const windowSlice = spread.slice(i - window + 1, i + 1);
    const mean = computeMean(windowSlice);
    const std = computeStd(windowSlice);

    rollingMeanArr[i] = mean;
    rollingStdArr[i] = std;

    if (std === 0) {
      zScores[i] = 0;
    } else {
      zScores[i] = (spread[i] - mean) / std;
    }
  }

  let currentZScore = 0;
  for (let i = zScores.length - 1; i >= 0; i--) {
    if (isFiniteNumber(zScores[i])) {
      currentZScore = zScores[i];
      break;
    }
  }

  return {
    zScores,
    spread,
    rollingMean: rollingMeanArr,
    rollingStd: rollingStdArr,
    currentZScore,
  };
}

/**
 * OLS hedge ratio for beta-neutral position sizing.
 */
export function olsHedgeRatio(
  seriesA: readonly number[],
  seriesB: readonly number[],
): OlsResult {
  validatePriceSeries(seriesA, 'seriesA', STAT_ARB_MATH_CONSTANTS.MIN_SAMPLE_SIZE);
  validatePriceSeries(seriesB, 'seriesB', STAT_ARB_MATH_CONSTANTS.MIN_SAMPLE_SIZE);

  if (seriesA.length !== seriesB.length) {
    throw new StatArbMathError('olsHedgeRatio', 'Series must be equal length', {
      lengthA: seriesA.length,
      lengthB: seriesB.length,
    });
  }

  const result = olsRegression(seriesA, seriesB);

  if (result.rSquared < 0.50) {
    logger.warn(
      { rSquared: result.rSquared },
      'Weak linear relationship in hedge ratio calculation (R² < 0.50)',
    );
  }

  return result;
}
