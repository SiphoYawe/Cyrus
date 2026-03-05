import { createLogger } from '../utils/logger.js';
import { PriceCache } from './price-cache.js';
import { TtlCache } from './ttl-cache.js';
import { Store } from '../core/store.js';
import type { ChainId, TokenAddress, StrategyContext, AgentMode } from '../core/types.js';
import type { LiFiConnectorInterface } from '../connectors/types.js';
import type {
  MarketOrderBook,
  MarketOrderBookLevel,
  VolumeMetrics,
  VolatilityMetrics,
  FundingRateData,
  OpenInterestData,
  CorrelationResult,
  MarketMicrostructure,
  PriceCandle,
} from './market-data-types.js';

const logger = createLogger('market-data');

function cacheKey(chainId: ChainId, tokenAddress: TokenAddress): string {
  return `${chainId}-${tokenAddress}`;
}

export interface BalanceSource {
  getAllBalances(): Array<{ chainId: ChainId; tokenAddress: TokenAddress; amount: bigint }>;
}

export interface MarketDataServiceOptions {
  readonly mode: AgentMode;
  readonly connector: LiFiConnectorInterface;
  readonly balanceSource?: BalanceSource;
  readonly priceCacheTtlMs?: number;
}

export class MarketDataService {
  private readonly mode: AgentMode;
  private readonly connector: LiFiConnectorInterface;
  private readonly priceCache: PriceCache;
  private readonly balanceSource: BalanceSource | null;
  private readonly store: Store;
  private _ready = false;
  private backtestTimestamp: number | null = null;
  private readonly historicalPrices = new Map<string, Map<number, number>>(); // key -> timestamp -> price

  // Enhanced data caches with per-type TTLs
  private readonly orderBookCache = new TtlCache<MarketOrderBook>(10_000); // 10s
  private readonly volumeCache = new TtlCache<VolumeMetrics>(60_000); // 60s
  private readonly volatilityCache = new TtlCache<VolatilityMetrics>(300_000); // 5min
  private readonly fundingCache = new TtlCache<FundingRateData>(30_000); // 30s
  private readonly oiCache = new TtlCache<OpenInterestData>(30_000); // 30s
  private readonly correlationCache = new TtlCache<CorrelationResult>(300_000); // 5min

  constructor(options: MarketDataServiceOptions) {
    this.mode = options.mode;
    this.connector = options.connector;
    this.priceCache = new PriceCache(options.priceCacheTtlMs);
    this.balanceSource = options.balanceSource ?? null;
    this.store = Store.getInstance();
  }

  get ready(): boolean {
    return this._ready;
  }

  async initialize(): Promise<void> {
    const start = Date.now();
    const warnTimer = setTimeout(() => {
      logger.warn('Market data initialization taking longer than 10 seconds');
    }, 10_000);

    try {
      if (this.mode === 'live' || this.mode === 'dry-run') {
        await this.connector.getChains();
      }
      this._ready = true;
      logger.info({ mode: this.mode, durationMs: Date.now() - start }, 'Market data service ready');
    } finally {
      clearTimeout(warnTimer);
    }
  }

  async getTokenPrice(chainId: ChainId, tokenAddress: TokenAddress): Promise<number> {
    if (this.mode === 'backtest') {
      return this.getBacktestPrice(chainId, tokenAddress);
    }

    const key = cacheKey(chainId, tokenAddress);
    const cached = this.priceCache.get(key);
    if (cached !== null) return cached;

    const tokens = await this.connector.getTokens(chainId as number);
    const normalizedAddr = (tokenAddress as string).toLowerCase();
    const token = tokens.find((t) => t.address.toLowerCase() === normalizedAddr);
    const price = token?.priceUSD ? parseFloat(token.priceUSD) : 0;

    this.priceCache.set(key, price);
    this.store.setPrice(chainId, tokenAddress, price);
    return price;
  }

