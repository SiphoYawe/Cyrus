// Historical data loader for backtesting — loads CSV/JSON price data with lookahead prevention

import { readFile, readdir } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { createLogger } from '../utils/logger.js';
import { LookaheadError } from './errors.js';
import type { HistoricalDataPoint } from './types.js';

// CoinGecko token ID mapping for common tokens
const COINGECKO_TOKEN_MAP: Record<string, string> = {
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 'usd-coin',      // USDC (Ethereum)
  '0xdac17f958d2ee523a2206206994597c13d831ec7': 'tether',          // USDT (Ethereum)
  '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': 'weth',            // WETH (Ethereum)
  '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599': 'wrapped-bitcoin',  // WBTC
};

const logger = createLogger('historical-data-loader');

/**
 * Loads and indexes historical price/volume/apy data for backtesting.
 *
 * Provides O(1) lookups by token+chain key and supports strict lookahead
 * prevention via an internal cursor that limits data access to timestamps
 * at or before the current simulated time.
 */
export class HistoricalDataLoader {
  /** All loaded data points, sorted by timestamp ascending */
  private dataPoints: HistoricalDataPoint[] = [];

  /**
   * Index: `${chainId}-${token}` -> sorted array of { timestamp, index }
   * Allows binary search for closest-prior-timestamp lookups.
   */
  private index: Map<string, HistoricalDataPoint[]> = new Map();

  /** Current cursor timestamp — getPrice() rejects requests beyond this */
  private cursor: number = Infinity;

  // --- Loading methods ---

  /**
   * Load historical data from a CSV file.
   * Expected columns: timestamp, token, chainId, price, volume, apy (optional)
   */
  async loadFromCsv(filePath: string): Promise<HistoricalDataPoint[]> {
    logger.debug({ filePath }, 'Loading CSV data');
    const content = await readFile(filePath, 'utf-8');
    const lines = content.trim().split('\n');

    if (lines.length === 0) {
      return [];
    }

    const headerLine = lines[0].trim();
    const headers = headerLine.split(',').map((h) => h.trim().toLowerCase());

    // Validate required columns
    const requiredCols = ['timestamp', 'token', 'chainid', 'price', 'volume'];
    for (const col of requiredCols) {
      if (!headers.includes(col)) {
        throw new Error(`CSV file ${filePath} missing required column: ${col}`);
      }
    }

    const timestampIdx = headers.indexOf('timestamp');
    const tokenIdx = headers.indexOf('token');
    const chainIdIdx = headers.indexOf('chainid');
    const priceIdx = headers.indexOf('price');
    const volumeIdx = headers.indexOf('volume');
    const apyIdx = headers.indexOf('apy');

    const points: HistoricalDataPoint[] = [];

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line === '') continue;

      const cols = line.split(',').map((c) => c.trim());
      const timestamp = Number(cols[timestampIdx]);
      const token = cols[tokenIdx];
      const chainId = Number(cols[chainIdIdx]);
      const price = Number(cols[priceIdx]);
      const volume = Number(cols[volumeIdx]);
      const apy = apyIdx >= 0 && cols[apyIdx] !== '' && cols[apyIdx] !== undefined
        ? Number(cols[apyIdx])
        : undefined;

      if (isNaN(timestamp) || isNaN(chainId) || isNaN(price) || isNaN(volume)) {
        logger.warn({ line: i + 1, filePath }, 'Skipping line with invalid numeric values');
        continue;
      }

      if (!token) {
        logger.warn({ line: i + 1, filePath }, 'Skipping line with missing token');
        continue;
      }

