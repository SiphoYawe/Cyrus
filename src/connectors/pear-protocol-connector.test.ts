import { describe, it, expect, beforeEach } from 'vitest';
import { PearProtocolConnector } from './pear-protocol-connector.js';
import type {
  PearPair,
  PearPosition,
  SpreadData,
  PearMargin,
  PearOrderResult,
} from './pear-protocol-connector.js';
import { Store } from '../core/store.js';

describe('PearProtocolConnector', () => {
  let connector: PearProtocolConnector;

  beforeEach(() => {
    Store.getInstance().reset();
    connector = new PearProtocolConnector();
  });

  describe('initialization', () => {
    it('creates connector with default config', () => {
      expect(connector).toBeDefined();
      expect(connector.isConnected).toBe(false);
    });

    it('creates connector with custom config', () => {
      const custom = new PearProtocolConnector({
        apiUrl: 'https://custom.pear.api',
        apiKey: 'test-key',
      });
      expect(custom).toBeDefined();
      expect(custom.isConnected).toBe(false);
    });

    it('connects and disconnects', async () => {
      await connector.connect();
      expect(connector.isConnected).toBe(true);
      await connector.disconnect();
      expect(connector.isConnected).toBe(false);
    });
  });

  describe('queryPairs', () => {
    it('returns array of available pairs', async () => {
      const pairs = await connector.queryPairs();
      expect(Array.isArray(pairs)).toBe(true);
      expect(pairs.length).toBeGreaterThan(0);
    });

    it('returns pairs with required fields', async () => {
      const pairs = await connector.queryPairs();
      const pair = pairs[0]!;
      expect(pair.id).toBeDefined();
      expect(pair.symbolA).toBeDefined();
      expect(pair.symbolB).toBeDefined();
      expect(typeof pair.spreadMean).toBe('number');
      expect(typeof pair.spreadStdDev).toBe('number');
      expect(typeof pair.currentSpread).toBe('number');
      expect(typeof pair.correlation).toBe('number');
    });
  });

  describe('queryPositions', () => {
    it('returns array of positions (empty by default)', async () => {
      const positions = await connector.queryPositions();
      expect(Array.isArray(positions)).toBe(true);
      expect(positions).toHaveLength(0);
    });
  });

  describe('querySpreadData', () => {
    it('returns spread data for a pair', async () => {
      const data = await connector.querySpreadData('ETH-BTC');
      expect(typeof data.currentSpread).toBe('number');
      expect(typeof data.historicalMean).toBe('number');
      expect(typeof data.standardDeviation).toBe('number');
      expect(typeof data.zScore).toBe('number');
      expect(typeof data.correlation).toBe('number');
      expect(typeof data.dataPoints).toBe('number');
    });

    it('returns data with all required fields present', async () => {
      const data = await connector.querySpreadData('SOL-ETH');
      expect(data.dataPoints).toBeGreaterThan(0);
      expect(data.correlation).toBeGreaterThanOrEqual(-1);
      expect(data.correlation).toBeLessThanOrEqual(1);
    });
  });

  describe('queryMargin', () => {
    it('returns margin info with all required fields', async () => {
      const margin = await connector.queryMargin();
      expect(typeof margin.available).toBe('number');
      expect(typeof margin.used).toBe('number');
      expect(typeof margin.total).toBe('number');
      expect(typeof margin.utilizationPercent).toBe('number');
      expect(margin.available).toBeGreaterThanOrEqual(0);
      expect(margin.total).toBeGreaterThanOrEqual(margin.used);
    });
  });

  describe('openPairTrade', () => {
    it('returns success result with positionId', async () => {
      const result = await connector.openPairTrade(
        'ETH-BTC',
        '100.000000',
        '100.000000',
        3,
      );
      expect(result.status).toBe('ok');
      expect(result.positionId).toBeDefined();
      expect(typeof result.positionId).toBe('string');
    });

    it('accepts different leverage values', async () => {
      const result = await connector.openPairTrade(
        'SOL-ETH',
        '50.000000',
        '50.000000',
        5,
      );
      expect(result.status).toBe('ok');
    });
  });

  describe('closePairTrade', () => {
    it('returns success result on close', async () => {
      const result = await connector.closePairTrade('test-position-id');
      expect(result.status).toBe('ok');
    });

    it('returns positionId in result', async () => {
      const result = await connector.closePairTrade('pos-123');
      expect(result.positionId).toBeDefined();
    });
  });
});
