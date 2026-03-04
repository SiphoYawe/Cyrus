import { createLogger } from '../utils/logger.js';

const logger = createLogger('hourly-price-feed');

// --- Constants ---

export const PRICE_FEED_DEFAULTS = {
  CACHE_TTL_MS: 300_000,
  LOOKBACK_HOURS: 168,
  GAP_WARNING_THRESHOLD: 0.05,
  COINGECKO_RATE_LIMIT: 10,
  COINGECKO_RATE_LIMIT_PRO: 30,
  DEFILLAMA_RATE_LIMIT: 30,
  REQUEST_TIMEOUT_MS: 10_000,
  RATE_LIMIT_WINDOW_MS: 60_000,
  MAX_RETRIES: 2,
  CACHE_CLEANUP_INTERVAL_MS: 600_000,
} as const;

// --- String literal unions ---

export type PriceFeedSource = 'coingecko' | 'defillama' | 'cache';

// --- Types ---

export interface HourlyPriceResult {
  readonly pricesA: readonly number[];
  readonly pricesB: readonly number[];
  readonly timestamps: readonly number[];
  readonly tokenA: string;
  readonly tokenB: string;
  readonly lookbackHours: number;
  readonly source: PriceFeedSource;
  readonly gapsFilled: number;
  readonly gapPercentage: number;
}

export interface HourlyPriceFeedConfig {
  readonly cacheTtlMs: number;
  readonly coingeckoBaseUrl: string;
  readonly defillamaBaseUrl: string;
  readonly coingeckoApiKey: string | undefined;
  readonly rateLimit: number;
  readonly rateLimitWindowMs: number;
  readonly maxRetries: number;
  readonly requestTimeoutMs: number;
  readonly customTokenMapping?: Record<string, string>;
}

interface CacheEntry {
  result: HourlyPriceResult;
  expiresAt: number;
}

interface RawPrice {
  timestamp: number;
  close: number;
}

interface AlignedResult {
  prices: number[];
  timestamps: number[];
  gapsFilled: number;
}

// --- Error class ---

export class PriceFeedError extends Error {
  readonly context: {
    token: string;
    source: PriceFeedSource;
    httpStatus?: number;
    details: string;
  };

  constructor(
    token: string,
    source: PriceFeedSource,
    details: string,
    httpStatus?: number,
  ) {
    super(`[PriceFeed] ${source} error for ${token}: ${details}`);
    this.name = 'PriceFeedError';
    this.context = { token, source, details, httpStatus };
  }
}

// --- Token mapping ---

