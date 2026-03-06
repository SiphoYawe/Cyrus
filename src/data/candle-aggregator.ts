import type { DataFrame, DataFrameRow } from '../strategies/adapters/freqtrade-adapter.js';

export interface CandleAggregatorConfig {
  readonly intervalMs: number; // candle interval in ms, default 5min = 300_000
  readonly maxCandles: number; // max candles to keep, default 200
}

const DEFAULT_CONFIG: CandleAggregatorConfig = {
  intervalMs: 5 * 60 * 1000, // 5 minutes
  maxCandles: 200,
};

/**
 * Aggregates spot price updates into OHLCV candles.
 * Each token gets its own rolling candle window.
 */
export class CandleAggregator {
  private readonly config: CandleAggregatorConfig;
  private readonly candles = new Map<string, DataFrameRow[]>();
  private readonly currentCandle = new Map<string, { open: number; high: number; low: number; close: number; volume: number; startTime: number }>();

  constructor(config?: Partial<CandleAggregatorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Feed a spot price update for a token.
   * Automatically opens new candles and closes old ones based on the interval.
   */
  update(token: string, price: number, volume: number = 0, timestamp: number = Date.now()): void {
    const current = this.currentCandle.get(token);
    const intervalStart = Math.floor(timestamp / this.config.intervalMs) * this.config.intervalMs;

    if (!current || current.startTime !== intervalStart) {
      // Close the current candle if it exists
      if (current) {
        this.closeCandle(token, current);
      }

      // Fill gaps: if there are missing candle periods, carry forward last close
      if (current && intervalStart > current.startTime + this.config.intervalMs) {
        const gaps = Math.floor((intervalStart - current.startTime) / this.config.intervalMs) - 1;
        const lastClose = current.close;
        for (let i = 1; i <= Math.min(gaps, this.config.maxCandles); i++) {
          this.closeCandle(token, {
            open: lastClose,
            high: lastClose,
            low: lastClose,
            close: lastClose,
            volume: 0,
            startTime: current.startTime + i * this.config.intervalMs,
          });
        }
      }

      // Open new candle
      this.currentCandle.set(token, {
        open: price,
        high: price,
        low: price,
        close: price,
        volume,
        startTime: intervalStart,
      });
    } else {
      // Update current candle
      current.high = Math.max(current.high, price);
      current.low = Math.min(current.low, price);
      current.close = price;
      current.volume += volume;
    }
  }

  /**
   * Get the OHLCV DataFrame for a token, suitable for Freqtrade strategy consumption.
   * Includes closed candles only (current in-progress candle excluded).
   */
  getCandles(token: string): DataFrame {
    return this.candles.get(token) ?? [];
  }

  /**
   * Get candles including the current in-progress candle.
   */
  getCandlesWithCurrent(token: string): DataFrame {
    const closed = this.candles.get(token) ?? [];
    const current = this.currentCandle.get(token);
    if (!current) return closed;
    return [...closed, { open: current.open, high: current.high, low: current.low, close: current.close, volume: current.volume }];
  }

  /** Check if we have enough candles for indicator computation. */
  hasMinimumCandles(token: string, minimum: number): boolean {
    return (this.candles.get(token)?.length ?? 0) >= minimum;
  }

  /** Get the number of closed candles for a token. */
  candleCount(token: string): number {
    return this.candles.get(token)?.length ?? 0;
  }

  /** Reset all candle data. */
  reset(): void {
    this.candles.clear();
    this.currentCandle.clear();
  }

  private closeCandle(token: string, candle: { open: number; high: number; low: number; close: number; volume: number; startTime: number }): void {
    let tokenCandles = this.candles.get(token);
    if (!tokenCandles) {
      tokenCandles = [];
      this.candles.set(token, tokenCandles);
    }

    tokenCandles.push({
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
    });

    // Trim to max candles
    if (tokenCandles.length > this.config.maxCandles) {
      tokenCandles.splice(0, tokenCandles.length - this.config.maxCandles);
    }
  }
}
