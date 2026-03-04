// PaperTrader — runs strategy variant with zero capital allocation, recording signals only

import { RunnableBase } from '../../core/runnable-base.js';
import { Store } from '../../core/store.js';
import type { CrossChainStrategy } from '../cross-chain-strategy.js';
import type { StrategyContext } from '../../core/types.js';
import type { PaperTradeRecord } from './types.js';
import { computePaperTradingMetrics } from './types.js';

/**
 * PaperTrader runs a strategy variant in the live OODA loop
 * but with zero capital allocation. It records what trades
 * the variant would have executed, building a track record
 * without risking capital.
 *
 * Extends RunnableBase with the same tick interval as live strategies.
 */
export class PaperTrader extends RunnableBase {
  private readonly strategy: CrossChainStrategy;
  private readonly paperTradingDays: number;
  private readonly variantId: string;
  private readonly paperTrades: PaperTradeRecord[] = [];
  private readonly startTime: number;
  private completed = false;

  constructor(
    strategy: CrossChainStrategy,
    variantId: string,
    paperTradingDays: number,
    tickIntervalMs: number = 5 * 60 * 1000, // default 5 minutes
  ) {
    super(tickIntervalMs, `paper-trader-${variantId}`);
    this.strategy = strategy;
    this.variantId = variantId;
    this.paperTradingDays = paperTradingDays;
    this.startTime = Date.now();
  }

  /**
   * Each tick: run strategy.shouldExecute with current market context.
   * If signal is generated, record a PaperTradeRecord without executing.
   */
  async controlTask(): Promise<void> {
    const store = Store.getInstance();

    // Check if paper-trading period has elapsed
    const elapsedMs = Date.now() - this.startTime;
    const periodMs = this.paperTradingDays * 24 * 60 * 60 * 1000;

    if (elapsedMs >= periodMs) {
      this.completed = true;
      this.stop();
      this.logger.info(
        { variantId: this.variantId, tradeCount: this.paperTrades.length },
        'Paper-trading period complete',
      );
      return;
    }

    // Build strategy context from current store state
    const context = this.buildContext(store);

    // Evaluate exits for open paper positions
    this.evaluatePaperExits(context);

    // Check filters
    if (!this.strategy.evaluateFilters(context)) {
      return;
    }

    // Get signal from strategy
    try {
      const signal = this.strategy.shouldExecute(context);
      if (signal === null) {
        return;
      }

      // Record paper trade — zero allocation, just log the signal
      const entryPrice = context.prices.get(
        `${signal.sourceChain as number}-${signal.tokenPair.from.address as string}`,
      ) ?? 0;

      const record: PaperTradeRecord = {
        variantId: this.variantId,
        signalTime: context.timestamp,
        direction: signal.direction === 'short' ? 'short' : 'long',
        entryPrice,
        exitPrice: null,
        estimatedPnl: 0,
        pair: `${signal.tokenPair.from.symbol}/${signal.tokenPair.to.symbol}`,
        chainId: signal.sourceChain as number,
      };

      this.paperTrades.push(record);

      this.logger.debug(
        {
          variantId: this.variantId,
          direction: record.direction,
          pair: record.pair,
          entryPrice,
        },
        'Paper trade signal recorded',
      );
    } catch (error) {
      this.logger.warn(
        { error, variantId: this.variantId },
        'Strategy error during paper trading — skipping tick',
      );
    }
  }

  /**
   * Evaluate exits for open paper positions using strategy risk params.
   */
  private evaluatePaperExits(context: StrategyContext): void {
    for (const trade of this.paperTrades) {
      if (trade.exitPrice !== null) continue; // already closed

      // Look up current price for the pair
      const currentPrice = this.getCurrentPriceForTrade(trade, context);
      if (currentPrice === null) continue;

      const pnlPercent = (currentPrice - trade.entryPrice) / Math.max(trade.entryPrice, 0.0001);

      // Check stop-loss
      const absStoploss = Math.abs(this.strategy.stoploss);
      if (pnlPercent <= -absStoploss) {
        trade.exitPrice = currentPrice;
        trade.estimatedPnl = (currentPrice - trade.entryPrice);
        this.logger.debug(
          { variantId: this.variantId, pnlPercent, exitReason: 'stoploss' },
          'Paper position closed',
        );
        continue;
      }

      // Check minimal ROI
      const holdingMinutes = (context.timestamp - trade.signalTime) / 60000;
      const roiEntries = Object.entries(this.strategy.minimalRoi)
        .map(([k, v]) => [Number(k), v] as [number, number])
        .sort(([a], [b]) => b - a);

      for (const [roiMinutes, roiTarget] of roiEntries) {
        if (holdingMinutes >= roiMinutes && pnlPercent >= roiTarget) {
          trade.exitPrice = currentPrice;
          trade.estimatedPnl = (currentPrice - trade.entryPrice);
          this.logger.debug(
            { variantId: this.variantId, pnlPercent, exitReason: 'roi' },
            'Paper position closed',
          );
          break;
        }
      }
    }
  }

  /**
   * Get current price for a paper trade pair from context.
   */
  private getCurrentPriceForTrade(
    trade: PaperTradeRecord,
    context: StrategyContext,
  ): number | null {
    // Try to find a matching price from the context
    for (const [key, price] of context.prices) {
      if (key.includes(String(trade.chainId))) {
        return price;
      }
    }
    return null;
  }

  /**
   * Build a minimal StrategyContext from the store.
   */
  private buildContext(store: Store): StrategyContext {
    const balances = new Map<string, bigint>();
    for (const entry of store.getAllBalances()) {
      const key = `${entry.chainId as number}-${entry.tokenAddress as string}`;
      balances.set(key, entry.amount);
    }

    const prices = new Map<string, number>();
    for (const entry of store.getAllBalances()) {
      const key = `${entry.chainId as number}-${entry.tokenAddress as string}`;
      const priceEntry = store.getPrice(entry.chainId, entry.tokenAddress);
      if (priceEntry) {
        prices.set(key, priceEntry.priceUsd);
      }
    }

    return {
      timestamp: Date.now(),
      balances,
      positions: store.getAllPositions(),
      prices,
      activeTransfers: store.getActiveTransfers(),
    };
  }

  async onStop(): Promise<void> {
    this.logger.info(
      {
        variantId: this.variantId,
        totalSignals: this.paperTrades.length,
        completed: this.completed,
      },
      'Paper trader stopped',
    );
  }

  /**
   * Whether the paper-trading period has completed.
   */
  isComplete(): boolean {
    return this.completed;
  }

  /**
   * Get all recorded paper trades.
   */
  getPaperTrades(): PaperTradeRecord[] {
    return [...this.paperTrades];
  }

  /**
   * Get the variant ID this paper trader is tracking.
   */
  getVariantId(): string {
    return this.variantId;
  }

  /**
   * Get summary metrics for the paper-trading period.
   */
  getSummaryMetrics(): {
    sharpe: number;
    totalPnl: number;
    tradeCount: number;
    winRate: number;
  } {
    return computePaperTradingMetrics(this.paperTrades);
  }
}
