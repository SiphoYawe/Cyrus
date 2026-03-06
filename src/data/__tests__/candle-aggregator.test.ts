import { describe, it, expect, beforeEach } from 'vitest';
import { CandleAggregator } from '../candle-aggregator.js';

describe('CandleAggregator', () => {
  let aggregator: CandleAggregator;
  const INTERVAL = 60_000; // 1 minute for easy testing

  beforeEach(() => {
    aggregator = new CandleAggregator({ intervalMs: INTERVAL, maxCandles: 10 });
  });

  it('starts with no candles', () => {
    expect(aggregator.getCandles('ETH')).toEqual([]);
    expect(aggregator.candleCount('ETH')).toBe(0);
  });

  it('accumulates price updates within a single candle', () => {
    const base = Math.floor(Date.now() / INTERVAL) * INTERVAL;
    aggregator.update('ETH', 3000, 10, base + 1000);
    aggregator.update('ETH', 3050, 5, base + 2000);
    aggregator.update('ETH', 2980, 8, base + 3000);
    aggregator.update('ETH', 3020, 3, base + 4000);

    // Current candle not closed yet — getCandles returns empty
    expect(aggregator.getCandles('ETH')).toEqual([]);

    // getCandlesWithCurrent includes the in-progress candle
    const withCurrent = aggregator.getCandlesWithCurrent('ETH');
    expect(withCurrent).toHaveLength(1);
    expect(withCurrent[0].open).toBe(3000);
    expect(withCurrent[0].high).toBe(3050);
    expect(withCurrent[0].low).toBe(2980);
    expect(withCurrent[0].close).toBe(3020);
    expect(withCurrent[0].volume).toBe(26);
  });

  it('closes a candle when a new interval starts', () => {
    const base = Math.floor(Date.now() / INTERVAL) * INTERVAL;

    // Candle 1
    aggregator.update('ETH', 3000, 10, base);
    aggregator.update('ETH', 3100, 5, base + 30_000);

    // Candle 2 — new interval triggers close of candle 1
    aggregator.update('ETH', 3050, 8, base + INTERVAL);

    const candles = aggregator.getCandles('ETH');
    expect(candles).toHaveLength(1);
    expect(candles[0].open).toBe(3000);
    expect(candles[0].high).toBe(3100);
    expect(candles[0].close).toBe(3100);
  });

  it('fills gaps with last close price', () => {
    const base = Math.floor(Date.now() / INTERVAL) * INTERVAL;

    // Candle at base
    aggregator.update('ETH', 3000, 10, base);
    // Skip 2 intervals, update at base + 3*INTERVAL
    aggregator.update('ETH', 3100, 5, base + 3 * INTERVAL);

    // Should have 3 closed candles: original + 2 gaps
    const candles = aggregator.getCandles('ETH');
    expect(candles).toHaveLength(3);
    // Gap candles carry forward last close
    expect(candles[1].open).toBe(3000);
    expect(candles[1].close).toBe(3000);
    expect(candles[1].volume).toBe(0);
    expect(candles[2].open).toBe(3000);
    expect(candles[2].close).toBe(3000);
  });

  it('trims to max candles', () => {
    const base = Math.floor(Date.now() / INTERVAL) * INTERVAL;
    // Create 15 candles (max is 10)
    for (let i = 0; i < 15; i++) {
      aggregator.update('ETH', 3000 + i, 1, base + i * INTERVAL);
    }
    // The 15th update closes candle 14, opens 15
    const candles = aggregator.getCandles('ETH');
    expect(candles.length).toBeLessThanOrEqual(10);
  });

  it('tracks different tokens independently', () => {
    const base = Math.floor(Date.now() / INTERVAL) * INTERVAL;
    aggregator.update('ETH', 3000, 10, base);
    aggregator.update('BTC', 60000, 1, base);

    // New interval
    aggregator.update('ETH', 3100, 5, base + INTERVAL);
    aggregator.update('BTC', 61000, 2, base + INTERVAL);

    expect(aggregator.getCandles('ETH')).toHaveLength(1);
    expect(aggregator.getCandles('BTC')).toHaveLength(1);
    expect(aggregator.getCandles('ETH')[0].open).toBe(3000);
    expect(aggregator.getCandles('BTC')[0].open).toBe(60000);
  });

  it('hasMinimumCandles checks correctly', () => {
    const base = Math.floor(Date.now() / INTERVAL) * INTERVAL;
    for (let i = 0; i < 5; i++) {
      aggregator.update('ETH', 3000 + i, 1, base + i * INTERVAL);
    }
    // 4 closed candles (5th is still open)
    expect(aggregator.hasMinimumCandles('ETH', 4)).toBe(true);
    expect(aggregator.hasMinimumCandles('ETH', 5)).toBe(false);
  });

  it('reset clears all data', () => {
    const base = Math.floor(Date.now() / INTERVAL) * INTERVAL;
    aggregator.update('ETH', 3000, 10, base);
    aggregator.update('ETH', 3100, 5, base + INTERVAL);

    aggregator.reset();
    expect(aggregator.getCandles('ETH')).toEqual([]);
    expect(aggregator.candleCount('ETH')).toBe(0);
  });
});
