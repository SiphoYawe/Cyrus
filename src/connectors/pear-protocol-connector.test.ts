import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PearProtocolConnector } from './pear-protocol-connector.js';
import type {
  PearPair,
  PearPosition,
  SpreadData,
  PearMargin,
  PearOrderResult,
} from './pear-protocol-connector.js';
import { Store } from '../core/store.js';

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

function createMockResponse<T>(data: T, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    statusText: ok ? 'OK' : 'Internal Server Error',
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  } as unknown as Response;
}

// Standard mock for Hyperliquid metaAndAssetCtxs
const mockMetaAndAssetCtxs = [
  { universe: [{ name: 'BTC' }, { name: 'ETH' }, { name: 'SOL' }, { name: 'ARB' }, { name: 'OP' }, { name: 'DOGE' }, { name: 'SHIB' }, { name: 'AVAX' }, { name: 'LINK' }, { name: 'UNI' }] },
  [
    { markPx: '60000.00', openInterest: '1000', funding: '0.0001' },
    { markPx: '3000.00', openInterest: '5000', funding: '0.0001' },
    { markPx: '100.00', openInterest: '3000', funding: '0.0001' },
    { markPx: '1.20', openInterest: '2000', funding: '0.0001' },
    { markPx: '2.50', openInterest: '1500', funding: '0.0001' },
    { markPx: '0.15', openInterest: '1000', funding: '0.0001' },
    { markPx: '0.00002', openInterest: '500', funding: '0.0001' },
    { markPx: '35.00', openInterest: '2000', funding: '0.0001' },
    { markPx: '15.00', openInterest: '1000', funding: '0.0001' },
    { markPx: '8.00', openInterest: '800', funding: '0.0001' },
  ],
];

describe('PearProtocolConnector', () => {
  let connector: PearProtocolConnector;

  beforeEach(() => {
    Store.getInstance().reset();
    mockFetch.mockReset();
    connector = new PearProtocolConnector({ walletAddress: '0x1234' });
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
      mockFetch.mockResolvedValueOnce(createMockResponse(mockMetaAndAssetCtxs));
      const pairs = await connector.queryPairs();
      expect(Array.isArray(pairs)).toBe(true);
      expect(pairs.length).toBeGreaterThan(0);
    });

    it('returns pairs with required fields', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse(mockMetaAndAssetCtxs));
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
      // Clearinghouse state call
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          assetPositions: [],
          marginSummary: { totalMarginUsed: '0', totalRawUsd: '0', withdrawable: '0' },
        }),
      );
      // Prices call
      mockFetch.mockResolvedValueOnce(createMockResponse(mockMetaAndAssetCtxs));

      const positions = await connector.queryPositions();
      expect(Array.isArray(positions)).toBe(true);
      expect(positions).toHaveLength(0);
    });
  });

  describe('querySpreadData', () => {
    it('returns spread data for a pair', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse(mockMetaAndAssetCtxs));
      const data = await connector.querySpreadData('ETH-BTC');
      expect(typeof data.currentSpread).toBe('number');
      expect(typeof data.historicalMean).toBe('number');
      expect(typeof data.standardDeviation).toBe('number');
      expect(typeof data.zScore).toBe('number');
      expect(typeof data.correlation).toBe('number');
      expect(typeof data.dataPoints).toBe('number');
    });

    it('returns data with all required fields present', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse(mockMetaAndAssetCtxs));
      const data = await connector.querySpreadData('SOL-ETH');
      expect(data.dataPoints).toBeGreaterThan(0);
      expect(data.correlation).toBeGreaterThanOrEqual(-1);
      expect(data.correlation).toBeLessThanOrEqual(1);
    });
  });

  describe('queryMargin', () => {
    it('returns margin info with all required fields', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          marginSummary: {
            totalMarginUsed: '1000.00',
            totalRawUsd: '6000.00',
            withdrawable: '5000.00',
          },
        }),
      );

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
      // 1. Meta call
      mockFetch.mockResolvedValueOnce(
        createMockResponse({ universe: [{ name: 'BTC' }, { name: 'ETH' }] }),
      );
      // 2. Prices call
      mockFetch.mockResolvedValueOnce(createMockResponse(mockMetaAndAssetCtxs));
      // 3. Exchange call
      mockFetch.mockResolvedValueOnce(createMockResponse({ status: 'ok' }));

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
      mockFetch.mockResolvedValueOnce(
        createMockResponse({ universe: [{ name: 'BTC' }, { name: 'ETH' }, { name: 'SOL' }] }),
      );
      mockFetch.mockResolvedValueOnce(createMockResponse(mockMetaAndAssetCtxs));
      mockFetch.mockResolvedValueOnce(createMockResponse({ status: 'ok' }));

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
    it('returns error for non-existent position', async () => {
      const result = await connector.closePairTrade('test-position-id');
      expect(result.status).toBe('error');
      expect(result.error).toContain('not found');
    });

    it('closes an opened position successfully', async () => {
      // Open a position first
      mockFetch.mockResolvedValueOnce(
        createMockResponse({ universe: [{ name: 'BTC' }, { name: 'ETH' }] }),
      );
      mockFetch.mockResolvedValueOnce(createMockResponse(mockMetaAndAssetCtxs));
      mockFetch.mockResolvedValueOnce(createMockResponse({ status: 'ok' }));

      const openResult = await connector.openPairTrade('ETH-BTC', '1.0', '0.5', 3);
      expect(openResult.status).toBe('ok');
      const posId = openResult.positionId!;

      // Close it
      // Meta call
      mockFetch.mockResolvedValueOnce(
        createMockResponse({ universe: [{ name: 'BTC' }, { name: 'ETH' }] }),
      );
      // Prices call
      mockFetch.mockResolvedValueOnce(createMockResponse(mockMetaAndAssetCtxs));
      // Exchange call
      mockFetch.mockResolvedValueOnce(createMockResponse({ status: 'ok' }));

      const closeResult = await connector.closePairTrade(posId);
      expect(closeResult.status).toBe('ok');
      expect(closeResult.positionId).toBe(posId);
    });
  });
});