export const DEFAULT_TOKEN_MAPPING: Record<string, string> = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  SOL: 'solana',
  AVAX: 'avalanche-2',
  MATIC: 'matic-network',
  POL: 'matic-network',
  DOT: 'polkadot',
  LINK: 'chainlink',
  UNI: 'uniswap',
  AAVE: 'aave',
  MKR: 'maker',
  SNX: 'havven',
  COMP: 'compound-governance-token',
  CRV: 'curve-dao-token',
  SUSHI: 'sushi',
  YFI: 'yearn-finance',
  DYDX: 'dydx-chain',
  GMX: 'gmx',
  ARB: 'arbitrum',
  OP: 'optimism',
  APE: 'apecoin',
  LDO: 'lido-dao',
  RPL: 'rocket-pool',
  FXS: 'frax-share',
  PENDLE: 'pendle',
  WLD: 'worldcoin-wld',
  TIA: 'celestia',
  SEI: 'sei-network',
  SUI: 'sui',
  APT: 'aptos',
  INJ: 'injective-protocol',
  FET: 'fetch-ai',
  RENDER: 'render-token',
  NEAR: 'near',
  ATOM: 'cosmos',
  FIL: 'filecoin',
  ICP: 'internet-computer',
  HBAR: 'hedera-hashgraph',
  VET: 'vechain',
  ALGO: 'algorand',
  XLM: 'stellar',
  XRP: 'ripple',
  ADA: 'cardano',
  DOGE: 'dogecoin',
  SHIB: 'shiba-inu',
  LTC: 'litecoin',
  BCH: 'bitcoin-cash',
  ETC: 'ethereum-classic',
  XMR: 'monero',
  ZEC: 'zcash',
  SAND: 'the-sandbox',
  MANA: 'decentraland',
  AXS: 'axie-infinity',
  GALA: 'gala',
  ENS: 'ethereum-name-service',
  BLUR: 'blur',
  JTO: 'jito-governance-token',
  JUP: 'jupiter-exchange-solana',
  W: 'wormhole',
  STRK: 'starknet',
  PYTH: 'pyth-network',
  ONDO: 'ondo-finance',
  ENA: 'ethena',
  PEPE: 'pepe',
  WIF: 'dogwifcoin',
  BONK: 'bonk',
  FLOKI: 'floki',
  ORDI: 'ordinals',
  STX: 'blockstack',
  BNB: 'binancecoin',
  TRX: 'tron',
  TON: 'the-open-network',
  RUNE: 'thorchain',
  OSMO: 'osmosis',
  KAVA: 'kava',
  FTM: 'fantom',
  MINA: 'mina-protocol',
  FLOW: 'flow',
  EGLD: 'elrond-erd-2',
  ROSE: 'oasis-network',
  ZIL: 'zilliqa',
  ONE: 'harmony',
  CKB: 'nervos-network',
  KAS: 'kaspa',
  CFX: 'conflux-token',
  AGIX: 'singularitynet',
  OCEAN: 'ocean-protocol',
  GRT: 'the-graph',
  BAT: 'basic-attention-token',
  ZRX: '0x',
  '1INCH': '1inch',
  ANKR: 'ankr',
  CELO: 'celo',
  MASK: 'mask-network',
};

export function resolveTokenId(
  symbol: string,
  customMapping?: Record<string, string>,
): string {
  const upper = symbol.toUpperCase();
  if (customMapping?.[upper]) return customMapping[upper];
  if (DEFAULT_TOKEN_MAPPING[upper]) return DEFAULT_TOKEN_MAPPING[upper];
  logger.warn({ symbol }, 'No token mapping found, falling back to lowercase symbol');
  return symbol.toLowerCase();
}

// --- Rate limiter ---

export class RateLimiter {
  private readonly timestamps: number[] = [];
  private readonly maxRequests: number;
  private readonly windowMs: number;

