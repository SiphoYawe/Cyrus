import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MarketDataService } from '../market-data-service.js';
import { Store } from '../../core/store.js';
import { chainId, tokenAddress } from '../../core/types.js';
import type { LiFiConnectorInterface } from '../../connectors/types.js';
import type { BalanceSource } from '../market-data-service.js';

function createMockConnector(): LiFiConnectorInterface {
  return {
    getQuote: vi.fn(),
    getRoutes: vi.fn(),
    getChains: vi.fn().mockResolvedValue([{ id: 1, name: 'Ethereum' }]),
    getTokens: vi.fn().mockResolvedValue([
      { address: '0x0000000000000000000000000000000000000001', symbol: 'USDC', decimals: 6, chainId: 1, name: 'USD Coin', priceUSD: '1.00' },
      { address: '0x0000000000000000000000000000000000000002', symbol: 'WETH', decimals: 18, chainId: 1, name: 'Wrapped Ether', priceUSD: '2500.00' },
    ]),
    getStatus: vi.fn(),
    getConnections: vi.fn(),
    getTools: vi.fn(),
  };
}

const CHAIN = chainId(1);
const USDC = tokenAddress('0x0000000000000000000000000000000000000001');
const WETH = tokenAddress('0x0000000000000000000000000000000000000002');

