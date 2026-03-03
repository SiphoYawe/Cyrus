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
  });
});