  constructor(maxRequests: number, windowMs: number) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  async acquire(): Promise<void> {
    const now = Date.now();
    // Remove timestamps outside the window
    while (this.timestamps.length > 0 && this.timestamps[0] < now - this.windowMs) {
      this.timestamps.shift();
    }

    if (this.timestamps.length >= this.maxRequests) {
      const oldestInWindow = this.timestamps[0];
      const waitMs = oldestInWindow + this.windowMs - now + 10;
      if (waitMs > 0) {
        logger.debug({ waitMs, maxRequests: this.maxRequests }, 'Rate limiter delaying request');
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
      // Clean up again after waiting
      const afterWait = Date.now();
      while (this.timestamps.length > 0 && this.timestamps[0] < afterWait - this.windowMs) {
        this.timestamps.shift();
      }
    }

    this.timestamps.push(Date.now());
  }

  reset(): void {
    this.timestamps.length = 0;
  }
}

// --- Alignment and gap-fill ---

function floorToHour(ts: number): number {
  return Math.floor(ts / 3_600_000) * 3_600_000;
}

export function alignAndFillGaps(
  rawPrices: readonly RawPrice[],
  lookbackHours: number,
  tokenLabel: string,
): AlignedResult {
  if (rawPrices.length === 0) {
    return { prices: [], timestamps: [], gapsFilled: 0 };
  }

  // Build a map of floored timestamps to close prices
  const priceMap = new Map<number, number>();
  for (const { timestamp, close } of rawPrices) {
    const hourTs = floorToHour(timestamp);
    priceMap.set(hourTs, close); // Last value wins for dedup
  }

  // Generate expected hourly timestamps
  const endTs = floorToHour(Date.now());
  const startTs = endTs - lookbackHours * 3_600_000;
  const expectedTimestamps: number[] = [];
  for (let ts = startTs; ts <= endTs; ts += 3_600_000) {
    expectedTimestamps.push(ts);
  }

  const prices: number[] = [];
  const timestamps: number[] = [];
  let gapsFilled = 0;
  let lastKnownPrice: number | null = null;

  for (const ts of expectedTimestamps) {
    const price = priceMap.get(ts);
    if (price !== undefined) {
      lastKnownPrice = price;
      prices.push(price);
      timestamps.push(ts);
    } else if (lastKnownPrice !== null) {
      // Forward-fill
      prices.push(lastKnownPrice);
      timestamps.push(ts);
      gapsFilled++;
    }
    // Skip timestamps before first known price
  }

  const gapPercentage = timestamps.length > 0 ? gapsFilled / timestamps.length : 0;
  if (gapPercentage > PRICE_FEED_DEFAULTS.GAP_WARNING_THRESHOLD) {
    logger.warn(
      {
        token: tokenLabel,
        gapPercentage: (gapPercentage * 100).toFixed(1),
        gapsFilled,
        total: timestamps.length,
      },
      `${(gapPercentage * 100).toFixed(1)}% of ${tokenLabel} price data forward-filled`,
    );
  }

  return { prices, timestamps, gapsFilled };
}

// --- Fetch function type for dependency injection ---

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

// --- Main class ---

export class HourlyPriceFeed {
  private readonly config: HourlyPriceFeedConfig;
  private readonly cache: Map<string, CacheEntry> = new Map();
  private readonly rateLimiter: RateLimiter;
  private readonly defillamaRateLimiter: RateLimiter;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private readonly fetchFn: FetchFn;

  constructor(config?: Partial<HourlyPriceFeedConfig>, fetchFn?: FetchFn) {
    this.config = {
      cacheTtlMs: config?.cacheTtlMs ?? PRICE_FEED_DEFAULTS.CACHE_TTL_MS,
      coingeckoBaseUrl: config?.coingeckoBaseUrl ?? 'https://api.coingecko.com',
      defillamaBaseUrl: config?.defillamaBaseUrl ?? 'https://coins.llama.fi',
      coingeckoApiKey: config?.coingeckoApiKey,
      rateLimit: config?.rateLimit ??
        (config?.coingeckoApiKey
          ? PRICE_FEED_DEFAULTS.COINGECKO_RATE_LIMIT_PRO
          : PRICE_FEED_DEFAULTS.COINGECKO_RATE_LIMIT),
      rateLimitWindowMs: config?.rateLimitWindowMs ?? PRICE_FEED_DEFAULTS.RATE_LIMIT_WINDOW_MS,
      maxRetries: config?.maxRetries ?? PRICE_FEED_DEFAULTS.MAX_RETRIES,
      requestTimeoutMs: config?.requestTimeoutMs ?? PRICE_FEED_DEFAULTS.REQUEST_TIMEOUT_MS,
      customTokenMapping: config?.customTokenMapping,
    };

    this.fetchFn = fetchFn ?? globalThis.fetch.bind(globalThis);
    this.rateLimiter = new RateLimiter(this.config.rateLimit, this.config.rateLimitWindowMs);
    this.defillamaRateLimiter = new RateLimiter(
      PRICE_FEED_DEFAULTS.DEFILLAMA_RATE_LIMIT,
      PRICE_FEED_DEFAULTS.RATE_LIMIT_WINDOW_MS,
    );
  }

  startCleanup(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => {
      this.pruneExpiredCache();
    }, PRICE_FEED_DEFAULTS.CACHE_CLEANUP_INTERVAL_MS);
  }

  stopCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  clearCache(): void {
    this.cache.clear();
  }

