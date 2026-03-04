import { describe, it, expect, beforeEach, vi } from 'vitest';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HistoricalDataLoader } from '../historical-data-loader.js';
import { LookaheadError } from '../errors.js';
import { Store } from '../../core/store.js';

describe('HistoricalDataLoader', () => {
  let loader: HistoricalDataLoader;

  beforeEach(() => {
    Store.getInstance().reset();
    loader = new HistoricalDataLoader();
  });

  // --- Direct loading ---

  describe('loadDirect', () => {
    it('loads data points and sorts by timestamp', () => {
      loader.loadDirect([
        { timestamp: 3000, token: 'USDC', chainId: 1, price: 1.0, volume: 100 },
        { timestamp: 1000, token: 'USDC', chainId: 1, price: 0.99, volume: 50 },
        { timestamp: 2000, token: 'USDC', chainId: 1, price: 1.01, volume: 75 },
      ]);

      const all = loader.getAllDataPoints();
      expect(all).toHaveLength(3);
      expect(all[0].timestamp).toBe(1000);
      expect(all[1].timestamp).toBe(2000);
      expect(all[2].timestamp).toBe(3000);
    });
  });

  // --- CSV parsing ---

  describe('loadFromCsv', () => {
    let testDir: string;

    beforeEach(async () => {
      testDir = join(tmpdir(), `hdl-test-csv-${Date.now()}`);
      await mkdir(testDir, { recursive: true });
    });

    it('parses a valid CSV file correctly', async () => {
      const csv = `timestamp,token,chainId,price,volume,apy
1000,USDC,1,1.00,50000,
2000,USDC,1,1.01,60000,5.2
3000,WETH,1,2500.00,10000,`;

      const filePath = join(testDir, 'test.csv');
      await writeFile(filePath, csv);

      const points = await loader.loadFromCsv(filePath);

      expect(points).toHaveLength(3);
      expect(points[0].token).toBe('USDC');
      expect(points[0].price).toBe(1.0);
      expect(points[0].volume).toBe(50000);
      expect(points[0].apy).toBeUndefined();
      expect(points[1].apy).toBe(5.2);
      expect(points[2].token).toBe('WETH');
      expect(points[2].price).toBe(2500.0);
    });

    it('throws when required columns are missing', async () => {
      const csv = `timestamp,token,price
1000,USDC,1.00`;

      const filePath = join(testDir, 'bad.csv');
      await writeFile(filePath, csv);

      await expect(loader.loadFromCsv(filePath)).rejects.toThrow('missing required column');
    });

    it('returns empty array for CSV with only headers', async () => {
      const csv = `timestamp,token,chainId,price,volume`;

      const filePath = join(testDir, 'empty.csv');
      await writeFile(filePath, csv);

      const points = await loader.loadFromCsv(filePath);
      expect(points).toHaveLength(0);
    });

    it('skips lines with invalid numeric values', async () => {
      const csv = `timestamp,token,chainId,price,volume
1000,USDC,1,1.00,50000
invalid,USDC,1,1.00,50000
2000,USDC,1,1.01,60000`;

      const filePath = join(testDir, 'partial.csv');
      await writeFile(filePath, csv);

      const points = await loader.loadFromCsv(filePath);
      expect(points).toHaveLength(2);
    });
  });

  // --- JSON parsing ---

  describe('loadFromJson', () => {
    let testDir: string;

    beforeEach(async () => {
      testDir = join(tmpdir(), `hdl-test-json-${Date.now()}`);
      await mkdir(testDir, { recursive: true });
    });

    it('parses a valid JSON file correctly', async () => {
      const data = [
        { timestamp: 1000, token: 'USDC', chainId: 1, price: 1.0, volume: 50000 },
        { timestamp: 2000, token: 'WETH', chainId: 1, price: 2500, volume: 10000, apy: 3.5 },
      ];

      const filePath = join(testDir, 'test.json');
      await writeFile(filePath, JSON.stringify(data));

      const points = await loader.loadFromJson(filePath);

      expect(points).toHaveLength(2);
      expect(points[0].token).toBe('USDC');
      expect(points[1].apy).toBe(3.5);
    });

    it('throws when JSON is not an array', async () => {
      const filePath = join(testDir, 'bad.json');
      await writeFile(filePath, '{"not": "array"}');

      await expect(loader.loadFromJson(filePath)).rejects.toThrow('must contain an array');
    });

    it('throws on malformed JSON', async () => {
      const filePath = join(testDir, 'malformed.json');
      await writeFile(filePath, 'not json at all');

      await expect(loader.loadFromJson(filePath)).rejects.toThrow();
    });

    it('skips items with missing required fields', async () => {
      const data = [
        { timestamp: 1000, token: 'USDC', chainId: 1, price: 1.0, volume: 50000 },
        { timestamp: 2000, token: 'BAD' }, // missing chainId, price, volume
        { timestamp: 3000, token: 'WETH', chainId: 1, price: 2500, volume: 10000 },
      ];

      const filePath = join(testDir, 'partial.json');
      await writeFile(filePath, JSON.stringify(data));

      const points = await loader.loadFromJson(filePath);
      expect(points).toHaveLength(2);
    });
  });

  // --- Directory loading ---

  describe('loadDirectory', () => {
    let testDir: string;

    beforeEach(async () => {
      testDir = join(tmpdir(), `hdl-test-dir-${Date.now()}`);
      await mkdir(testDir, { recursive: true });
    });

    it('loads both CSV and JSON files from a directory', async () => {
      const csv = `timestamp,token,chainId,price,volume
1000,USDC,1,1.00,50000`;

      const json = [
        { timestamp: 2000, token: 'WETH', chainId: 1, price: 2500, volume: 10000 },
      ];

      await writeFile(join(testDir, 'prices.csv'), csv);
      await writeFile(join(testDir, 'prices.json'), JSON.stringify(json));

      const points = await loader.loadDirectory(testDir);
      expect(points).toHaveLength(2);

      // Should be merged and sorted
      const all = loader.getAllDataPoints();
      expect(all[0].timestamp).toBe(1000);
      expect(all[1].timestamp).toBe(2000);
    });
  });

  // --- getPrice ---

  describe('getPrice', () => {
    beforeEach(() => {
      loader.loadDirect([
        { timestamp: 1000, token: 'USDC', chainId: 1, price: 1.0, volume: 100 },
        { timestamp: 2000, token: 'USDC', chainId: 1, price: 1.01, volume: 200 },
        { timestamp: 3000, token: 'USDC', chainId: 1, price: 0.99, volume: 150 },
        { timestamp: 1000, token: 'WETH', chainId: 1, price: 2500, volume: 50 },
        { timestamp: 2000, token: 'WETH', chainId: 1, price: 2550, volume: 60 },
        { timestamp: 3000, token: 'WETH', chainId: 1, price: 2480, volume: 55 },
      ]);
    });

    it('returns correct price at exact timestamp', () => {
      const price = loader.getPrice('USDC', 1, 2000);
      expect(price).toBe(1.01);
    });

    it('returns closest prior price when exact timestamp is missing', () => {
      const price = loader.getPrice('USDC', 1, 2500);
      expect(price).toBe(1.01); // timestamp 2000, not 3000
    });

    it('returns undefined for timestamps before data range', () => {
      const price = loader.getPrice('USDC', 1, 500);
      expect(price).toBeUndefined();
    });

    it('returns undefined for unknown token', () => {
      const price = loader.getPrice('UNKNOWN', 1, 2000);
      expect(price).toBeUndefined();
    });

    it('returns undefined for unknown chain', () => {
      const price = loader.getPrice('USDC', 999, 2000);
      expect(price).toBeUndefined();
    });

    it('returns price for different tokens independently', () => {
      expect(loader.getPrice('USDC', 1, 2000)).toBe(1.01);
      expect(loader.getPrice('WETH', 1, 2000)).toBe(2550);
    });
  });

  // --- Lookahead prevention ---

  describe('lookahead prevention', () => {
    beforeEach(() => {
      loader.loadDirect([
        { timestamp: 1000, token: 'USDC', chainId: 1, price: 1.0, volume: 100 },
        { timestamp: 2000, token: 'USDC', chainId: 1, price: 1.01, volume: 200 },
        { timestamp: 3000, token: 'USDC', chainId: 1, price: 0.99, volume: 150 },
      ]);
    });

    it('allows access to data at or before cursor', () => {
      loader.advanceTo(2000);
      expect(loader.getPrice('USDC', 1, 1000)).toBe(1.0);
      expect(loader.getPrice('USDC', 1, 2000)).toBe(1.01);
    });

    it('throws LookaheadError when requesting data beyond cursor', () => {
      loader.advanceTo(2000);

      expect(() => loader.getPrice('USDC', 1, 2500)).toThrow(LookaheadError);
    });

    it('LookaheadError includes correct timestamps', () => {
      loader.advanceTo(2000);

      try {
        loader.getPrice('USDC', 1, 3000);
        expect.fail('Should have thrown LookaheadError');
      } catch (error) {
        expect(error).toBeInstanceOf(LookaheadError);
        const lookahead = error as LookaheadError;
        expect(lookahead.requestedTimestamp).toBe(3000);
        expect(lookahead.cursorTimestamp).toBe(2000);
      }
    });

    it('cursor defaults to Infinity (no restriction)', () => {
      // No advanceTo called — should allow all timestamps
      expect(loader.getPrice('USDC', 1, 3000)).toBe(0.99);
    });

    it('advanceTo updates cursor', () => {
      loader.advanceTo(1500);
      expect(loader.getCursor()).toBe(1500);

      loader.advanceTo(2500);
      expect(loader.getCursor()).toBe(2500);
    });
  });

  // --- getDataRange ---

  describe('getDataRange', () => {
    it('returns correct range for loaded data', () => {
      loader.loadDirect([
        { timestamp: 1000, token: 'USDC', chainId: 1, price: 1.0, volume: 100 },
        { timestamp: 5000, token: 'USDC', chainId: 1, price: 1.0, volume: 100 },
        { timestamp: 3000, token: 'WETH', chainId: 1, price: 2500, volume: 50 },
      ]);

      const range = loader.getDataRange();
      expect(range.start).toBe(1000);
      expect(range.end).toBe(5000);
    });

    it('returns zeros for empty dataset', () => {
      const range = loader.getDataRange();
      expect(range.start).toBe(0);
      expect(range.end).toBe(0);
    });
  });
});
