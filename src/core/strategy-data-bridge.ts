import { createLogger } from '../utils/logger.js';
import type { MarketDataService } from '../data/market-data-service.js';
import type { OnChainIndexer } from '../data/on-chain-indexer.js';
import type { SignalAggregator } from '../data/signal-aggregator.js';
import type { CrossChainStrategy } from '../strategies/cross-chain-strategy.js';
import { CrossChainArbStrategy } from '../strategies/builtin/cross-chain-arb.js';
import { HyperliquidPerps } from '../strategies/builtin/hyperliquid-perps.js';
import { MemeTrader } from '../strategies/builtin/meme-trader.js';
import { MarketMaker } from '../strategies/builtin/market-maker.js';
import type { ArbOpportunity } from '../strategies/builtin/cross-chain-arb.js';
import type { PerpMarketData } from '../strategies/builtin/hyperliquid-perps.js';
import type { DetectedSignal } from '../strategies/builtin/meme-trader.js';

const logger = createLogger('strategy-data-bridge');

export interface StrategyDataBridgeDeps {
  readonly strategies: readonly CrossChainStrategy[];
  readonly marketDataService: MarketDataService;
  readonly onChainIndexer?: OnChainIndexer;
  readonly signalAggregator?: SignalAggregator;
}

/**
 * Bridges data from the data pipeline into strategy-specific injection methods.
 * Runs once per tick, before strategy evaluation.
 */
export class StrategyDataBridge {
  private readonly strategies: readonly CrossChainStrategy[];
  private readonly marketDataService: MarketDataService;
  private readonly onChainIndexer: OnChainIndexer | null;
  private readonly signalAggregator: SignalAggregator | null;

  // Track data availability for diagnostics
  private lastDataStatus = {
    yieldData: false,
    fundingRates: false,
    socialSignals: false,
    orderBook: false,
  };

  constructor(deps: StrategyDataBridgeDeps) {
    this.strategies = deps.strategies;
    this.marketDataService = deps.marketDataService;
    this.onChainIndexer = deps.onChainIndexer ?? null;
    this.signalAggregator = deps.signalAggregator ?? null;
  }

  /**
   * Push latest data into all strategies that need it.
   * Non-blocking — individual data feed failures don't stop other feeds.
   */
  async feedStrategies(): Promise<void> {
    const results = await Promise.allSettled([
      this.feedCrossChainArb(),
      this.feedHyperliquidPerps(),
      this.feedMemeTrader(),
      this.feedMarketMaker(),
    ]);

    const failures = results.filter((r) => r.status === 'rejected');
    if (failures.length > 0) {
      logger.debug({ failures: failures.length }, 'Some data feeds failed (non-fatal)');
    }
  }

  getDataStatus(): Record<string, boolean> {
    return { ...this.lastDataStatus };
  }

  // --- Per-strategy data feeds ---

  private async feedCrossChainArb(): Promise<void> {
    const arbStrategies = this.strategies.filter(
      (s): s is CrossChainArbStrategy => s instanceof CrossChainArbStrategy,
    );
    if (arbStrategies.length === 0) return;

    try {
      const yields = await this.marketDataService.fetchYieldOpportunities();
      if (yields.length === 0) {
        this.lastDataStatus.yieldData = false;
        return;
      }

      // Transform yield data into ArbOpportunity format for yield arbitrage
      const yieldOpps: ArbOpportunity[] = [];
      const byProtocol = new Map<string, typeof yields>();
      for (const y of yields) {
        const key = y.token as string;
        const existing = byProtocol.get(key) ?? [];
        existing.push(y);
        byProtocol.set(key, existing);
      }

      // Find yield differentials across chains for the same token
      for (const [, pools] of byProtocol) {
        if (pools.length < 2) continue;
        pools.sort((a, b) => b.apy - a.apy);
        const best = pools[0];
        const worst = pools[pools.length - 1];
        const diff = best.apy - worst.apy;
        if (diff > 0.01) { // >1% APY differential
          yieldOpps.push({
            type: 'yield' as const,
            sourceChain: worst.chainId,
            destChain: best.chainId,
            token: worst.token,
            tokenSymbol: `${worst.protocol}→${best.protocol}`,
            buyPrice: worst.apy,
            sellPrice: best.apy,
            grossProfit: diff,
            estimatedCosts: 0.005, // Estimated 0.5% costs
            netProfit: diff - 0.005,
            confidence: Math.min(diff / 0.05, 1), // Higher diff = higher confidence
          });
        }
      }

      for (const strategy of arbStrategies) {
        strategy.updateYieldOpportunities(yieldOpps);
      }
      this.lastDataStatus.yieldData = true;
    } catch (err) {
      this.lastDataStatus.yieldData = false;
      logger.debug({ error: err }, 'CrossChainArb yield data feed failed');
    }
  }