  async getTokenPrices(
    requests: Array<{ chainId: ChainId; tokenAddress: TokenAddress }>,
  ): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    const uncached: Array<{ chainId: ChainId; tokenAddress: TokenAddress }> = [];

    // Check cache first
    for (const req of requests) {
      const key = cacheKey(req.chainId, req.tokenAddress);
      const cached = this.priceCache.get(key);
      if (cached !== null) {
        result.set(key, cached);
      } else {
        uncached.push(req);
      }
    }

    if (uncached.length === 0) return result;

    // Group uncached by chain
    const byChain = new Map<number, TokenAddress[]>();
    for (const req of uncached) {
      const chain = req.chainId as number;
      const existing = byChain.get(chain) ?? [];
      existing.push(req.tokenAddress);
      byChain.set(chain, existing);
    }

    // Fetch per chain (batched)
    const chainFetches = Array.from(byChain.entries()).map(async ([chain, addresses]) => {
      try {
        const tokens = await this.connector.getTokens(chain);
        for (const addr of addresses) {
          const normalizedAddr = (addr as string).toLowerCase();
          const token = tokens.find((t) => t.address.toLowerCase() === normalizedAddr);
          const price = token?.priceUSD ? parseFloat(token.priceUSD) : 0;
          const key = cacheKey(chain as ChainId, addr);
          this.priceCache.set(key, price);
          result.set(key, price);
        }
      } catch (err) {
        logger.warn({ chain, error: (err as Error).message }, 'Failed to fetch prices for chain');
        for (const addr of addresses) {
          result.set(cacheKey(chain as ChainId, addr), 0);
        }
      }
    });

