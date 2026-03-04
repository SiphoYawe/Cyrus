import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HyperliquidConnector } from './hyperliquid-connector.js';
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
  } as unknown as Response;
}

describe('HyperliquidConnector', () => {
  let connector: HyperliquidConnector;

  beforeEach(() => {
    Store.getInstance().reset();
    mockFetch.mockReset();
    connector = new HyperliquidConnector({
      walletAddress: '0x1234567890abcdef1234567890abcdef12345678',
    });
  });

  describe('initialization', () => {
    it('creates connector with default config', () => {
      expect(connector).toBeDefined();
      expect(connector.isConnected).toBe(false);
    });

    it('connects and disconnects', async () => {
      await connector.connect();
      expect(connector.isConnected).toBe(true);
      await connector.disconnect();
      expect(connector.isConnected).toBe(false);
    });
  });

  describe('queryBalance', () => {
    it('returns parsed balance from API response', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          marginSummary: {
            totalMarginUsed: '1000.50',
            totalNtlPos: '5000.00',
            totalRawUsd: '10000.00',
            withdrawable: '4000.00',
          },
          crossMarginSummary: {
            accountValue: '10000.00',
            totalMarginUsed: '1000.50',
            totalNtlPos: '5000.00',
          },
        }),
      );

      const balance = await connector.queryBalance();
      expect(balance.totalMarginUsed).toBe(1000.5);
      expect(balance.withdrawable).toBe(4000);
      expect(balance.crossMarginSummary.accountValue).toBe(10000);
    });

    it('handles missing fields gracefully', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          marginSummary: {},
          crossMarginSummary: {},
        }),
      );

      const balance = await connector.queryBalance();
      expect(balance.totalMarginUsed).toBe(0);
      expect(balance.withdrawable).toBe(0);
    });
  });

  describe('queryPositions', () => {
    it('returns parsed positions', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          assetPositions: [
            {
              position: {
                coin: 'ETH',
                szi: '1.5',
                leverage: { type: 'cross', value: 10 },
                entryPx: '3000.00',
                positionValue: '4500.00',
                unrealizedPnl: '150.00',
                returnOnEquity: '0.033',
                liquidationPx: '2700.00',
                marginUsed: '450.00',
              },
            },
          ],
        }),
      );

      const positions = await connector.queryPositions();
      expect(positions).toHaveLength(1);
      expect(positions[0].coin).toBe('ETH');
      expect(positions[0].szi).toBe('1.5');
      expect(positions[0].leverage.value).toBe(10);
    });

    it('returns empty array when no positions', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse({ assetPositions: [] }));
      const positions = await connector.queryPositions();
      expect(positions).toHaveLength(0);
    });
  });

  describe('queryFundingRates', () => {
    it('returns funding rate map', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse([
          { coin: 'ETH', fundingRate: '0.0001', premium: '0.00005', time: Date.now() },
          { coin: 'BTC', fundingRate: '-0.0002', premium: '-0.00010', time: Date.now() },
        ]),
      );

      const rates = await connector.queryFundingRates();
      expect(rates.size).toBe(2);
      expect(rates.get('ETH')?.fundingRate).toBe('0.0001');
      expect(rates.get('BTC')?.fundingRate).toBe('-0.0002');
    });
  });

  describe('queryOpenInterest', () => {
    it('returns open interest map', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse([
          { coin: 'ETH', openInterest: '50000000' },
          { coin: 'BTC', openInterest: '100000000' },
        ]),
      );

      const oi = await connector.queryOpenInterest();
      expect(oi.size).toBe(2);
      expect(oi.get('ETH')?.openInterest).toBe('50000000');
    });
  });

  describe('queryOrderBook', () => {
    it('returns parsed order book with bids and asks', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          levels: [
            [
              { px: '3000.00', sz: '10.5', n: 3 },
              { px: '2999.50', sz: '5.0', n: 2 },
            ],
            [
              { px: '3000.50', sz: '8.0', n: 4 },
              { px: '3001.00', sz: '3.0', n: 1 },
            ],
          ],
        }),
      );

      const ob = await connector.queryOrderBook('ETH');
      expect(ob.coin).toBe('ETH');
      expect(ob.bids).toHaveLength(2);
      expect(ob.asks).toHaveLength(2);
      expect(ob.bids[0].price).toBe(3000);
      expect(ob.asks[0].price).toBe(3000.5);
    });
  });

  describe('placeMarketOrder', () => {
    it('returns order result for market order', async () => {
      const result = await connector.placeMarketOrder('ETH', 'long', '1.5', 10);
      expect(result.status).toBe('ok');
      expect(result.orderId).toBeDefined();
    });
  });

  describe('placeLimitOrder', () => {
    it('returns order result for limit order', async () => {
      const result = await connector.placeLimitOrder(
        'ETH',
        'short',
        '2.0',
        '3100.00',
        5,
        'GTC',
      );
      expect(result.status).toBe('ok');
      expect(result.orderId).toBeDefined();
    });
  });

  describe('cancelOrder', () => {
    it('returns true on successful cancellation', async () => {
      const result = await connector.cancelOrder('ETH', 12345);
      expect(result).toBe(true);
    });
  });

  describe('closePosition', () => {
    it('returns order result on close', async () => {
      const result = await connector.closePosition('ETH');
      expect(result.status).toBe('ok');
    });
  });

  describe('API error handling', () => {
    it('throws HyperliquidApiError on non-ok response', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse(null, false));
      await expect(connector.queryBalance()).rejects.toThrow('Hyperliquid API error');
    });

    it('thrown error is instance of HyperliquidApiError', async () => {
      const { HyperliquidApiError } = await import('../utils/errors.js');
      mockFetch.mockResolvedValueOnce(createMockResponse(null, false));
      await expect(connector.queryBalance()).rejects.toBeInstanceOf(HyperliquidApiError);
    });
  });

  describe('decimal conversion', () => {
    it('handles deposit and withdrawal', async () => {
      const depositResult = await connector.depositToMargin('1000.00');
      expect(depositResult).toBe(true);

      const withdrawResult = await connector.withdrawFromMargin('500.00');
      expect(withdrawResult).toBe(true);
    });
  });
});
