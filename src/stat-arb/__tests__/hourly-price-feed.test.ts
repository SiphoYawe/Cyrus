import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { Store } from '../../core/store.js';
import {
  HourlyPriceFeed,
  PriceFeedError,
  RateLimiter,
  resolveTokenId,
  alignAndFillGaps,
  PRICE_FEED_DEFAULTS,
  DEFAULT_TOKEN_MAPPING,
} from '../hourly-price-feed.js';
import type { FetchFn } from '../hourly-price-feed.js';

function floorToHour(ts: number): number {
  return Math.floor(ts / 3_600_000) * 3_600_000;
}

// Generate mock CoinGecko OHLC response
function mockCoinGeckoOhlc(hourCount: number, basePrice: number): number[][] {
  const now = floorToHour(Date.now());
  const candles: number[][] = [];
  for (let i = hourCount; i >= 0; i--) {
    const ts = now - i * 3_600_000;
    const price = basePrice + Math.sin(i / 10) * 100;
    candles.push([ts, price, price + 10, price - 10, price]); // [ts, open, high, low, close]
  }
  return candles;
}

// Generate mock DeFiLlama response
function mockDeFiLlamaResponse(
  tokenId: string,
  hourCount: number,
  basePrice: number,
): { coins: Record<string, { prices: Array<{ timestamp: number; price: number }> }> } {
  const now = floorToHour(Date.now());
  const prices: Array<{ timestamp: number; price: number }> = [];
  for (let i = hourCount; i >= 0; i--) {
    const ts = (now - i * 3_600_000) / 1000; // DeFiLlama uses seconds
    const price = basePrice + Math.sin(i / 10) * 100;
    prices.push({ timestamp: ts, price });
  }
  return { coins: { [`coingecko:${tokenId}`]: { prices } } };
}

function createMockFetch(responses: Map<string, { status: number; json: unknown }>): FetchFn {
  return async (url: string, _init?: RequestInit) => {
    for (const [pattern, resp] of responses) {
      if (url.includes(pattern)) {
        return {
          ok: resp.status >= 200 && resp.status < 300,
          status: resp.status,
          statusText: resp.status === 200 ? 'OK' : 'Error',
          json: async () => resp.json,
        } as Response;
      }
    }
    return {
      ok: false,
      status: 404,
      statusText: 'Not Found',
      json: async () => ({}),
    } as Response;
  };
}

