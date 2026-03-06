import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HyperliquidConnector } from './hyperliquid-connector.js';
import { Store } from '../core/store.js';
import type { HyperliquidSignerFn } from './hyperliquid-types.js';

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

  // ---------------------------------------------------------------------------
  // EIP-712 signing delegation (Task 1)
  // ---------------------------------------------------------------------------

  describe('EIP-712 signing delegation', () => {
    it('includes signature in exchange body when signer is provided', async () => {
      const mockSigner: HyperliquidSignerFn = vi.fn().mockResolvedValue('0xdeadbeef');
      const signedConnector = new HyperliquidConnector({
        walletAddress: '0x1234567890abcdef1234567890abcdef12345678',
        signer: mockSigner,
      });

      // deposit calls exchange endpoint
      mockFetch.mockResolvedValueOnce(createMockResponse({ status: 'ok' }));

      await signedConnector.depositToMargin('100.00');

      expect(mockSigner).toHaveBeenCalledTimes(1);
      // Verify the signer was called with the action and a nonce
      const [action, nonce] = (mockSigner as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(action.type).toBe('usdClassTransfer');
      expect(typeof nonce).toBe('number');

      // Verify the request body includes the signature
      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.signature).toBe('0xdeadbeef');
      expect(sentBody.action.type).toBe('usdClassTransfer');
    });

    it('omits signature when no signer is provided (unsigned mode)', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse({ status: 'ok' }));

      await connector.depositToMargin('100.00');

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.signature).toBeUndefined();
      expect(sentBody.vaultAddress).toBeNull();
    });

    it('signer is called for market order exchange request', async () => {
      const mockSigner: HyperliquidSignerFn = vi.fn().mockResolvedValue('0xsig123');
      const signedConnector = new HyperliquidConnector({
        walletAddress: '0x1234567890abcdef1234567890abcdef12345678',
        signer: mockSigner,
      });

      // 1. Meta
      mockFetch.mockResolvedValueOnce(
        createMockResponse({ universe: [{ name: 'BTC' }, { name: 'ETH' }] }),
      );
      // 2. Order book
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          levels: [
            [{ px: '3000.00', sz: '10', n: 1 }],
            [{ px: '3001.00', sz: '10', n: 1 }],
          ],
        }),
      );
      // 3. Set leverage
      mockFetch.mockResolvedValueOnce(createMockResponse({ status: 'ok' }));
      // 4. Exchange order
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          status: 'ok',
          response: {
            type: 'order',
            data: { statuses: [{ filled: { totalSz: '1.0', avgPx: '3001.00', oid: 111 } }] },
          },
        }),
      );

      await signedConnector.placeMarketOrder('ETH', 'long', '1.0', 10);

      // The signer should be called for the exchange request (4th fetch call)
      expect(mockSigner).toHaveBeenCalledTimes(1);
      const exchangeBody = JSON.parse(mockFetch.mock.calls[3][1].body);
      expect(exchangeBody.signature).toBe('0xsig123');
    });

    it('signer is called for cancel order exchange request', async () => {
      const mockSigner: HyperliquidSignerFn = vi.fn().mockResolvedValue('0xcancelsig');
      const signedConnector = new HyperliquidConnector({
        walletAddress: '0x1234567890abcdef1234567890abcdef12345678',
        signer: mockSigner,
      });

      // 1. Meta
      mockFetch.mockResolvedValueOnce(
        createMockResponse({ universe: [{ name: 'BTC' }, { name: 'ETH' }] }),
      );
      // 2. Cancel
      mockFetch.mockResolvedValueOnce(createMockResponse({ status: 'ok' }));

      await signedConnector.cancelOrder('ETH', 999);

      expect(mockSigner).toHaveBeenCalledTimes(1);
      const exchangeBody = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(exchangeBody.signature).toBe('0xcancelsig');
    });

    it('backwards compatible: connector works without signer parameter', () => {
      // This is what existing code does — no signer
      const c = new HyperliquidConnector({
        walletAddress: '0xabc',
      });
      expect(c).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // queryBalance — realistic API response parsing (Task 2)
  // ---------------------------------------------------------------------------

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

    it('parses realistic Hyperliquid clearinghouseState response', async () => {
      // This is a realistic response shape from the Hyperliquid API
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          marginSummary: {
            accountValue: '15234.56',
            totalMarginUsed: '2500.75',
            totalNtlPos: '12500.00',
            totalRawUsd: '15234.56',
            withdrawable: '12733.81',
          },
          crossMarginSummary: {
            accountValue: '15234.56',
            totalMarginUsed: '2500.75',
            totalNtlPos: '12500.00',
          },
          assetPositions: [
            {
              position: {
                coin: 'ETH',
                szi: '2.5',
                leverage: { type: 'cross', value: 5 },
                entryPx: '3100.00',
                positionValue: '7750.00',
                unrealizedPnl: '250.00',
                returnOnEquity: '0.032',
                liquidationPx: '2480.00',
                marginUsed: '1550.00',
              },
            },
          ],
        }),
      );

      const balance = await connector.queryBalance();
      expect(balance.totalMarginUsed).toBe(2500.75);
      expect(balance.totalRawUsd).toBe(15234.56);
      expect(balance.withdrawable).toBe(12733.81);
      expect(balance.crossMarginSummary.accountValue).toBe(15234.56);
    });
  });

  // ---------------------------------------------------------------------------
  // queryPositions — realistic API response parsing (Task 2)
  // ---------------------------------------------------------------------------

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

    it('parses realistic multi-position response', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          assetPositions: [
            {
              position: {
                coin: 'ETH',
                szi: '0.5',
                leverage: { type: 'cross', value: 10 },
                entryPx: '3500.00',
                positionValue: '1750.00',
                unrealizedPnl: '-25.00',
                returnOnEquity: '-0.014',
                liquidationPx: '3150.00',
                marginUsed: '175.00',
              },
            },
            {
              position: {
                coin: 'BTC',
                szi: '-0.02',
                leverage: { type: 'cross', value: 5 },
                entryPx: '62000.00',
                positionValue: '1240.00',
                unrealizedPnl: '80.00',
                returnOnEquity: '0.065',
                liquidationPx: null,
                marginUsed: '248.00',
              },
            },
          ],
        }),
      );

      const positions = await connector.queryPositions();
      expect(positions).toHaveLength(2);
      expect(positions[0].coin).toBe('ETH');
      expect(positions[0].szi).toBe('0.5');
      // Short position has negative szi
      expect(positions[1].coin).toBe('BTC');
      expect(positions[1].szi).toBe('-0.02');
      expect(positions[1].liquidationPx).toBeNull();
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

  // ---------------------------------------------------------------------------
  // placeMarketOrder (Task 2 + Task 3)
  // ---------------------------------------------------------------------------

  describe('placeMarketOrder', () => {
    it('returns order result for market order', async () => {
      // 1. Meta call to get asset index
      mockFetch.mockResolvedValueOnce(
        createMockResponse({ universe: [{ name: 'BTC' }, { name: 'ETH' }] }),
      );
      // 2. Order book call
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          levels: [
            [{ px: '3000.00', sz: '10', n: 1 }],
            [{ px: '3001.00', sz: '10', n: 1 }],
          ],
        }),
      );
      // 3. Set leverage call
      mockFetch.mockResolvedValueOnce(createMockResponse({ status: 'ok' }));
      // 4. Exchange order call
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          status: 'ok',
          response: {
            type: 'order',
            data: {
              statuses: [{ filled: { totalSz: '1.5', avgPx: '3001.00', oid: 12345 } }],
            },
          },
        }),
      );

      const result = await connector.placeMarketOrder('ETH', 'long', '1.5', 10);
      expect(result.status).toBe('ok');
      expect(result.orderId).toBe(12345);
      expect(result.filledSize).toBe('1.5');
    });

    it('parses successful market order fill with correct fields', async () => {
      // 1. Meta
      mockFetch.mockResolvedValueOnce(
        createMockResponse({ universe: [{ name: 'BTC' }, { name: 'ETH' }, { name: 'SOL' }] }),
      );
      // 2. Order book
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          levels: [
            [{ px: '3500.00', sz: '20', n: 5 }],
            [{ px: '3500.50', sz: '15', n: 3 }],
          ],
        }),
      );
      // 3. Leverage
      mockFetch.mockResolvedValueOnce(createMockResponse({ status: 'ok' }));
      // 4. Fill response — realistic Hyperliquid API shape
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          status: 'ok',
          response: {
            type: 'order',
            data: {
              statuses: [
                {
                  filled: {
                    totalSz: '0.1',
                    avgPx: '3500.00',
                    oid: 98765,
                  },
                },
              ],
            },
          },
        }),
      );

      const result = await connector.placeMarketOrder('ETH', 'long', '0.1', 5);
      expect(result.status).toBe('ok');
      expect(result.orderId).toBe(98765);
      expect(result.filledSize).toBe('0.1');
      expect(result.avgPrice).toBe('3500.00');
    });

    it('returns error for market order with insufficient margin', async () => {
      // 1. Meta
      mockFetch.mockResolvedValueOnce(
        createMockResponse({ universe: [{ name: 'BTC' }, { name: 'ETH' }] }),
      );
      // 2. Order book
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          levels: [
            [{ px: '3000.00', sz: '10', n: 1 }],
            [{ px: '3001.00', sz: '10', n: 1 }],
          ],
        }),
      );
      // 3. Leverage
      mockFetch.mockResolvedValueOnce(createMockResponse({ status: 'ok' }));
      // 4. Error response from Hyperliquid
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          status: 'ok',
          response: {
            data: {
              statuses: [{ error: 'insufficient margin' }],
            },
          },
        }),
      );

      const result = await connector.placeMarketOrder('ETH', 'long', '100.0', 20);
      expect(result.status).toBe('error');
      expect(result.error).toBe('insufficient margin');
    });

    it('uses IOC time-in-force for market orders', async () => {
      // 1. Meta
      mockFetch.mockResolvedValueOnce(
        createMockResponse({ universe: [{ name: 'ETH' }] }),
      );
      // 2. Order book
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          levels: [
            [{ px: '3000.00', sz: '10', n: 1 }],
            [{ px: '3001.00', sz: '10', n: 1 }],
          ],
        }),
      );
      // 3. Leverage
      mockFetch.mockResolvedValueOnce(createMockResponse({ status: 'ok' }));
      // 4. Exchange order
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          status: 'ok',
          response: {
            type: 'order',
            data: { statuses: [{ filled: { totalSz: '1.0', avgPx: '3001.00', oid: 1 } }] },
          },
        }),
      );

      await connector.placeMarketOrder('ETH', 'long', '1.0', 5);

      // The exchange call is the 4th fetch call (index 3)
      const exchangeBody = JSON.parse(mockFetch.mock.calls[3][1].body);
      expect(exchangeBody.action.orders[0].t.limit.tif).toBe('Ioc');
    });

    it('sets leverage before placing the order', async () => {
      // 1. Meta
      mockFetch.mockResolvedValueOnce(
        createMockResponse({ universe: [{ name: 'ETH' }] }),
      );
      // 2. Order book
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          levels: [
            [{ px: '3000.00', sz: '10', n: 1 }],
            [{ px: '3001.00', sz: '10', n: 1 }],
          ],
        }),
      );
      // 3. Leverage (this is the updateLeverage call via postInfo)
      mockFetch.mockResolvedValueOnce(createMockResponse({ status: 'ok' }));
      // 4. Exchange
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          status: 'ok',
          response: { type: 'order', data: { statuses: [{ filled: { totalSz: '1.0', avgPx: '3000.00', oid: 1 } }] } },
        }),
      );

      await connector.placeMarketOrder('ETH', 'long', '1.0', 18);

      // The leverage call is the 3rd fetch call (index 2)
      const leverageBody = JSON.parse(mockFetch.mock.calls[2][1].body);
      expect(leverageBody.type).toBe('updateLeverage');
      expect(leverageBody.leverage).toBe(18);
      expect(leverageBody.isCross).toBe(true);
      expect(leverageBody.asset).toBe(0); // ETH is index 0 in the universe
    });
  });

  // ---------------------------------------------------------------------------
  // placeLimitOrder (Task 2 + Task 3)
  // ---------------------------------------------------------------------------

  describe('placeLimitOrder', () => {
    it('returns order result for limit order', async () => {
      // 1. Meta call to get asset index
      mockFetch.mockResolvedValueOnce(
        createMockResponse({ universe: [{ name: 'BTC' }, { name: 'ETH' }] }),
      );
      // 2. Set leverage call
      mockFetch.mockResolvedValueOnce(createMockResponse({ status: 'ok' }));
      // 3. Exchange order call
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          status: 'ok',
          response: {
            type: 'order',
            data: {
              statuses: [{ resting: { oid: 67890 } }],
            },
          },
        }),
      );

      const result = await connector.placeLimitOrder(
        'ETH',
        'short',
        '2.0',
        '3100.00',
        5,
        'GTC',
      );
      expect(result.status).toBe('ok');
      expect(result.orderId).toBe(67890);
    });

    it('uses GTC time-in-force by default', async () => {
      // 1. Meta
      mockFetch.mockResolvedValueOnce(
        createMockResponse({ universe: [{ name: 'ETH' }] }),
      );
      // 2. Leverage
      mockFetch.mockResolvedValueOnce(createMockResponse({ status: 'ok' }));
      // 3. Exchange
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          status: 'ok',
          response: { data: { statuses: [{ resting: { oid: 1 } }] } },
        }),
      );

      await connector.placeLimitOrder('ETH', 'long', '1.0', '3000.00', 5, 'GTC');

      const exchangeBody = JSON.parse(mockFetch.mock.calls[2][1].body);
      expect(exchangeBody.action.orders[0].t.limit.tif).toBe('Gtc');
    });

    it('maps IOC TIF correctly', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse({ universe: [{ name: 'ETH' }] }),
      );
      mockFetch.mockResolvedValueOnce(createMockResponse({ status: 'ok' }));
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          status: 'ok',
          response: { data: { statuses: [{ resting: { oid: 1 } }] } },
        }),
      );

      await connector.placeLimitOrder('ETH', 'long', '1.0', '3000.00', 5, 'IOC');

      const exchangeBody = JSON.parse(mockFetch.mock.calls[2][1].body);
      expect(exchangeBody.action.orders[0].t.limit.tif).toBe('Ioc');
    });

    it('maps FOK TIF to Alo', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse({ universe: [{ name: 'ETH' }] }),
      );
      mockFetch.mockResolvedValueOnce(createMockResponse({ status: 'ok' }));
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          status: 'ok',
          response: { data: { statuses: [{ resting: { oid: 1 } }] } },
        }),
      );

      await connector.placeLimitOrder('ETH', 'long', '1.0', '3000.00', 5, 'FOK');

      const exchangeBody = JSON.parse(mockFetch.mock.calls[2][1].body);
      expect(exchangeBody.action.orders[0].t.limit.tif).toBe('Alo');
    });

    it('limit order that fills immediately returns fill data', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse({ universe: [{ name: 'ETH' }] }),
      );
      mockFetch.mockResolvedValueOnce(createMockResponse({ status: 'ok' }));
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          status: 'ok',
          response: {
            data: {
              statuses: [{
                filled: { oid: 55555, totalSz: '2.0', avgPx: '3050.50' },
              }],
            },
          },
        }),
      );

      const result = await connector.placeLimitOrder('ETH', 'long', '2.0', '3050.50', 5, 'IOC');
      expect(result.status).toBe('ok');
      expect(result.orderId).toBe(55555);
      expect(result.filledSize).toBe('2.0');
      expect(result.avgPrice).toBe('3050.50');
    });

    it('limit order with error status returns error', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse({ universe: [{ name: 'ETH' }] }),
      );
      mockFetch.mockResolvedValueOnce(createMockResponse({ status: 'ok' }));
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          status: 'ok',
          response: {
            data: {
              statuses: [{ error: 'size too small' }],
            },
          },
        }),
      );

      const result = await connector.placeLimitOrder('ETH', 'long', '0.0001', '3000.00', 5, 'GTC');
      expect(result.status).toBe('error');
      expect(result.error).toBe('size too small');
    });
  });

  // ---------------------------------------------------------------------------
  // Asset index mapping (Task 3)
  // ---------------------------------------------------------------------------

  describe('asset index mapping', () => {
    it('maps symbol to correct integer index from meta response', async () => {
      // 1. Meta returns universe with ordered assets
      mockFetch.mockResolvedValueOnce(
        createMockResponse({ universe: [{ name: 'BTC' }, { name: 'ETH' }, { name: 'SOL' }] }),
      );
      // 2. Order book
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          levels: [
            [{ px: '100.00', sz: '10', n: 1 }],
            [{ px: '101.00', sz: '10', n: 1 }],
          ],
        }),
      );
      // 3. Leverage
      mockFetch.mockResolvedValueOnce(createMockResponse({ status: 'ok' }));
      // 4. Exchange
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          status: 'ok',
          response: { type: 'order', data: { statuses: [{ filled: { totalSz: '1.0', avgPx: '101.00', oid: 1 } }] } },
        }),
      );

      await connector.placeMarketOrder('SOL', 'long', '1.0', 5);

      // SOL is at index 2 in the universe
      const exchangeBody = JSON.parse(mockFetch.mock.calls[3][1].body);
      expect(exchangeBody.action.orders[0].a).toBe(2);
    });

    it('caches meta response and reuses for subsequent calls', async () => {
      // First call: meta + orderbook + leverage + exchange
      mockFetch.mockResolvedValueOnce(
        createMockResponse({ universe: [{ name: 'BTC' }, { name: 'ETH' }] }),
      );
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          levels: [[{ px: '3000.00', sz: '10', n: 1 }], [{ px: '3001.00', sz: '10', n: 1 }]],
        }),
      );
      mockFetch.mockResolvedValueOnce(createMockResponse({ status: 'ok' }));
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          status: 'ok',
          response: { type: 'order', data: { statuses: [{ filled: { totalSz: '1.0', avgPx: '3001.00', oid: 1 } }] } },
        }),
      );

      await connector.placeMarketOrder('ETH', 'long', '1.0', 5);

      // Second call: should NOT fetch meta again (only orderbook + leverage + exchange)
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          levels: [[{ px: '60000.00', sz: '10', n: 1 }], [{ px: '60001.00', sz: '10', n: 1 }]],
        }),
      );
      mockFetch.mockResolvedValueOnce(createMockResponse({ status: 'ok' }));
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          status: 'ok',
          response: { type: 'order', data: { statuses: [{ filled: { totalSz: '0.01', avgPx: '60001.00', oid: 2 } }] } },
        }),
      );

      await connector.placeMarketOrder('BTC', 'long', '0.01', 5);

      // First call: 4 fetches (meta, book, leverage, exchange)
      // Second call: 3 fetches (book, leverage, exchange) — NO meta
      expect(mockFetch).toHaveBeenCalledTimes(7);
    });

    it('throws error for unknown asset symbol', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse({ universe: [{ name: 'BTC' }, { name: 'ETH' }] }),
      );

      const result = await connector.placeMarketOrder('UNKNOWN', 'long', '1.0', 5);
      expect(result.status).toBe('error');
      expect(result.error).toContain('Unknown Hyperliquid asset');
    });
  });

  // ---------------------------------------------------------------------------
  // floatToWire encoding (Task 3)
  // ---------------------------------------------------------------------------

  describe('floatToWire encoding', () => {
    it('encodes price with 8 decimal places in exchange body', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse({ universe: [{ name: 'ETH' }] }),
      );
      mockFetch.mockResolvedValueOnce(createMockResponse({ status: 'ok' }));
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          status: 'ok',
          response: { data: { statuses: [{ resting: { oid: 1 } }] } },
        }),
      );

      await connector.placeLimitOrder('ETH', 'long', '1.0', '3500.12345678', 5, 'GTC');

      const exchangeBody = JSON.parse(mockFetch.mock.calls[2][1].body);
      // floatToWire(3500.12345678) = "3500.12345678" (exactly 8 decimal places)
      expect(exchangeBody.action.orders[0].p).toBe('3500.12345678');
    });

    it('rounds to 8 decimal places when more precision given', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse({ universe: [{ name: 'ETH' }] }),
      );
      mockFetch.mockResolvedValueOnce(createMockResponse({ status: 'ok' }));
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          status: 'ok',
          response: { data: { statuses: [{ resting: { oid: 1 } }] } },
        }),
      );

      // 3500.123456789 has 9 decimals — should round to 8
      await connector.placeLimitOrder('ETH', 'long', '1.0', '3500.123456789', 5, 'GTC');

      const exchangeBody = JSON.parse(mockFetch.mock.calls[2][1].body);
      const priceStr = exchangeBody.action.orders[0].p;
      // Verify it has exactly 8 decimal places
      const [, fracPart] = priceStr.split('.');
      expect(fracPart).toHaveLength(8);
    });

    it('pads with zeros to 8 decimal places for integer prices', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse({ universe: [{ name: 'ETH' }] }),
      );
      mockFetch.mockResolvedValueOnce(createMockResponse({ status: 'ok' }));
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          status: 'ok',
          response: { data: { statuses: [{ resting: { oid: 1 } }] } },
        }),
      );

      await connector.placeLimitOrder('ETH', 'long', '1.0', '3500', 5, 'GTC');

      const exchangeBody = JSON.parse(mockFetch.mock.calls[2][1].body);
      expect(exchangeBody.action.orders[0].p).toBe('3500.00000000');
    });
  });

  describe('cancelOrder', () => {
    it('returns true on successful cancellation', async () => {
      // 1. Meta call
      mockFetch.mockResolvedValueOnce(
        createMockResponse({ universe: [{ name: 'BTC' }, { name: 'ETH' }] }),
      );
      // 2. Cancel call
      mockFetch.mockResolvedValueOnce(createMockResponse({ status: 'ok' }));

      const result = await connector.cancelOrder('ETH', 12345);
      expect(result).toBe(true);
    });
  });

  describe('closePosition', () => {
    it('returns order result on close', async () => {
      // 1. Positions query (clearinghouseState)
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          assetPositions: [
            { position: { coin: 'ETH', szi: '1.5', leverage: { type: 'cross', value: 10 }, entryPx: '3000', positionValue: '4500', unrealizedPnl: '100', returnOnEquity: '0.02', liquidationPx: '2700', marginUsed: '450' } },
          ],
        }),
      );
      // 2. getAssetIndex meta call (inside placeMarketOrder)
      mockFetch.mockResolvedValueOnce(
        createMockResponse({ universe: [{ name: 'BTC' }, { name: 'ETH' }] }),
      );
      // 3. Order book for market order
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          levels: [
            [{ px: '3000.00', sz: '10', n: 1 }],
            [{ px: '3001.00', sz: '10', n: 1 }],
          ],
        }),
      );
      // 4. Set leverage
      mockFetch.mockResolvedValueOnce(createMockResponse({ status: 'ok' }));
      // 5. Exchange order
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          status: 'ok',
          response: { type: 'order', data: { statuses: [{ filled: { totalSz: '1.5', avgPx: '3000.00', oid: 99999 } }] } },
        }),
      );

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
      // Deposit: exchange call
      mockFetch.mockResolvedValueOnce(createMockResponse({ status: 'ok' }));
      const depositResult = await connector.depositToMargin('1000.00');
      expect(depositResult).toBe(true);

      // Withdraw: exchange call
      mockFetch.mockResolvedValueOnce(createMockResponse({ status: 'ok' }));
      const withdrawResult = await connector.withdrawFromMargin('500.00');
      expect(withdrawResult).toBe(true);
    });
  });
});
