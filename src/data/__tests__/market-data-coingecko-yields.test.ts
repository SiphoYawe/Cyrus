import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { MarketDataService } from '../market-data-service.js';
import { Store } from '../../core/store.js';
import { chainId, tokenAddress } from '../../core/types.js';
import type { LiFiConnectorInterface } from '../../connectors/types.js';

function createMockConnector(): LiFiConnectorInterface {
  return {
    getQuote: vi.fn(),
    getRoutes: vi.fn(),
    getChains: vi.fn().mockResolvedValue([{ id: 1, name: 'Ethereum' }]),
    getTokens: vi.fn().mockResolvedValue([
      { address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', symbol: 'USDC', decimals: 6, chainId: 1, name: 'USD Coin', priceUSD: '1.00' },
    ]),
    getStatus: vi.fn(),
    getConnections: vi.fn(),
    getTools: vi.fn(),
  };
}

const CHAIN = chainId(1);
const USDC = tokenAddress('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
const WETH = tokenAddress('0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2');

describe('MarketDataService — CoinGecko + DeFiLlama + OnChainIndexer', () => {
  let store: Store;

  beforeEach(() => {
    store = Store.getInstance();
    store.reset();
  });

  describe('CoinGecko price feed', () => {
    it('uses CoinGecko as primary price source', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ 'usd-coin': { usd: 1.001 } }),
      });
      const connector = createMockConnector();
      const service = new MarketDataService({
        mode: 'live',
        connector,
        fetchFn: mockFetch as unknown as typeof globalThis.fetch,
      });

      const price = await service.getTokenPrice(CHAIN, USDC);
      expect(price).toBe(1.001);
      // CoinGecko was called, LI.FI was NOT
      expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('coingecko.com'));
      expect(connector.getTokens).not.toHaveBeenCalled();
    });

    it('falls back to LI.FI on CoinGecko failure', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
      });
      const connector = createMockConnector();
      const service = new MarketDataService({
        mode: 'live',
        connector,
        fetchFn: mockFetch as unknown as typeof globalThis.fetch,
      });

      const price = await service.getTokenPrice(CHAIN, USDC);
      expect(price).toBe(1.0); // From LI.FI mock
      expect(connector.getTokens).toHaveBeenCalledWith(1);
    });

    it('falls back to LI.FI for unknown tokens not in CoinGecko mapping', async () => {
      const mockFetch = vi.fn();
      const connector = createMockConnector();
      const unknownToken = tokenAddress('0x1111111111111111111111111111111111111111');
      (connector.getTokens as ReturnType<typeof vi.fn>).mockResolvedValue([
        { address: '0x1111111111111111111111111111111111111111', priceUSD: '42.50' },
      ]);

      const service = new MarketDataService({
        mode: 'live',
        connector,
        fetchFn: mockFetch as unknown as typeof globalThis.fetch,
      });

      const price = await service.getTokenPrice(CHAIN, unknownToken);
      expect(price).toBe(42.5);
      // CoinGecko NOT called (no mapping for this token)
      expect(mockFetch).not.toHaveBeenCalled();
      expect(connector.getTokens).toHaveBeenCalled();
    });

    it('caches CoinGecko results within 30s TTL', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ 'usd-coin': { usd: 1.0 } }),
      });
      const connector = createMockConnector();
      const service = new MarketDataService({
        mode: 'live',
        connector,
        fetchFn: mockFetch as unknown as typeof globalThis.fetch,
      });

      await service.getTokenPrice(CHAIN, USDC);
      await service.getTokenPrice(CHAIN, USDC);
      // Price cache prevents second CoinGecko call
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('fetchCoinGeckoPrices batches multiple token IDs', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          'ethereum': { usd: 2500 },
          'usd-coin': { usd: 1.0 },
        }),
      });
      const service = new MarketDataService({
        mode: 'live',
        connector: createMockConnector(),
        fetchFn: mockFetch as unknown as typeof globalThis.fetch,
      });

      const prices = await service.fetchCoinGeckoPrices(['ethereum', 'usd-coin']);
      expect(prices.get('ethereum')).toBe(2500);
      expect(prices.get('usd-coin')).toBe(1.0);
      // Single API call with both IDs
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const url = mockFetch.mock.calls[0]![0] as string;
      expect(url).toContain('ethereum');
      expect(url).toContain('usd-coin');
    });
  });

  describe('DeFiLlama yield auto-population', () => {
    it('fetches and filters yield opportunities by protocol', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            { pool: 'pool1', chain: 'Ethereum', project: 'aave-v3', symbol: 'USDC', tvlUsd: 500_000_000, apy: 5.5, underlyingTokens: ['0xtoken1'] },
            { pool: 'pool2', chain: 'Ethereum', project: 'unknown-project', symbol: 'XYZ', tvlUsd: 1_000, apy: 100.0 },
            { pool: 'pool3', chain: 'Arbitrum', project: 'morpho', symbol: 'ETH', tvlUsd: 50_000_000, apy: 3.2, underlyingTokens: ['0xtoken3'] },
          ],
        }),
      });

      const service = new MarketDataService({
        mode: 'live',
        connector: createMockConnector(),
        fetchFn: mockFetch as unknown as typeof globalThis.fetch,
      });

      const yields = await service.fetchYieldOpportunities();
      // Only supported protocols pass filter
      expect(yields.length).toBe(2);
      expect(yields[0]!.protocol).toBe('aave-v3');
      expect(yields[0]!.apy).toBe(5.5);
      expect(yields[1]!.protocol).toBe('morpho');
    });

    it('assigns risk score based on TVL', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            { pool: 'p1', chain: 'Ethereum', project: 'aave-v3', symbol: 'A', tvlUsd: 200_000_000, apy: 3.0, underlyingTokens: ['0xa'] },
            { pool: 'p2', chain: 'Ethereum', project: 'euler', symbol: 'B', tvlUsd: 20_000_000, apy: 4.0, underlyingTokens: ['0xb'] },
            { pool: 'p3', chain: 'Ethereum', project: 'morpho', symbol: 'C', tvlUsd: 5_000_000, apy: 6.0, underlyingTokens: ['0xc'] },
          ],
        }),
      });

      const service = new MarketDataService({
        mode: 'live',
        connector: createMockConnector(),
        fetchFn: mockFetch as unknown as typeof globalThis.fetch,
      });

      const yields = await service.fetchYieldOpportunities();
      expect(yields[0]!.riskScore).toBe(0.1); // >100M TVL
      expect(yields[1]!.riskScore).toBe(0.3); // >10M TVL
      expect(yields[2]!.riskScore).toBe(0.6); // <10M TVL
    });

    it('caches yield data for 5 minutes', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [] }),
      });

      const service = new MarketDataService({
        mode: 'live',
        connector: createMockConnector(),
        fetchFn: mockFetch as unknown as typeof globalThis.fetch,
      });

      await service.fetchYieldOpportunities();
      await service.fetchYieldOpportunities();
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('returns empty array on API failure', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });

      const service = new MarketDataService({
        mode: 'live',
        connector: createMockConnector(),
        fetchFn: mockFetch as unknown as typeof globalThis.fetch,
      });

      const yields = await service.fetchYieldOpportunities();
      expect(yields).toEqual([]);
    });
  });

  describe('DeFiLlama staking rates', () => {
    it('fetches staking rates from DeFiLlama', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            { pool: 'p1', chain: 'Ethereum', project: 'lido', symbol: 'stETH', tvlUsd: 10_000_000_000, apy: 3.8, underlyingTokens: ['0xsteth'] },
            { pool: 'p2', chain: 'Ethereum', project: 'ether.fi', symbol: 'eETH', tvlUsd: 1_000_000_000, apy: 4.2, underlyingTokens: ['0xeeth'] },
            { pool: 'p3', chain: 'Ethereum', project: 'aave-v3', symbol: 'USDC', tvlUsd: 500_000_000, apy: 5.5 },
          ],
        }),
      });

      const service = new MarketDataService({
        mode: 'live',
        connector: createMockConnector(),
        fetchFn: mockFetch as unknown as typeof globalThis.fetch,
      });

      const rates = await service.fetchStakingRates();
      expect(rates.length).toBe(2); // Only lido + ether.fi (staking projects)
      expect(rates[0]!.protocol).toBe('lido');
      expect(rates[0]!.apy).toBe(3.8);
    });
  });

  describe('OnChainIndexer event subscription', () => {
    it('receives and stores on-chain events', async () => {
      const mockIndexer = {
        events: new EventEmitter(),
        start: vi.fn(),
        stop: vi.fn(),
      };

      const service = new MarketDataService({
        mode: 'live',
        connector: createMockConnector(),
        onChainIndexer: mockIndexer as any,
      });

      await service.initialize();

      // Emit events
      mockIndexer.events.emit('on_chain_event', {
        id: 'evt-1',
        type: 'gas_update',
        chain: chainId(1),
        timestamp: Date.now(),
        metadata: {},
        gasPriceGwei: 30,
        baseFeeGwei: 25,
        priorityFeeGwei: 5,
      });

      const events = service.getOnChainEvents();
      expect(events.length).toBe(1);
      expect(events[0]!.type).toBe('gas_update');
    });

    it('maintains rolling window of max 100 events', async () => {
      const mockIndexer = {
        events: new EventEmitter(),
        start: vi.fn(),
        stop: vi.fn(),
      };

      const service = new MarketDataService({
        mode: 'live',
        connector: createMockConnector(),
        onChainIndexer: mockIndexer as any,
      });

      await service.initialize();

      // Emit 120 events
      for (let i = 0; i < 120; i++) {
        mockIndexer.events.emit('on_chain_event', {
          id: `evt-${i}`,
          type: 'gas_update',
          chain: chainId(1),
          timestamp: Date.now(),
          metadata: {},
          gasPriceGwei: 30 + i,
          baseFeeGwei: 25,
          priorityFeeGwei: 5,
        });
      }

      const events = service.getOnChainEvents();
      expect(events.length).toBe(100);
      // Oldest events (0-19) should be evicted
      expect(events[0]!.id).toBe('evt-20');
    });

    it('includes onChainData in buildContext', async () => {
      const mockIndexer = {
        events: new EventEmitter(),
        start: vi.fn(),
        stop: vi.fn(),
      };

      const service = new MarketDataService({
        mode: 'live',
        connector: createMockConnector(),
        onChainIndexer: mockIndexer as any,
      });

      await service.initialize();

      mockIndexer.events.emit('on_chain_event', {
        id: 'evt-1',
        type: 'tvl_change',
        chain: chainId(1),
        timestamp: Date.now(),
        metadata: {},
        protocol: 'aave-v3',
        oldTvl: 1_000_000,
        newTvl: 1_200_000,
        changePercent: 20,
      });

      const ctx = await service.buildContext();
      expect(ctx.onChainData).toBeDefined();
      expect(ctx.onChainData!.length).toBe(1);
      expect(ctx.onChainData![0]!.type).toBe('tvl_change');
    });
  });

  describe('integration: all sources active', () => {
    it('builds full context with CoinGecko prices, on-chain data', async () => {
      const mockIndexer = {
        events: new EventEmitter(),
        start: vi.fn(),
        stop: vi.fn(),
      };

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ 'usd-coin': { usd: 0.9999 } }),
      });

      const service = new MarketDataService({
        mode: 'live',
        connector: createMockConnector(),
        onChainIndexer: mockIndexer as any,
        fetchFn: mockFetch as unknown as typeof globalThis.fetch,
      });

      await service.initialize();

      // Emit an event
      mockIndexer.events.emit('on_chain_event', {
        id: 'e1', type: 'gas_update', chain: chainId(1),
        timestamp: Date.now(), metadata: {},
        gasPriceGwei: 20, baseFeeGwei: 15, priorityFeeGwei: 5,
      });

      // Get a CoinGecko price
      const price = await service.getTokenPrice(CHAIN, USDC);
      expect(price).toBe(0.9999);

      // Build context — store is the singleton from beforeEach
      const currentStore = Store.getInstance();
      currentStore.setBalance(CHAIN, USDC, 1000000n, 1.0, 'USDC', 6);
      const ctx = await service.buildContext();

      expect(ctx.onChainData!.length).toBe(1);
      expect(ctx.balances.size).toBeGreaterThan(0);
    });
  });
});