describe('Hourly Price Feed', () => {
  beforeEach(() => {
    Store.getInstance().reset();
  });

  // --- Token ID resolution ---

  describe('resolveTokenId', () => {
    it('maps BTC to bitcoin', () => {
      expect(resolveTokenId('BTC')).toBe('bitcoin');
    });

    it('maps ETH to ethereum', () => {
      expect(resolveTokenId('ETH')).toBe('ethereum');
    });

    it('maps SOL to solana', () => {
      expect(resolveTokenId('SOL')).toBe('solana');
    });

    it('handles case insensitivity', () => {
      expect(resolveTokenId('btc')).toBe('bitcoin');
      expect(resolveTokenId('Eth')).toBe('ethereum');
    });

    it('falls back to lowercase for unknown symbols', () => {
      expect(resolveTokenId('UNKNOWN_TOKEN')).toBe('unknown_token');
    });

    it('uses custom mapping when provided', () => {
      expect(resolveTokenId('CUSTOM', { CUSTOM: 'custom-token-id' })).toBe('custom-token-id');
    });
  });

  // --- Rate limiter ---

  describe('RateLimiter', () => {
    it('allows requests within the limit', async () => {
      const limiter = new RateLimiter(5, 1000);
      const start = Date.now();
      for (let i = 0; i < 5; i++) {
        await limiter.acquire();
      }
      // Should be near-instant
      expect(Date.now() - start).toBeLessThan(100);
    });

    it('delays requests when limit is reached', async () => {
      const limiter = new RateLimiter(2, 200);
      await limiter.acquire();
      await limiter.acquire();
      const start = Date.now();
      await limiter.acquire(); // Should delay
      expect(Date.now() - start).toBeGreaterThanOrEqual(100);
    });

    it('resets tracked timestamps', async () => {
      const limiter = new RateLimiter(2, 60000);
      await limiter.acquire();
      await limiter.acquire();
      limiter.reset();
      // After reset, should not delay
      const start = Date.now();
      await limiter.acquire();
      expect(Date.now() - start).toBeLessThan(50);
    });
  });

  // --- Gap alignment ---

  describe('alignAndFillGaps', () => {
    it('fills missing hourly data points with forward-fill', () => {
      const now = floorToHour(Date.now());
      const rawPrices = [
        { timestamp: now - 3 * 3_600_000, close: 100 },
        { timestamp: now - 1 * 3_600_000, close: 110 },
        { timestamp: now, close: 115 },
      ];
      // Gap at now - 2h should be forward-filled with 100

      const result = alignAndFillGaps(rawPrices, 4, 'TEST');
      expect(result.gapsFilled).toBeGreaterThanOrEqual(1);
      // All prices should be defined
      expect(result.prices.every((p) => p > 0)).toBe(true);
    });

    it('handles empty input', () => {
      const result = alignAndFillGaps([], 10, 'TEST');
      expect(result.prices).toHaveLength(0);
      expect(result.timestamps).toHaveLength(0);
      expect(result.gapsFilled).toBe(0);
    });

    it('deduplicates timestamps (keeps last value)', () => {
      const now = floorToHour(Date.now());
      const rawPrices = [
        { timestamp: now, close: 100 },
        { timestamp: now, close: 200 }, // Duplicate, should keep 200
      ];
      const result = alignAndFillGaps(rawPrices, 1, 'TEST');
      const lastPrice = result.prices[result.prices.length - 1];
      expect(lastPrice).toBe(200);
    });

    it('aligns timestamps to hour boundaries', () => {
      const now = Date.now();
      const rawPrices = [
        { timestamp: now - 123456, close: 100 }, // Not aligned
      ];
      const result = alignAndFillGaps(rawPrices, 2, 'TEST');
      for (const ts of result.timestamps) {
        expect(ts % 3_600_000).toBe(0);
      }
    });
  });

  // --- HourlyPriceFeed ---

  describe('HourlyPriceFeed', () => {
    it('returns aligned price arrays from CoinGecko', async () => {
      const responses = new Map<string, { status: number; json: unknown }>();
      responses.set('bitcoin/ohlc', { status: 200, json: mockCoinGeckoOhlc(24, 50000) });
      responses.set('ethereum/ohlc', { status: 200, json: mockCoinGeckoOhlc(24, 3000) });

      const feed = new HourlyPriceFeed({ cacheTtlMs: 0 }, createMockFetch(responses));
      const result = await feed.getHourlyPrices('BTC', 'ETH', 24);

      expect(result.pricesA.length).toBeGreaterThan(0);
      expect(result.pricesB.length).toBeGreaterThan(0);
      expect(result.pricesA.length).toBe(result.pricesB.length);
      expect(result.timestamps.length).toBe(result.pricesA.length);
      expect(result.tokenA).toBe('BTC');
      expect(result.tokenB).toBe('ETH');
    });

    it('timestamps are aligned to hour boundaries', async () => {
      const responses = new Map<string, { status: number; json: unknown }>();
      responses.set('bitcoin/ohlc', { status: 200, json: mockCoinGeckoOhlc(10, 50000) });
      responses.set('ethereum/ohlc', { status: 200, json: mockCoinGeckoOhlc(10, 3000) });

      const feed = new HourlyPriceFeed({ cacheTtlMs: 0 }, createMockFetch(responses));
      const result = await feed.getHourlyPrices('BTC', 'ETH', 10);

      for (const ts of result.timestamps) {
        expect(ts % 3_600_000).toBe(0);
      }
    });

    it('returns cached data on cache hit', async () => {
      let callCount = 0;
      const mockFetch: FetchFn = async (url) => {
        callCount++;
        if (url.includes('/ohlc')) {
          return {
            ok: true,
            status: 200,
            statusText: 'OK',
            json: async () => mockCoinGeckoOhlc(24, 50000),
          } as Response;
        }
        return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) } as Response;
      };

      const feed = new HourlyPriceFeed({ cacheTtlMs: 60000 }, mockFetch);

      await feed.getHourlyPrices('BTC', 'ETH', 24);
      const initialCallCount = callCount;

      const result2 = await feed.getHourlyPrices('BTC', 'ETH', 24);
      expect(result2.source).toBe('cache');
      expect(callCount).toBe(initialCallCount); // No new API calls
    });

    it('clearCache invalidates all entries', async () => {
      let callCount = 0;
      const mockFetch: FetchFn = async () => {
        callCount++;
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => mockCoinGeckoOhlc(10, 50000),
        } as Response;
      };

      const feed = new HourlyPriceFeed({ cacheTtlMs: 60000 }, mockFetch);
      await feed.getHourlyPrices('BTC', 'ETH', 10);
      const beforeClear = callCount;

      feed.clearCache();
      await feed.getHourlyPrices('BTC', 'ETH', 10);
      expect(callCount).toBeGreaterThan(beforeClear);
    });

    it('falls back to DeFiLlama on CoinGecko 429', async () => {
      const mockFetch: FetchFn = async (url) => {
        if (url.includes('coingecko.com')) {
          return { ok: false, status: 429, statusText: 'Too Many Requests', json: async () => ({}) } as Response;
        }
        if (url.includes('llama.fi') && url.includes('bitcoin')) {
          return { ok: true, status: 200, statusText: 'OK', json: async () => mockDeFiLlamaResponse('bitcoin', 24, 50000) } as Response;
        }
        if (url.includes('llama.fi') && url.includes('ethereum')) {
          return { ok: true, status: 200, statusText: 'OK', json: async () => mockDeFiLlamaResponse('ethereum', 24, 3000) } as Response;
        }
        return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) } as Response;
      };

      const feed = new HourlyPriceFeed({ cacheTtlMs: 0 }, mockFetch);
      const result = await feed.getHourlyPrices('BTC', 'ETH', 24);
      expect(result.source).toBe('defillama');
    });

    it('falls back to DeFiLlama on CoinGecko 500', async () => {
      const mockFetch: FetchFn = async (url) => {
        if (url.includes('coingecko.com')) {
          return { ok: false, status: 500, statusText: 'Internal Server Error', json: async () => ({}) } as Response;
        }
        if (url.includes('llama.fi') && url.includes('bitcoin')) {
          return { ok: true, status: 200, statusText: 'OK', json: async () => mockDeFiLlamaResponse('bitcoin', 24, 50000) } as Response;
        }
        if (url.includes('llama.fi') && url.includes('ethereum')) {
          return { ok: true, status: 200, statusText: 'OK', json: async () => mockDeFiLlamaResponse('ethereum', 24, 3000) } as Response;
        }
        return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) } as Response;
      };

      const feed = new HourlyPriceFeed({ cacheTtlMs: 0 }, mockFetch);
      const result = await feed.getHourlyPrices('BTC', 'ETH', 24);
      expect(result.source).toBe('defillama');
    });

    it('throws PriceFeedError when both sources fail', async () => {
      const responses = new Map<string, { status: number; json: unknown }>();
      responses.set('coingecko.com', { status: 500, json: {} });
      responses.set('llama.fi', { status: 500, json: {} });

      const feed = new HourlyPriceFeed({ cacheTtlMs: 0 }, createMockFetch(responses));
      await expect(feed.getHourlyPrices('BTC', 'ETH', 24)).rejects.toThrow(PriceFeedError);
    });

    it('throws PriceFeedError with correct context', async () => {
      const responses = new Map<string, { status: number; json: unknown }>();
      responses.set('coingecko.com', { status: 500, json: {} });
      responses.set('llama.fi', { status: 500, json: {} });

      const feed = new HourlyPriceFeed({ cacheTtlMs: 0 }, createMockFetch(responses));
      try {
        await feed.getHourlyPrices('BTC', 'ETH', 24);
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(PriceFeedError);
        expect((error as PriceFeedError).context.token).toBe('BTC');
      }
    });

    it('handles one token failing with CoinGecko and falling back for that token only', async () => {
      const mockFetch: FetchFn = async (url) => {
        if (url.includes('bitcoin/ohlc')) {
          return { ok: false, status: 500, statusText: 'Error', json: async () => ({}) } as Response;
        }
        if (url.includes('ethereum/ohlc')) {
          return {
            ok: true,
            status: 200,
            statusText: 'OK',
            json: async () => mockCoinGeckoOhlc(24, 3000),
          } as Response;
        }
        // DeFiLlama fallback for bitcoin
        if (url.includes('llama.fi') && url.includes('bitcoin')) {
          return {
            ok: true,
            status: 200,
            statusText: 'OK',
            json: async () => mockDeFiLlamaResponse('bitcoin', 24, 50000),
          } as Response;
        }
        return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) } as Response;
      };

      const feed = new HourlyPriceFeed({ cacheTtlMs: 0 }, mockFetch);
      const result = await feed.getHourlyPrices('BTC', 'ETH', 24);
      // Should succeed since fallback worked for BTC
      expect(result.pricesA.length).toBeGreaterThan(0);
      expect(result.source).toBe('defillama');
    });
  });
});