      points.push({ timestamp, token, chainId, price, volume, apy });
    }

    this.addDataPoints(points);
    logger.info({ filePath, count: points.length }, 'CSV data loaded');
    return points;
  }

  /**
   * Load historical data from a JSON file.
   * Expected: array of HistoricalDataPoint objects.
   */
  async loadFromJson(filePath: string): Promise<HistoricalDataPoint[]> {
    logger.debug({ filePath }, 'Loading JSON data');
    const content = await readFile(filePath, 'utf-8');
    const parsed: unknown = JSON.parse(content);

    if (!Array.isArray(parsed)) {
      throw new Error(`JSON file ${filePath} must contain an array`);
    }

    const points: HistoricalDataPoint[] = [];
    for (const item of parsed) {
      const obj = item as Record<string, unknown>;

      if (
        typeof obj.timestamp !== 'number' ||
        typeof obj.token !== 'string' ||
        typeof obj.chainId !== 'number' ||
        typeof obj.price !== 'number' ||
        typeof obj.volume !== 'number'
      ) {
        logger.warn({ item }, 'Skipping invalid data point in JSON');
        continue;
      }

      points.push({
        timestamp: obj.timestamp,
        token: obj.token,
        chainId: obj.chainId,
        price: obj.price,
        volume: obj.volume,
        apy: typeof obj.apy === 'number' ? obj.apy : undefined,
      });
    }

    this.addDataPoints(points);
    logger.info({ filePath, count: points.length }, 'JSON data loaded');
    return points;
  }

  /**
   * Load all CSV and JSON files from a directory, merge and sort by timestamp.
   */
  async loadDirectory(dirPath: string): Promise<HistoricalDataPoint[]> {
    logger.debug({ dirPath }, 'Loading directory');
    const entries = await readdir(dirPath);
    const allPoints: HistoricalDataPoint[] = [];

    for (const entry of entries) {
      const ext = extname(entry).toLowerCase();
      const fullPath = join(dirPath, entry);

      if (ext === '.csv') {
        const points = await this.loadFromCsv(fullPath);
        allPoints.push(...points);
      } else if (ext === '.json') {
        const points = await this.loadFromJson(fullPath);
        allPoints.push(...points);
      }
    }

    logger.info({ dirPath, totalPoints: allPoints.length }, 'Directory loaded');
    return allPoints;
  }

  // --- Querying methods ---

  /**
   * Get the price for a token on a chain at or before the given timestamp.
   *
   * Enforces lookahead prevention: if the requested timestamp is beyond
   * the cursor set by advanceTo(), throws LookaheadError.
   *
   * Returns undefined if no data exists at or before the timestamp.
   */
  getPrice(token: string, chainId: number, timestamp: number): number | undefined {
    // Lookahead prevention
    if (timestamp > this.cursor) {
      throw new LookaheadError({
        requestedTimestamp: timestamp,
        cursorTimestamp: this.cursor,
        token,
        chainId,
      });
    }

    const key = `${chainId}-${token}`;
    const points = this.index.get(key);

    if (!points || points.length === 0) {
      return undefined;
    }

    // Binary search for the latest point at or before timestamp
    const idx = this.binarySearchFloor(points, timestamp);
    if (idx < 0) {
      return undefined;
    }

    return points[idx].price;
  }

  /**
   * Get the data range (min and max timestamps) across all loaded data.
   */
  getDataRange(): { start: number; end: number } {
    if (this.dataPoints.length === 0) {
      return { start: 0, end: 0 };
    }

    return {
      start: this.dataPoints[0].timestamp,
      end: this.dataPoints[this.dataPoints.length - 1].timestamp,
    };
  }

  /**
   * Get all data points (for inspection/testing).
   */
  getAllDataPoints(): HistoricalDataPoint[] {
    return [...this.dataPoints];
  }

  // --- Lookahead prevention ---

  /**
   * Advance the internal cursor to the given timestamp.
   * After this call, getPrice() will only return data at or before this timestamp.
   */
  advanceTo(timestamp: number): void {
    this.cursor = timestamp;
  }

  /**
   * Get the current cursor timestamp.
   */
  getCursor(): number {
    return this.cursor;
  }

  // --- Internal methods ---

  /**
   * Add data points and rebuild the index.
   */
  private addDataPoints(points: HistoricalDataPoint[]): void {
    this.dataPoints.push(...points);
    // Sort all data by timestamp ascending
    this.dataPoints.sort((a, b) => a.timestamp - b.timestamp);
    this.buildIndex();

    // Check for gaps (warning only)
    this.checkForGaps();
  }

  /**
   * Build the index: Map<"chainId-token", sorted HistoricalDataPoint[]>
   */
  private buildIndex(): void {
    this.index.clear();

    for (const point of this.dataPoints) {
      const key = `${point.chainId}-${point.token}`;
      let arr = this.index.get(key);
      if (!arr) {
        arr = [];
        this.index.set(key, arr);
      }
      arr.push(point);
    }

    // Each array is already sorted since dataPoints is sorted
  }

  /**
   * Binary search: find the index of the last element with timestamp <= target.
   * Returns -1 if no such element exists.
   */
  private binarySearchFloor(points: HistoricalDataPoint[], target: number): number {
    let lo = 0;
    let hi = points.length - 1;
    let result = -1;

    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (points[mid].timestamp <= target) {
        result = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    return result;
  }

  /**
   * Warn about gaps in timestamp coverage per token/chain.
   */
  private checkForGaps(): void {
    for (const [key, points] of this.index) {
      if (points.length < 2) continue;

      // Calculate average interval
      const intervals: number[] = [];
      for (let i = 1; i < points.length; i++) {
        intervals.push(points[i].timestamp - points[i - 1].timestamp);
      }
      const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;

      // Warn if any gap is > 3x the average
      for (let i = 1; i < points.length; i++) {
        const gap = points[i].timestamp - points[i - 1].timestamp;
        if (gap > avgInterval * 3) {
          logger.warn(
            { key, gapStart: points[i - 1].timestamp, gapEnd: points[i].timestamp, gapMs: gap },
            'Large gap in historical data',
          );
        }
      }
    }
  }

  /**
   * Load data points directly (for testing without filesystem).
   */
  loadDirect(points: HistoricalDataPoint[]): void {
    this.addDataPoints(points);
  }

  // --- CoinGecko historical data fetching ---

  /**
   * Fetch historical OHLC data from CoinGecko for a token.
   *
   * @param tokenAddress - EVM token contract address
   * @param chainId - EVM chain ID
   * @param days - Number of days of history (max 365 for free tier)
   * @param coingeckoId - Optional CoinGecko token ID override
   */
  async fetchFromCoinGecko(
    tokenAddress: string,
    chainId: number,
    days: number = 30,
    coingeckoId?: string,
  ): Promise<HistoricalDataPoint[]> {
    const id = coingeckoId ?? COINGECKO_TOKEN_MAP[tokenAddress.toLowerCase()];
    if (!id) {
      throw new Error(
        `No CoinGecko ID found for token ${tokenAddress}. Pass coingeckoId explicitly.`,
      );
    }

    const url = `https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=${days}`;

    logger.info({ tokenAddress, chainId, coingeckoId: id, days }, 'Fetching CoinGecko historical data');

    const response = await fetch(url, {
      headers: { 'Accept': 'application/json' },
    });

    if (!response.ok) {
      throw new Error(`CoinGecko API error: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as {
      prices: [number, number][];
      total_volumes: [number, number][];
    };

    if (!data.prices || !Array.isArray(data.prices)) {
      throw new Error('CoinGecko response missing prices array');
    }

    // Build volume lookup (timestamps may not perfectly align)
    const volumeMap = new Map<number, number>();
    if (data.total_volumes) {
      for (const [ts, vol] of data.total_volumes) {
        volumeMap.set(ts, vol);
      }
    }

    const points: HistoricalDataPoint[] = data.prices.map(([timestamp, price]) => ({
      timestamp,
      token: tokenAddress,
      chainId,
      price,
      volume: volumeMap.get(timestamp) ?? 0,
    }));

    this.addDataPoints(points);
    logger.info({ tokenAddress, chainId, count: points.length }, 'CoinGecko data loaded');
    return points;
  }

  // --- Multi-token data alignment ---

  /**
   * Align multiple token time series to shared timestamps via forward-fill.
   *
   * Given a set of token+chain keys, produces a unified set of timestamps
   * where every key has a price at every timestamp. Missing prices are
   * forward-filled from the most recent available value.
   *
   * @param keys - Array of `${chainId}-${token}` keys to align
   * @param intervalMs - Desired interval between aligned timestamps
   * @returns Map of key → aligned HistoricalDataPoint[]
   */
  alignTimeSeries(
    keys: string[],
    intervalMs: number = 3600_000, // default 1 hour
  ): Map<string, HistoricalDataPoint[]> {
    // Find the global start and end across all requested keys
    let globalStart = Infinity;
    let globalEnd = -Infinity;

    for (const key of keys) {
      const points = this.index.get(key);
      if (!points || points.length === 0) continue;
      globalStart = Math.min(globalStart, points[0].timestamp);
      globalEnd = Math.max(globalEnd, points[points.length - 1].timestamp);
    }

    if (globalStart === Infinity || globalEnd === -Infinity) {
      return new Map(keys.map((k) => [k, []]));
    }

    // Generate aligned timestamps
    const timestamps: number[] = [];
    for (let t = globalStart; t <= globalEnd; t += intervalMs) {
      timestamps.push(t);
    }

    const result = new Map<string, HistoricalDataPoint[]>();

    for (const key of keys) {
      const points = this.index.get(key);
      if (!points || points.length === 0) {
        result.set(key, []);
        continue;
      }

      const [chainIdStr, token] = key.split('-', 2);
      const chainIdNum = Number(chainIdStr);
      const aligned: HistoricalDataPoint[] = [];

      let lastIdx = -1;
      for (const ts of timestamps) {
        // Binary search for latest point at or before ts
        const idx = this.binarySearchFloor(points, ts);
        if (idx >= 0) {
          lastIdx = idx;
        }

        if (lastIdx >= 0) {
          aligned.push({
            timestamp: ts,
            token,
            chainId: chainIdNum,
            price: points[lastIdx].price,
            volume: points[lastIdx].volume,
            apy: points[lastIdx].apy,
          });
        }
      }

      result.set(key, aligned);
    }

    logger.debug(
      { keys: keys.length, timestamps: timestamps.length, intervalMs },
      'Time series aligned',
    );

    return result;
  }
}