  private async feedHyperliquidPerps(): Promise<void> {
    const perpStrategies = this.strategies.filter(
      (s): s is HyperliquidPerps => s instanceof HyperliquidPerps,
    );
    if (perpStrategies.length === 0) return;

    try {
      const markets = ['ETH', 'BTC', 'SOL'];
      const fundingRates = new Map<string, { rate: number; premium: number; timestamp: number }>();
      const ohlcv = new Map<string, { open: number; high: number; low: number; close: number; volume: number }[]>();
      const volumes = new Map<string, number[]>();

      // Fetch funding rates for each market
      const fundingResults = await Promise.allSettled(
        markets.map(async (market) => {
          const data = await this.marketDataService.getFundingRate(market);
          fundingRates.set(market, {
            rate: data.currentRate,
            premium: data.predictedNextRate,
            timestamp: data.timestamp,
          });
        }),
      );

      this.lastDataStatus.fundingRates = fundingResults.some((r) => r.status === 'fulfilled');

      const marketData: PerpMarketData = { fundingRates, ohlcv, volumes };
      for (const strategy of perpStrategies) {
        strategy.setMarketData(marketData);
      }
    } catch (err) {
      this.lastDataStatus.fundingRates = false;
      logger.debug({ error: err }, 'HyperliquidPerps data feed failed');
    }
  }

  private async feedMemeTrader(): Promise<void> {
    const memeStrategies = this.strategies.filter(
      (s): s is MemeTrader => s instanceof MemeTrader,
    );
    if (memeStrategies.length === 0) return;

    try {
      const signals: DetectedSignal[] = [];

      // Pull whale trade events from on-chain indexer
      if (this.onChainIndexer) {
        const whaleEvents = this.onChainIndexer.queryEvents({ type: 'whale_trade' });
        const recentWhales = whaleEvents.slice(0, 20);

        for (const event of recentWhales) {
          if (event.type === 'whale_trade') {
            const whale = event as import('../data/on-chain-types.js').WhaleTradeEvent;
            signals.push({
              type: 'whale_buy',
              tokenAddress: whale.token,
              tokenSymbol: whale.token as string,
              chainId: whale.chain,
              magnitude: Math.min(whale.amountUsd / 100_000, 1),
              timestamp: whale.timestamp,
            });
          }
        }

        // Pull liquidity additions
        const liquidityEvents = this.onChainIndexer.queryEvents({ type: 'liquidity_change' });
        const recentLiquidity = liquidityEvents.slice(0, 10);

        for (const event of recentLiquidity) {
          if (event.type === 'liquidity_change') {
            const liq = event as import('../data/on-chain-types.js').LiquidityChangeEvent;
            if (liq.direction === 'add') {
              signals.push({
                type: 'new_liquidity',
                tokenAddress: liq.tokenPair[0],
                tokenSymbol: liq.tokenPair[0] as string,
                chainId: liq.chain,
                magnitude: Math.min(liq.amountUsd / 50_000, 1),
                timestamp: liq.timestamp,
              });
            }
          }
        }
      }

      this.lastDataStatus.socialSignals = signals.length > 0;

      for (const strategy of memeStrategies) {
        strategy.setSignalData({ signals });
      }
    } catch (err) {
      this.lastDataStatus.socialSignals = false;
      logger.debug({ error: err }, 'MemeTrader data feed failed');
    }
  }

  private async feedMarketMaker(): Promise<void> {
    const mmStrategies = this.strategies.filter(
      (s): s is MarketMaker => s instanceof MarketMaker,
    );
    if (mmStrategies.length === 0) return;

    try {
      // Market maker needs order book data — fetch from MarketDataService
      const orderBook = await this.marketDataService.getOrderBook('ETH-USD');
      const midPrice = orderBook.midPrice;

      if (midPrice === 0) {
        this.lastDataStatus.orderBook = false;
        return;
      }

      const data = {
        midPrice,
        bestBid: orderBook.bids[0]?.price ?? 0,
        bestAsk: orderBook.asks[0]?.price ?? 0,
        baseBalance: 0n,
        quoteBalance: 0n,
        basePrice: midPrice,
        fills: [] as { side: 'buy' | 'sell'; price: number; size: bigint }[],
      };

      for (const strategy of mmStrategies) {
        strategy.setMarketData(data);
      }
      this.lastDataStatus.orderBook = true;
    } catch (err) {
      this.lastDataStatus.orderBook = false;
      logger.debug({ error: err }, 'MarketMaker data feed failed');
    }
  }
}