    await Promise.all(chainFetches);
    return result;
  }

  async buildContext(): Promise<Readonly<StrategyContext>> {
    const timestamp = this.mode === 'backtest' && this.backtestTimestamp !== null
      ? this.backtestTimestamp
      : Date.now();

    // Get balances — mode-aware sourcing
    const balances = new Map<string, bigint>();
    if (this.mode === 'dry-run' && this.balanceSource) {
      for (const b of this.balanceSource.getAllBalances()) {
        balances.set(cacheKey(b.chainId, b.tokenAddress), b.amount);
      }
    } else {
      for (const b of this.store.getAllBalances()) {
        balances.set(cacheKey(b.chainId, b.tokenAddress), b.amount);
      }
    }

    // Get positions
    const positions = this.store.getAllPositions();

    // Get prices from cache/store
    const prices = new Map<string, number>();
    for (const b of this.store.getAllBalances()) {
      const key = cacheKey(b.chainId, b.tokenAddress);
      const cached = this.priceCache.get(key);
      if (cached !== null) {
        prices.set(key, cached);
      }
    }

    // Get active transfers
    const activeTransfers = this.store.getActiveTransfers();

    // Build microstructure (best-effort, partial data acceptable)
    const microstructure = await this.buildMicrostructure();

    const ctx: StrategyContext = {
      timestamp,
      balances,
      positions,
      prices,
      activeTransfers,
      microstructure,
    };

    return Object.freeze(ctx);
  }

  // --- Enhanced market data methods ---

  async getOrderBook(market: string): Promise<MarketOrderBook> {
    const cacheKeyStr = `orderbook-${market}`;
    const cached = this.orderBookCache.get(cacheKeyStr);
    if (cached) return cached;

    const data = await this.fetchOrderBook(market);
    this.orderBookCache.set(cacheKeyStr, data);
    return data;
  }

  async getVolume(token: TokenAddress, chain: ChainId, period: string): Promise<VolumeMetrics> {
    const cacheKeyStr = `volume-${chain as number}-${token as string}-${period}`;
    const cached = this.volumeCache.get(cacheKeyStr);
    if (cached) return cached;

    const data = await this.fetchVolume(token, chain, period);
    this.volumeCache.set(cacheKeyStr, data);
    return data;
  }

  async getVolatility(token: TokenAddress, period: string): Promise<VolatilityMetrics> {
    const cacheKeyStr = `volatility-${token as string}-${period}`;
    const cached = this.volatilityCache.get(cacheKeyStr);
    if (cached) return cached;

    const data = await this.fetchVolatility(token, period);
    this.volatilityCache.set(cacheKeyStr, data);
    return data;
  }

  async getFundingRate(market: string): Promise<FundingRateData> {
    const cacheKeyStr = `funding-${market}`;
    const cached = this.fundingCache.get(cacheKeyStr);
    if (cached) return cached;

    const data = await this.fetchFundingRate(market);
    this.fundingCache.set(cacheKeyStr, data);
    return data;
  }

  async getOpenInterest(market: string): Promise<OpenInterestData> {
    const cacheKeyStr = `oi-${market}`;
    const cached = this.oiCache.get(cacheKeyStr);
    if (cached) return cached;

    const data = await this.fetchOpenInterest(market);
    this.oiCache.set(cacheKeyStr, data);
    return data;
  }

  async getCorrelation(tokenA: TokenAddress, tokenB: TokenAddress, period: string): Promise<CorrelationResult> {
    const cacheKeyStr = `correlation-${tokenA as string}-${tokenB as string}-${period}`;
    const cached = this.correlationCache.get(cacheKeyStr);
    if (cached) return cached;

    const data = await this.computeCorrelation(tokenA, tokenB, period);
    this.correlationCache.set(cacheKeyStr, data);
    return data;
  }

  // --- Data source abstractions (mockable in tests) ---

  async fetchOrderBook(market: string): Promise<MarketOrderBook> {
    try {
      const response = await fetch('https://api.hyperliquid.xyz/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'l2Book', coin: market, nSigFigs: 5 }),
      });

      if (!response.ok) {
        logger.warn({ market, status: response.status }, 'Hyperliquid order book fetch failed');
        return { market, bids: [], asks: [], spread: 0, spreadPercent: 0, midPrice: 0, timestamp: Date.now() };
      }

      const data = (await response.json()) as {
        levels: [
          { px: string; sz: string; n: number }[],
          { px: string; sz: string; n: number }[],
        ];
      };

      const [bidLevels, askLevels] = data.levels;

      const mapLevel = (l: { px: string; sz: string }): MarketOrderBookLevel => {
        const price = parseFloat(l.px);
        const size = parseFloat(l.sz);
        return { price, size, sizeUsd: price * size };
      };

      const bids = (bidLevels ?? []).slice(0, 20).map(mapLevel);
      const asks = (askLevels ?? []).slice(0, 20).map(mapLevel);

      const bestBid = bids[0]?.price ?? 0;
      const bestAsk = asks[0]?.price ?? 0;
      const midPrice = bestBid > 0 && bestAsk > 0 ? (bestBid + bestAsk) / 2 : 0;
      const spread = bestAsk - bestBid;
      const spreadPercent = midPrice > 0 ? (spread / midPrice) * 100 : 0;

      return { market, bids, asks, spread, spreadPercent, midPrice, timestamp: Date.now() };
    } catch (err) {
      logger.warn({ market, error: (err as Error).message }, 'Order book fetch error');
      return { market, bids: [], asks: [], spread: 0, spreadPercent: 0, midPrice: 0, timestamp: Date.now() };
    }
  }

  async fetchVolume(token: TokenAddress, chain: ChainId, period: string): Promise<VolumeMetrics> {
    const chainNames: Record<number, string> = {
      1: 'ethereum', 10: 'optimism', 56: 'bsc', 137: 'polygon',
      8453: 'base', 42161: 'arbitrum',
    };
    const chainSlug = chainNames[chain as number];

    if (!chainSlug) {
      return { token, chain, period, totalVolume: 0, buyVolume: 0, sellVolume: 0, buySellRatio: 1, volumeVs7dAvg: 1, vwap: 0, timestamp: Date.now() };
    }

    try {
      const response = await fetch(`https://api.llama.fi/overview/dexs/${chainSlug}?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true`);
      if (!response.ok) {
        return { token, chain, period, totalVolume: 0, buyVolume: 0, sellVolume: 0, buySellRatio: 1, volumeVs7dAvg: 1, vwap: 0, timestamp: Date.now() };
      }

      const data = (await response.json()) as {
        totalVolume24h?: number;
        change_7dover7d?: number;
        total24h?: number;
        total7d?: number;
      };

      const totalVolume = data.total24h ?? data.totalVolume24h ?? 0;
      const total7d = data.total7d ?? totalVolume * 7;
      const avg7d = total7d / 7;
      const volumeVs7dAvg = avg7d > 0 ? totalVolume / avg7d : 1;

      // Approximate buy/sell split (DeFiLlama doesn't provide directional data)
      // Use change metric as a proxy: positive change = more buying pressure
      const changeRatio = data.change_7dover7d ?? 0;
      const buyBias = 0.5 + Math.max(-0.15, Math.min(0.15, changeRatio / 200));
      const buyVolume = totalVolume * buyBias;
      const sellVolume = totalVolume * (1 - buyBias);
      const buySellRatio = sellVolume > 0 ? buyVolume / sellVolume : 1;

      return {
        token, chain, period,
        totalVolume, buyVolume, sellVolume,
        buySellRatio, volumeVs7dAvg,
        vwap: 0, // VWAP not available from aggregate endpoint
        timestamp: Date.now(),
      };
    } catch (err) {
      logger.warn({ chain: chain as number, error: (err as Error).message }, 'Volume fetch error');
      return { token, chain, period, totalVolume: 0, buyVolume: 0, sellVolume: 0, buySellRatio: 1, volumeVs7dAvg: 1, vwap: 0, timestamp: Date.now() };
    }
  }

  async fetchVolatility(token: TokenAddress, period: string): Promise<VolatilityMetrics> {
    // Compute from historical prices stored in the historicalPrices map
    const prices: number[] = [];

    for (const [key, timeSeries] of this.historicalPrices) {
      if (key.endsWith(`-${token as string}`)) {
        const sorted = [...timeSeries.entries()].sort((a, b) => a[0] - b[0]);
        for (const [, price] of sorted) {
          if (price > 0) prices.push(price);
        }
        break;
      }
    }

    // If no historical data, try to pull current price from cache
    if (prices.length === 0) {
      for (const [key, timeSeries] of this.historicalPrices) {
        if (key.includes(token as string)) {
          const sorted = [...timeSeries.entries()].sort((a, b) => a[0] - b[0]);
          for (const [, price] of sorted) {
            if (price > 0) prices.push(price);
          }
          break;
        }
      }
    }

    if (prices.length < 2) {
      return { token, period, realizedVolatility: 0, atr: 0, bollingerWidth: 0, bollingerUpper: 0, bollingerLower: 0, bollingerMiddle: 0, timestamp: Date.now() };
    }

    // Realized volatility: std dev of log returns, annualized
    const logReturns: number[] = [];
    for (let i = 1; i < prices.length; i++) {
      if (prices[i]! > 0 && prices[i - 1]! > 0) {
        logReturns.push(Math.log(prices[i]! / prices[i - 1]!));
      }
    }

    let realizedVolatility = 0;
    if (logReturns.length > 1) {
      const mean = logReturns.reduce((s, v) => s + v, 0) / logReturns.length;
      const variance = logReturns.reduce((s, v) => s + (v - mean) ** 2, 0) / (logReturns.length - 1);
      realizedVolatility = Math.sqrt(variance) * Math.sqrt(365); // Annualized
    }

    // ATR approximation: average of absolute price changes
    let atrSum = 0;
    const atrPeriod = Math.min(14, prices.length - 1);
    for (let i = prices.length - atrPeriod; i < prices.length; i++) {
      atrSum += Math.abs(prices[i]! - prices[i - 1]!);
    }
    const atr = atrPeriod > 0 ? atrSum / atrPeriod : 0;

    // Bollinger Bands (20-period SMA +/- 2 std devs)
    const bbPeriod = Math.min(20, prices.length);
    const bbSlice = prices.slice(-bbPeriod);
    const bollingerMiddle = bbSlice.reduce((s, v) => s + v, 0) / bbSlice.length;
    const bbVariance = bbSlice.reduce((s, v) => s + (v - bollingerMiddle) ** 2, 0) / bbSlice.length;
    const bbStdDev = Math.sqrt(bbVariance);
    const bollingerUpper = bollingerMiddle + 2 * bbStdDev;
    const bollingerLower = bollingerMiddle - 2 * bbStdDev;
    const bollingerWidth = bollingerMiddle > 0 ? (bollingerUpper - bollingerLower) / bollingerMiddle : 0;

    return {
      token, period,
      realizedVolatility, atr,
      bollingerWidth, bollingerUpper, bollingerLower, bollingerMiddle,
      timestamp: Date.now(),
    };
  }

  async fetchFundingRate(market: string): Promise<FundingRateData> {
    try {
      const response = await fetch('https://api.hyperliquid.xyz/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
      });

      if (!response.ok) {
        return { market, currentRate: 0, predictedNextRate: 0, avg7d: 0, annualizedYield: 0, nextFundingTime: Date.now() + 8 * 3600_000, timestamp: Date.now() };
      }

      const data = (await response.json()) as [
        { universe: { name: string }[] },
        { funding: string; premium: string; openInterest: string; prevDayPx: string; markPx: string }[],
      ];

      const [meta, assetCtxs] = data;
      const index = meta.universe.findIndex((u) => u.name === market);
      if (index === -1 || !assetCtxs[index]) {
        return { market, currentRate: 0, predictedNextRate: 0, avg7d: 0, annualizedYield: 0, nextFundingTime: Date.now() + 8 * 3600_000, timestamp: Date.now() };
      }

      const ctx = assetCtxs[index]!;
      const currentRate = parseFloat(ctx.funding);
      const premium = parseFloat(ctx.premium);

      // Funding settles every 8 hours on Hyperliquid
      // predicted next rate ≈ current premium clamped
      const predictedNextRate = Math.max(-0.01, Math.min(0.01, premium));

      // Annualized yield: 3 funding periods/day × 365 days
      const annualizedYield = currentRate * 3 * 365;

      // Next funding time: round up to next 8-hour boundary (UTC 0:00, 8:00, 16:00)
      const now = Date.now();
      const hourOfDay = new Date(now).getUTCHours();
      const nextFundingHour = Math.ceil(hourOfDay / 8) * 8;
      const nextFundingDate = new Date(now);
      nextFundingDate.setUTCHours(nextFundingHour >= 24 ? 0 : nextFundingHour, 0, 0, 0);
      if (nextFundingDate.getTime() <= now) {
        nextFundingDate.setUTCHours(nextFundingDate.getUTCHours() + 8);
      }

      return {
        market, currentRate, predictedNextRate,
        avg7d: currentRate, // Approximation: use current as avg (historical data would require separate calls)
        annualizedYield,
        nextFundingTime: nextFundingDate.getTime(),
        timestamp: Date.now(),
      };
    } catch (err) {
      logger.warn({ market, error: (err as Error).message }, 'Funding rate fetch error');
      return { market, currentRate: 0, predictedNextRate: 0, avg7d: 0, annualizedYield: 0, nextFundingTime: Date.now() + 8 * 3600_000, timestamp: Date.now() };
    }
  }

  async fetchOpenInterest(market: string): Promise<OpenInterestData> {
    try {
      const response = await fetch('https://api.hyperliquid.xyz/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
      });

      if (!response.ok) {
        return { market, totalOi: 0, totalOiUsd: 0, longRatio: 0.5, shortRatio: 0.5, change24h: 0, change24hPercent: 0, timestamp: Date.now() };
      }

      const data = (await response.json()) as [
        { universe: { name: string }[] },
        { funding: string; openInterest: string; prevDayPx: string; markPx: string }[],
      ];

      const [meta, assetCtxs] = data;
      const index = meta.universe.findIndex((u) => u.name === market);
      if (index === -1 || !assetCtxs[index]) {
        return { market, totalOi: 0, totalOiUsd: 0, longRatio: 0.5, shortRatio: 0.5, change24h: 0, change24hPercent: 0, timestamp: Date.now() };
      }

      const ctx = assetCtxs[index]!;
      const totalOi = parseFloat(ctx.openInterest); // In base asset units
      const markPx = parseFloat(ctx.markPx);
      const totalOiUsd = totalOi * markPx;

      // Hyperliquid doesn't expose long/short breakdown in public API
      // Use funding rate sign as directional proxy
      const fundingRate = parseFloat(ctx.funding);
      // Positive funding = longs pay shorts = more longs
      const longBias = 0.5 + Math.max(-0.15, Math.min(0.15, fundingRate * 100));
      const longRatio = longBias;
      const shortRatio = 1 - longBias;

      return {
        market, totalOi, totalOiUsd,
        longRatio, shortRatio,
        change24h: 0, change24hPercent: 0, // Would need historical snapshots
        timestamp: Date.now(),
      };
    } catch (err) {
      logger.warn({ market, error: (err as Error).message }, 'Open interest fetch error');
      return { market, totalOi: 0, totalOiUsd: 0, longRatio: 0.5, shortRatio: 0.5, change24h: 0, change24hPercent: 0, timestamp: Date.now() };
    }
  }

  // --- Computation methods ---

  computeCorrelation(tokenA: TokenAddress, tokenB: TokenAddress, period: string): Promise<CorrelationResult> {
    // Calculate Pearson correlation from price histories
    const keyA = tokenA as string;
    const keyB = tokenB as string;

    // Gather aligned price data from historical store
    const returnsA: number[] = [];
    const returnsB: number[] = [];

    // In production, this would fetch from a candle store
    // For now, attempt to use historicalPrices if available
    const suffixA = `-${keyA}`;
    const suffixB = `-${keyB}`;
    for (const [key, timeSeries] of this.historicalPrices) {
      if (key.endsWith(suffixA)) {
        const sorted = [...timeSeries.entries()].sort((a, b) => a[0] - b[0]);
        for (let i = 1; i < sorted.length; i++) {
          if (sorted[i]![1] > 0 && sorted[i - 1]![1] > 0) {
            returnsA.push(Math.log(sorted[i]![1] / sorted[i - 1]![1]));
          }
        }
      }
      if (key.endsWith(suffixB)) {
        const sorted = [...timeSeries.entries()].sort((a, b) => a[0] - b[0]);
        for (let i = 1; i < sorted.length; i++) {
          if (sorted[i]![1] > 0 && sorted[i - 1]![1] > 0) {
            returnsB.push(Math.log(sorted[i]![1] / sorted[i - 1]![1]));
          }
        }
      }
    }

    const sampleSize = Math.min(returnsA.length, returnsB.length);
    const coefficient = sampleSize >= 2
      ? MarketDataService.pearsonCorrelation(returnsA.slice(0, sampleSize), returnsB.slice(0, sampleSize))
      : 0;

    // p-value from t-test: t = r * sqrt((n-2)/(1-r^2))
    let pValue = 1;
    if (sampleSize > 2 && Math.abs(coefficient) < 1) {
      const t = coefficient * Math.sqrt((sampleSize - 2) / (1 - coefficient * coefficient));
      // Approximate p-value using normal distribution for large n
      pValue = sampleSize > 30 ? 2 * (1 - MarketDataService.normalCdf(Math.abs(t))) : 0.05;
    }

    return Promise.resolve({
      tokenA, tokenB, period,
      coefficient,
      sampleSize,
      pValue,
      timestamp: Date.now(),
    });
  }

  static pearsonCorrelation(x: number[], y: number[]): number {
    const n = x.length;
    if (n === 0) return 0;

    const meanX = x.reduce((s, v) => s + v, 0) / n;
    const meanY = y.reduce((s, v) => s + v, 0) / n;

    let cov = 0;
    let varX = 0;
    let varY = 0;

    for (let i = 0; i < n; i++) {
      const dx = x[i]! - meanX;
      const dy = y[i]! - meanY;
      cov += dx * dy;
      varX += dx * dx;
      varY += dy * dy;
    }

    const denom = Math.sqrt(varX * varY);
    return denom === 0 ? 0 : cov / denom;
  }

  static normalCdf(x: number): number {
    // Approximation of the standard normal CDF
    const a1 = 0.254829592;
    const a2 = -0.284496736;
    const a3 = 1.421413741;
    const a4 = -1.453152027;
    const a5 = 1.061405429;
    const p = 0.3275911;

    const sign = x < 0 ? -1 : 1;
    x = Math.abs(x) / Math.sqrt(2);

    const t = 1.0 / (1.0 + p * x);
    const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);

    return 0.5 * (1.0 + sign * y);
  }

  // --- Microstructure builder (best-effort parallel fetch) ---

  private async buildMicrostructure(): Promise<MarketMicrostructure> {
    const orderBooks = new Map<string, MarketOrderBook>();
    const volumes = new Map<string, VolumeMetrics>();
    const volatilities = new Map<string, VolatilityMetrics>();
    const fundingRates = new Map<string, FundingRateData>();
    const openInterest = new Map<string, OpenInterestData>();
    const correlations = new Map<string, CorrelationResult>();

    // Best-effort: strategies populate via individual get* methods.
    // The microstructure container is provided empty; strategies call
    // getOrderBook / getVolume / etc. directly for the markets they need.
    return { orderBooks, volumes, volatilities, fundingRates, openInterest, correlations };
  }

  invalidateAllEnhanced(): void {
    this.orderBookCache.clear();
    this.volumeCache.clear();
    this.volatilityCache.clear();
    this.fundingCache.clear();
    this.oiCache.clear();
    this.correlationCache.clear();
  }

  // --- Backtest ---

  advanceTo(timestamp: number): void {
    if (this.mode !== 'backtest') {
      logger.warn('advanceTo called outside backtest mode');
      return;
    }
    this.backtestTimestamp = timestamp;
    this.priceCache.clear(); // invalidate cache when time moves
  }

  loadHistoricalPrice(
    chainId: ChainId,
    tokenAddress: TokenAddress,
    timestamp: number,
    price: number,
  ): void {
    const key = cacheKey(chainId, tokenAddress);
    let timeSeries = this.historicalPrices.get(key);
    if (!timeSeries) {
      timeSeries = new Map();
      this.historicalPrices.set(key, timeSeries);
    }
    timeSeries.set(timestamp, price);
  }

  private getBacktestPrice(chainId: ChainId, tokenAddress: TokenAddress): number {
    if (this.backtestTimestamp === null) {
      throw new Error('Backtest time not set. Call advanceTo() before requesting prices.');
    }

    const key = cacheKey(chainId, tokenAddress);
    const timeSeries = this.historicalPrices.get(key);
    if (!timeSeries) return 0;

    // Find the latest price at or before the current backtest timestamp
    let bestTimestamp = -1;
    let bestPrice = 0;
    for (const [ts, price] of timeSeries) {
      if (ts <= this.backtestTimestamp && ts > bestTimestamp) {
        bestTimestamp = ts;
        bestPrice = price;
      }
    }

    return bestPrice;
  }

  resetCache(): void {
    this.priceCache.clear();
    this.invalidateAllEnhanced();
  }
}