  private pruneExpiredCache(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
      }
    }
  }

  private getCacheKey(tokenA: string, tokenB: string, lookbackHours: number): string {
    return `${tokenA}-${tokenB}-${lookbackHours}`;
  }

  // --- CoinGecko fetcher ---

  private async fetchCoinGeckoOhlc(
    tokenId: string,
    lookbackHours: number,
  ): Promise<RawPrice[]> {
    await this.rateLimiter.acquire();

    const days = Math.ceil(lookbackHours / 24);
    const url = `${this.config.coingeckoBaseUrl}/api/v3/coins/${tokenId}/ohlc?vs_currency=usd&days=${days}`;

    const headers: Record<string, string> = {};
    if (this.config.coingeckoApiKey) {
      headers['x-cg-demo-api-key'] = this.config.coingeckoApiKey;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);

    try {
      const response = await this.fetchFn(url, {
        headers,
        signal: controller.signal,
      });

      if (response.status === 429 || response.status >= 500) {
        throw new PriceFeedError(tokenId, 'coingecko', `HTTP ${response.status}`, response.status);
      }

      if (!response.ok) {
        throw new PriceFeedError(
          tokenId,
          'coingecko',
          `HTTP ${response.status}: ${response.statusText}`,
          response.status,
        );
      }

      const data = (await response.json()) as number[][];
      const rawPrices: RawPrice[] = [];
      const seen = new Map<number, number>();

      for (const candle of data) {
        if (!Array.isArray(candle) || candle.length < 5) continue;
        const hourTs = floorToHour(candle[0]);
        seen.set(hourTs, candle[4]); // Keep last for dedup
      }

      for (const [timestamp, close] of seen) {
        rawPrices.push({ timestamp, close });
      }

      rawPrices.sort((a, b) => a.timestamp - b.timestamp);
      return rawPrices;
    } finally {
      clearTimeout(timeout);
    }
  }

  // --- DeFiLlama fetcher ---

  private async fetchDeFiLlamaPrices(
    tokenId: string,
    lookbackHours: number,
  ): Promise<RawPrice[]> {
    await this.defillamaRateLimiter.acquire();

    const endTs = Math.floor(Date.now() / 1000);
    const startTs = endTs - lookbackHours * 3600;
    const llamaId = `coingecko:${tokenId}`;
    const url =
      `${this.config.defillamaBaseUrl}/chart/${encodeURIComponent(llamaId)}` +
      `?start=${startTs}&span=${lookbackHours}&period=1h`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);

    try {
      const response = await this.fetchFn(url, { signal: controller.signal });

      if (!response.ok) {
        throw new PriceFeedError(
          tokenId,
          'defillama',
          `HTTP ${response.status}: ${response.statusText}`,
          response.status,
        );
      }

      const data = (await response.json()) as {
        coins?: Record<string, { prices?: Array<{ timestamp: number; price: number }> }>;
      };

      const coinData = data?.coins?.[llamaId];
      if (!coinData?.prices || coinData.prices.length === 0) {
        throw new PriceFeedError(tokenId, 'defillama', 'No price data returned');
      }

      return coinData.prices.map((p) => ({
        timestamp: p.timestamp * 1000, // Convert to ms
        close: p.price,
      }));
    } finally {
      clearTimeout(timeout);
    }
  }

  // --- Fetch with fallback ---

  private async fetchWithFallback(
    symbol: string,
    lookbackHours: number,
  ): Promise<{ rawPrices: RawPrice[]; source: PriceFeedSource }> {
    const tokenId = resolveTokenId(symbol, this.config.customTokenMapping);

    // Try CoinGecko first
    try {
      const rawPrices = await this.fetchCoinGeckoOhlc(tokenId, lookbackHours);
      if (rawPrices.length > 0) {
        return { rawPrices, source: 'coingecko' };
      }
    } catch (error) {
      const isRetryable =
        error instanceof PriceFeedError &&
        error.context.httpStatus !== undefined &&
        (error.context.httpStatus === 429 || error.context.httpStatus >= 500);
      const isTimeout = error instanceof Error && error.name === 'AbortError';

      if (isRetryable || isTimeout) {
        logger.warn(
          { token: symbol, error: (error as Error).message },
          `CoinGecko unavailable for ${symbol}, falling back to DeFiLlama`,
        );
      } else {
        logger.warn(
          { token: symbol, error: (error as Error).message },
          `CoinGecko error for ${symbol}, falling back to DeFiLlama`,
        );
      }
    }

    // Fallback to DeFiLlama
    try {
      const rawPrices = await this.fetchDeFiLlamaPrices(tokenId, lookbackHours);
      return { rawPrices, source: 'defillama' };
    } catch (error) {
      throw new PriceFeedError(
        symbol,
        'defillama',
        `Both CoinGecko and DeFiLlama failed: ${(error as Error).message}`,
      );
    }
  }

  // --- Main public method ---

  async getHourlyPrices(
    tokenA: string,
    tokenB: string,
    lookbackHours: number = PRICE_FEED_DEFAULTS.LOOKBACK_HOURS,
  ): Promise<HourlyPriceResult> {
    // Check cache
    const cacheKey = this.getCacheKey(tokenA, tokenB, lookbackHours);
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
      logger.debug({ tokenA, tokenB }, 'Cache hit for hourly prices');
      return { ...cached.result, source: 'cache' };
    }

    // Fetch both tokens in parallel
    const [resultA, resultB] = await Promise.allSettled([
      this.fetchWithFallback(tokenA, lookbackHours),
      this.fetchWithFallback(tokenB, lookbackHours),
    ]);

    if (resultA.status === 'rejected') {
      throw new PriceFeedError(tokenA, 'coingecko', resultA.reason?.message ?? 'Fetch failed');
    }
    if (resultB.status === 'rejected') {
      throw new PriceFeedError(tokenB, 'coingecko', resultB.reason?.message ?? 'Fetch failed');
    }

    const fetchA = resultA.value;
    const fetchB = resultB.value;

    // Determine source (prefer coingecko, note defillama if used)
    const source: PriceFeedSource =
      fetchA.source === 'defillama' || fetchB.source === 'defillama'
        ? 'defillama'
        : 'coingecko';

    // Align and fill gaps
    const alignedA = alignAndFillGaps(fetchA.rawPrices, lookbackHours, tokenA);
    const alignedB = alignAndFillGaps(fetchB.rawPrices, lookbackHours, tokenB);

    // Find overlapping timestamps
    const setA = new Set(alignedA.timestamps);
    const commonTimestamps = alignedB.timestamps.filter((ts) => setA.has(ts));

    if (commonTimestamps.length === 0) {
      throw new PriceFeedError(
        `${tokenA}/${tokenB}`,
        source,
        'No overlapping timestamps after alignment',
      );
    }

    // Build aligned arrays for common timestamps
    const mapA = new Map<number, number>();
    for (let i = 0; i < alignedA.timestamps.length; i++) {
      mapA.set(alignedA.timestamps[i], alignedA.prices[i]);
    }
    const mapB = new Map<number, number>();
    for (let i = 0; i < alignedB.timestamps.length; i++) {
      mapB.set(alignedB.timestamps[i], alignedB.prices[i]);
    }

    const pricesA: number[] = [];
    const pricesB: number[] = [];
    const timestamps: number[] = [];
    for (const ts of commonTimestamps) {
      const pA = mapA.get(ts);
      const pB = mapB.get(ts);
      if (pA !== undefined && pB !== undefined) {
        pricesA.push(pA);
        pricesB.push(pB);
        timestamps.push(ts);
      }
    }

    const totalGaps = alignedA.gapsFilled + alignedB.gapsFilled;
    const gapPercentage =
      timestamps.length > 0 ? totalGaps / (timestamps.length * 2) : 0;

    const result: HourlyPriceResult = {
      pricesA,
      pricesB,
      timestamps,
      tokenA,
      tokenB,
      lookbackHours,
      source,
      gapsFilled: totalGaps,
      gapPercentage,
    };

    // Store in cache
    this.cache.set(cacheKey, {
      result,
      expiresAt: Date.now() + this.config.cacheTtlMs,
    });

    return result;
  }
}
