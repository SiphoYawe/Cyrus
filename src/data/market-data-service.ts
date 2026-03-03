import { createLogger } from '../utils/logger.js';
import { PriceCache } from './price-cache.js';
import { Store } from '../core/store.js';
import type { ChainId, TokenAddress, StrategyContext, AgentMode } from '../core/types.js';
import type { LiFiConnectorInterface } from '../connectors/types.js';

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

    const ctx: StrategyContext = {
      timestamp,
      balances,
      positions,
      prices,
      activeTransfers,
    };

    return Object.freeze(ctx);
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
  }
}