describe('MarketDataService', () => {
  let store: Store;

  beforeEach(() => {
    store = Store.getInstance();
    store.reset();
    store = Store.getInstance();
  });

  describe('ready gate', () => {
    it('is false before initialization', () => {
      const service = new MarketDataService({
        mode: 'live',
        connector: createMockConnector(),
      });
      expect(service.ready).toBe(false);
    });

    it('is true after successful initialization', async () => {
      const service = new MarketDataService({
        mode: 'live',
        connector: createMockConnector(),
      });
      await service.initialize();
      expect(service.ready).toBe(true);
    });
  });

  describe('live mode', () => {
    it('fetches price from LI.FI connector', async () => {
      const connector = createMockConnector();
      const service = new MarketDataService({ mode: 'live', connector });
      const price = await service.getTokenPrice(CHAIN, USDC);
      expect(price).toBe(1.0);
      expect(connector.getTokens).toHaveBeenCalledWith(1);
    });

    it('returns cached price on second call', async () => {
      const connector = createMockConnector();
      const service = new MarketDataService({ mode: 'live', connector });
      await service.getTokenPrice(CHAIN, USDC);
      await service.getTokenPrice(CHAIN, USDC);
      // Only one API call for the same token
      expect(connector.getTokens).toHaveBeenCalledTimes(1);
    });
  });

  describe('batch prices', () => {
    it('groups requests by chain', async () => {
      const connector = createMockConnector();
      const service = new MarketDataService({ mode: 'live', connector });
      const prices = await service.getTokenPrices([
        { chainId: CHAIN, tokenAddress: USDC },
        { chainId: CHAIN, tokenAddress: WETH },
      ]);

      expect(prices.get(`${CHAIN}-${USDC}`)).toBe(1.0);
      expect(prices.get(`${CHAIN}-${WETH}`)).toBe(2500.0);
      // Single API call since both tokens are on the same chain
      expect(connector.getTokens).toHaveBeenCalledTimes(1);
    });
  });

  describe('backtest mode', () => {
    it('returns historical price at or before cursor', async () => {
      const connector = createMockConnector();
      const service = new MarketDataService({ mode: 'backtest', connector });

      service.loadHistoricalPrice(CHAIN, USDC, 1000, 0.99);
      service.loadHistoricalPrice(CHAIN, USDC, 2000, 1.01);
      service.loadHistoricalPrice(CHAIN, USDC, 3000, 1.02);

      service.advanceTo(2500);
      const price = await service.getTokenPrice(CHAIN, USDC);
      expect(price).toBe(1.01);
    });

    it('prevents lookahead by not returning future prices', async () => {
      const connector = createMockConnector();
      const service = new MarketDataService({ mode: 'backtest', connector });

      service.loadHistoricalPrice(CHAIN, USDC, 1000, 0.99);
      service.loadHistoricalPrice(CHAIN, USDC, 5000, 1.50);

      service.advanceTo(2000);
      const price = await service.getTokenPrice(CHAIN, USDC);
      expect(price).toBe(0.99); // not 1.50
    });

    it('throws if advanceTo not called', async () => {
      const connector = createMockConnector();
      const service = new MarketDataService({ mode: 'backtest', connector });
      service.loadHistoricalPrice(CHAIN, USDC, 1000, 0.99);

      await expect(service.getTokenPrice(CHAIN, USDC)).rejects.toThrow('Backtest time not set');
    });
  });

  describe('buildContext', () => {
    it('returns complete StrategyContext with all fields', async () => {
      const connector = createMockConnector();
      const service = new MarketDataService({ mode: 'live', connector });

      store.setBalance(CHAIN, USDC, 1000000n, 1.0, 'USDC', 6);

      const ctx = await service.buildContext();
      expect(ctx.timestamp).toBeGreaterThan(0);
      expect(ctx.balances).toBeInstanceOf(Map);
      expect(ctx.positions).toBeInstanceOf(Array);
      expect(ctx.prices).toBeInstanceOf(Map);
      expect(ctx.activeTransfers).toBeInstanceOf(Array);
    });

    it('returns frozen object', async () => {
      const connector = createMockConnector();
      const service = new MarketDataService({ mode: 'live', connector });
      const ctx = await service.buildContext();
      expect(Object.isFrozen(ctx)).toBe(true);
    });

    it('uses virtual balances in dry-run mode', async () => {
      const connector = createMockConnector();
      const virtualSource: BalanceSource = {
        getAllBalances: () => [
          { chainId: CHAIN, tokenAddress: USDC, amount: 5000000n },
        ],
      };

      const service = new MarketDataService({
        mode: 'dry-run',
        connector,
        balanceSource: virtualSource,
      });

      // Set a real balance that should NOT be used in dry-run
      store.setBalance(CHAIN, USDC, 1000000n, 1.0, 'USDC', 6);

      const ctx = await service.buildContext();
      expect(ctx.balances.get(`${CHAIN}-${USDC}`)).toBe(5000000n);
    });

    it('context shape is identical across live and dry-run', async () => {
      const connector = createMockConnector();
      const virtualSource: BalanceSource = {
        getAllBalances: () => [
          { chainId: CHAIN, tokenAddress: USDC, amount: 5000000n },
        ],
      };

      const liveService = new MarketDataService({ mode: 'live', connector });
      const dryRunService = new MarketDataService({
        mode: 'dry-run',
        connector,
        balanceSource: virtualSource,
      });

      store.setBalance(CHAIN, USDC, 1000000n, 1.0, 'USDC', 6);

      const liveCtx = await liveService.buildContext();
      const dryRunCtx = await dryRunService.buildContext();

      // Same shape/keys
      expect(Object.keys(liveCtx).sort()).toEqual(Object.keys(dryRunCtx).sort());
      expect(liveCtx.balances).toBeInstanceOf(Map);
      expect(dryRunCtx.balances).toBeInstanceOf(Map);
    });
  });

  describe('resetCache', () => {
    it('clears price cache', async () => {
      const connector = createMockConnector();
      const service = new MarketDataService({ mode: 'live', connector });
      await service.getTokenPrice(CHAIN, USDC);
      service.resetCache();
      await service.getTokenPrice(CHAIN, USDC);
      expect(connector.getTokens).toHaveBeenCalledTimes(2);
    });

    it('clears all enhanced data caches', async () => {
      const connector = createMockConnector();
      const service = new MarketDataService({ mode: 'live', connector });

      // Populate enhanced caches
      const ob = await service.getOrderBook('ETH-PERP');
      expect(ob.market).toBe('ETH-PERP');

      // Reset should clear them
      service.resetCache();

      // Fetch again - should call fetchOrderBook again (not cached)
      const fetchSpy = vi.spyOn(service, 'fetchOrderBook');
      await service.getOrderBook('ETH-PERP');
      expect(fetchSpy).toHaveBeenCalled();
    });
  });

  // --- Enhanced Market Data Tests (Story 7.2) ---

  describe('getOrderBook', () => {
    it('returns bid/ask levels with spread calculation', async () => {
      const connector = createMockConnector();
      const service = new MarketDataService({ mode: 'live', connector });

      service.fetchOrderBook = vi.fn().mockResolvedValue({
        market: 'ETH-PERP',
        bids: [
          { price: 2499, size: 10, sizeUsd: 24990 },
          { price: 2498, size: 20, sizeUsd: 49960 },
        ],
        asks: [
          { price: 2501, size: 8, sizeUsd: 20008 },
          { price: 2502, size: 15, sizeUsd: 37530 },
        ],
        spread: 2,
        spreadPercent: 0.08,
        midPrice: 2500,
        timestamp: Date.now(),
      });

      const ob = await service.getOrderBook('ETH-PERP');
      expect(ob.market).toBe('ETH-PERP');
      expect(ob.bids.length).toBe(2);
      expect(ob.asks.length).toBe(2);
      expect(ob.bids[0]!.price).toBeGreaterThan(ob.bids[1]!.price); // descending
      expect(ob.asks[0]!.price).toBeLessThan(ob.asks[1]!.price); // ascending
      expect(ob.spread).toBe(2);
      expect(ob.midPrice).toBe(2500);
    });

    it('caches order book within 10s TTL', async () => {
      const connector = createMockConnector();
      const service = new MarketDataService({ mode: 'live', connector });

      const fetchSpy = vi.fn().mockResolvedValue({
        market: 'ETH-PERP', bids: [], asks: [],
        spread: 0, spreadPercent: 0, midPrice: 0, timestamp: Date.now(),
      });
      service.fetchOrderBook = fetchSpy;

      await service.getOrderBook('ETH-PERP');
      await service.getOrderBook('ETH-PERP');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('getVolume', () => {
    it('returns correct buy/sell ratio and VWAP', async () => {
      const connector = createMockConnector();
      const service = new MarketDataService({ mode: 'live', connector });

      service.fetchVolume = vi.fn().mockResolvedValue({
        token: USDC, chain: CHAIN, period: '24h',
        totalVolume: 1_000_000, buyVolume: 600_000, sellVolume: 400_000,
        buySellRatio: 1.5, volumeVs7dAvg: 1.2, vwap: 1.001,
        timestamp: Date.now(),
      });

      const vol = await service.getVolume(USDC, CHAIN, '24h');
      expect(vol.buySellRatio).toBe(1.5);
      expect(vol.vwap).toBe(1.001);
      expect(vol.volumeVs7dAvg).toBe(1.2);
      expect(vol.totalVolume).toBe(1_000_000);
    });

    it('caches volume within 60s TTL', async () => {
      const connector = createMockConnector();
      const service = new MarketDataService({ mode: 'live', connector });

      const fetchSpy = vi.fn().mockResolvedValue({
        token: USDC, chain: CHAIN, period: '24h',
        totalVolume: 0, buyVolume: 0, sellVolume: 0,
        buySellRatio: 1, volumeVs7dAvg: 1, vwap: 0, timestamp: Date.now(),
      });
      service.fetchVolume = fetchSpy;

      await service.getVolume(USDC, CHAIN, '24h');
      await service.getVolume(USDC, CHAIN, '24h');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('getVolatility', () => {
    it('returns realized volatility and Bollinger Band width', async () => {
      const connector = createMockConnector();
      const service = new MarketDataService({ mode: 'live', connector });

      service.fetchVolatility = vi.fn().mockResolvedValue({
        token: WETH, period: '24h',
        realizedVolatility: 0.45, atr: 120,
        bollingerUpper: 2600, bollingerLower: 2400, bollingerMiddle: 2500,
        bollingerWidth: 0.08, // (2600-2400)/2500
        timestamp: Date.now(),
      });

      const vol = await service.getVolatility(WETH, '24h');
      expect(vol.realizedVolatility).toBe(0.45);
      expect(vol.atr).toBe(120);
      expect(vol.bollingerWidth).toBeCloseTo(0.08, 2);
      expect(vol.bollingerUpper).toBeGreaterThan(vol.bollingerMiddle);
      expect(vol.bollingerLower).toBeLessThan(vol.bollingerMiddle);
    });
  });

  describe('getFundingRate', () => {
    it('returns current rate and correct annualized yield', async () => {
      const connector = createMockConnector();
      const service = new MarketDataService({ mode: 'live', connector });

      const rate = 0.0001; // 0.01% per 8 hours
      const annualized = rate * 3 * 365 * 100; // ~10.95%

      service.fetchFundingRate = vi.fn().mockResolvedValue({
        market: 'ETH-PERP',
        currentRate: rate,
        predictedNextRate: 0.00012,
        avg7d: 0.00009,
        annualizedYield: annualized,
        nextFundingTime: Date.now() + 8 * 3600_000,
        timestamp: Date.now(),
      });

      const fr = await service.getFundingRate('ETH-PERP');
      expect(fr.currentRate).toBe(rate);
      expect(fr.annualizedYield).toBeCloseTo(annualized, 2);
      expect(fr.market).toBe('ETH-PERP');
    });
  });

  describe('getOpenInterest', () => {
    it('returns total OI with long/short ratio summing to 1.0', async () => {
      const connector = createMockConnector();
      const service = new MarketDataService({ mode: 'live', connector });

      service.fetchOpenInterest = vi.fn().mockResolvedValue({
        market: 'ETH-PERP',
        totalOi: 50_000, totalOiUsd: 125_000_000,
        longRatio: 0.55, shortRatio: 0.45,
        change24h: 2_000, change24hPercent: 4.17,
        timestamp: Date.now(),
      });

      const oi = await service.getOpenInterest('ETH-PERP');
      expect(oi.totalOi).toBe(50_000);
      expect(oi.longRatio + oi.shortRatio).toBeCloseTo(1.0, 5);
      expect(oi.change24hPercent).toBeCloseTo(4.17, 1);
    });
  });

  describe('getCorrelation', () => {
    it('returns coefficient in [-1, 1] range', async () => {
      const connector = createMockConnector();
      const service = new MarketDataService({ mode: 'backtest', connector });

      // Load historical prices for both tokens
      for (let i = 0; i < 170; i++) {
        service.loadHistoricalPrice(CHAIN, USDC, i * 3600_000, 1.0 + Math.sin(i * 0.1) * 0.01);
        service.loadHistoricalPrice(CHAIN, WETH, i * 3600_000, 2500 + Math.sin(i * 0.1) * 50);
      }

      const corr = await service.getCorrelation(USDC, WETH, '7d');
      expect(corr.coefficient).toBeGreaterThanOrEqual(-1);
      expect(corr.coefficient).toBeLessThanOrEqual(1);
      expect(corr.sampleSize).toBeGreaterThan(0);
    });

    it('returns ~1.0 for perfectly correlated data', () => {
      const x = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      const y = [2, 4, 6, 8, 10, 12, 14, 16, 18, 20];
      const r = MarketDataService.pearsonCorrelation(x, y);
      expect(r).toBeCloseTo(1.0, 5);
    });

    it('returns ~-1.0 for inversely correlated data', () => {
      const x = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      const y = [20, 18, 16, 14, 12, 10, 8, 6, 4, 2];
      const r = MarketDataService.pearsonCorrelation(x, y);
      expect(r).toBeCloseTo(-1.0, 5);
    });

    it('returns ~0.0 for uncorrelated data', () => {
      const x = [1, -1, 1, -1, 1, -1, 1, -1];
      const y = [1, 1, -1, -1, 1, 1, -1, -1];
      const r = MarketDataService.pearsonCorrelation(x, y);
      expect(Math.abs(r)).toBeLessThan(0.3);
    });

    it('sample size matches aligned data point count', async () => {
      const connector = createMockConnector();
      const service = new MarketDataService({ mode: 'backtest', connector });

      for (let i = 0; i < 50; i++) {
        service.loadHistoricalPrice(CHAIN, USDC, i * 3600_000, 1.0 + i * 0.001);
        service.loadHistoricalPrice(CHAIN, WETH, i * 3600_000, 2500 + i * 10);
      }

      const corr = await service.getCorrelation(USDC, WETH, '7d');
      expect(corr.sampleSize).toBe(49); // n-1 returns from n prices
    });

    it('caches correlation within 5min TTL', async () => {
      const connector = createMockConnector();
      const service = new MarketDataService({ mode: 'backtest', connector });

      const computeSpy = vi.spyOn(service, 'computeCorrelation');

      for (let i = 0; i < 10; i++) {
        service.loadHistoricalPrice(CHAIN, USDC, i * 3600_000, 1.0 + i * 0.001);
        service.loadHistoricalPrice(CHAIN, WETH, i * 3600_000, 2500 + i * 10);
      }

      await service.getCorrelation(USDC, WETH, '7d');
      await service.getCorrelation(USDC, WETH, '7d');
      expect(computeSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('buildContext with microstructure', () => {
    it('includes microstructure field with all enhanced data', async () => {
      const connector = createMockConnector();
      const service = new MarketDataService({ mode: 'live', connector });

      store.setBalance(CHAIN, USDC, 1000000n, 1.0, 'USDC', 6);

      const ctx = await service.buildContext();
      expect(ctx.microstructure).toBeDefined();
      expect(ctx.microstructure!.orderBooks).toBeInstanceOf(Map);
      expect(ctx.microstructure!.volumes).toBeInstanceOf(Map);
      expect(ctx.microstructure!.volatilities).toBeInstanceOf(Map);
      expect(ctx.microstructure!.fundingRates).toBeInstanceOf(Map);
      expect(ctx.microstructure!.openInterest).toBeInstanceOf(Map);
      expect(ctx.microstructure!.correlations).toBeInstanceOf(Map);
    });

    it('returns frozen/readonly context including microstructure', async () => {
      const connector = createMockConnector();
      const service = new MarketDataService({ mode: 'live', connector });
      const ctx = await service.buildContext();
      expect(Object.isFrozen(ctx)).toBe(true);
    });

    it('handles partial data source failure gracefully', async () => {
      const connector = createMockConnector();
      const service = new MarketDataService({ mode: 'live', connector });

      store.setBalance(CHAIN, USDC, 1000000n, 1.0, 'USDC', 6);

      // Even if individual fetches fail, buildContext should succeed
      // with empty microstructure maps
      const ctx = await service.buildContext();
      expect(ctx).toBeDefined();
      expect(ctx.microstructure).toBeDefined();
      expect(ctx.microstructure!.orderBooks.size).toBe(0);
      expect(ctx.microstructure!.volumes.size).toBe(0);
      expect(ctx.balances.size).toBeGreaterThan(0);
    });
  });
});
