// BacktestEngine — replays historical data through the OODA loop for strategy validation

import { createLogger } from '../utils/logger.js';
import { Store } from '../core/store.js';
import { chainId, tokenAddress } from '../core/types.js';
import type { StrategyContext, StrategySignal, ChainId, TokenAddress } from '../core/types.js';
import type { CrossChainStrategy } from '../strategies/cross-chain-strategy.js';
import type { SimulatedLiFiConnector } from '../connectors/simulated-lifi-connector.js';
import type { HistoricalDataLoader } from './historical-data-loader.js';
import { LookaheadError } from './errors.js';
import type { BacktestConfig, BacktestResult, EquityPoint, TradeRecord } from './types.js';

const logger = createLogger('backtest-engine');

/**
 * BacktestEngine replays historical data through the same OODA loop
 * used in live mode, ensuring behavior parity between backtesting
 * and live trading.
 *
 * OODA Loop phases per tick:
 * 1. Observe — advance historical data and connector to current timestamp
 * 2. Orient — build StrategyContext from historical prices, store balances, positions
 * 3. Decide — call strategy.shouldExecute(context) to get signal
 * 4. Act — if signal, build execution plan and execute via simulated connector
 *
 * Phase sequence (same as live):
 * 1. Update prices from historical data
 * 2. Manage in-flight transfers (check bridge delays)
 * 3. Evaluate exits (check stop-loss, take-profit on existing positions)
 * 4. Evaluate entries (call strategy for new signals)
 */
export class BacktestEngine {
  private readonly config: BacktestConfig;
  private readonly strategy: CrossChainStrategy;
  private readonly dataLoader: HistoricalDataLoader;
  private readonly connector: SimulatedLiFiConnector;
  private readonly equityCurve: EquityPoint[] = [];

  constructor(
    config: BacktestConfig,
    strategy: CrossChainStrategy,
    dataLoader: HistoricalDataLoader,
    connector: SimulatedLiFiConnector,
  ) {
    this.config = config;
    this.strategy = strategy;
    this.dataLoader = dataLoader;
    this.connector = connector;
  }

  /**
   * Run the backtest from startDate to endDate.
   * Returns a BacktestResult with equity curve, trade log, and summary statistics.
   */
  async run(): Promise<BacktestResult> {
    const startTime = Date.now();
    const store = Store.getInstance();

    // AC 7: Clean state before run
    store.reset();
    const freshStore = Store.getInstance();

    logger.info(
      {
        strategy: this.config.strategyName,
        startDate: this.config.startDate,
        endDate: this.config.endDate,
        tickInterval: this.config.tickInterval,
        initialCapital: this.config.initialCapital.toString(),
      },
      'Backtest starting',
    );

    // Initialize state
    const initialChain = chainId(this.config.initialChainId ?? 1);
    const initialToken = tokenAddress(this.config.initialToken ?? '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');

    freshStore.setBalance(
      initialChain,
      initialToken,
      this.config.initialCapital,
      Number(this.config.initialCapital) / 1e6, // rough USD estimate for USDC
      'USDC',
      6,
    );

    // Call strategy lifecycle hook
    await this.strategy.onBotStart();

    // Record initial equity point
    this.equityCurve.push({
      timestamp: this.config.startDate,
      portfolioValue: this.config.initialCapital,
    });

    // Main replay loop
    let currentTime = this.config.startDate;

    while (currentTime <= this.config.endDate) {
      // === Phase 1: Observe — advance time ===
      this.dataLoader.advanceTo(currentTime);
      this.connector.advanceTo(currentTime);

      // === Phase 2: Update prices in store from historical data ===
      this.updatePricesFromHistory(freshStore, currentTime);

      // === Phase 3: Manage in-flight transfers ===
      await this.manageInFlightTransfers(freshStore);

      // === Phase 4: Evaluate exits (stop-loss, take-profit) ===
      this.evaluateExits(freshStore, currentTime);

      // === Phase 5: Evaluate entries (strategy decision) ===
      await this.evaluateEntries(freshStore, currentTime);

      // Call strategy onLoopStart hook
      await this.strategy.onLoopStart(currentTime);

      // Record equity point
      const portfolioValue = this.computePortfolioValue(freshStore, currentTime);
      this.equityCurve.push({
        timestamp: currentTime,
        portfolioValue,
      });

      // Advance clock
      currentTime += this.config.tickInterval;
    }

    // Collect results
    const tradeLog = this.connector.getTradeLog();
    const finalPortfolioValue = this.computePortfolioValue(freshStore, this.config.endDate);

    const result: BacktestResult = {
      startDate: this.config.startDate,
      endDate: this.config.endDate,
      initialCapital: this.config.initialCapital,
      finalPortfolioValue,
      equityCurve: this.equityCurve,
      tradeLog,
      totalTrades: tradeLog.length,
      durationMs: Date.now() - startTime,
    };

    // Log summary
    this.logSummary(result);

    return result;
  }

  // --- Internal phase methods ---

  /**
   * Phase 1: Update store prices from historical data at the current timestamp.
   */
  private updatePricesFromHistory(store: Store, timestamp: number): void {
    const balances = store.getAllBalances();
    for (const balance of balances) {
      const price = this.dataLoader.getPrice(
        balance.tokenAddress as string,
        balance.chainId as number,
        timestamp,
      );
      if (price !== undefined) {
        store.setPrice(balance.chainId, balance.tokenAddress, price);
      }
    }
  }

  /**
   * Phase 3: Check in-flight transfers and complete those past bridge delay.
   */
  private async manageInFlightTransfers(store: Store): Promise<void> {
    const activeTransfers = store.getActiveTransfers();

    for (const transfer of activeTransfers) {
      if (!transfer.txHash) continue;

      const status = await this.connector.getStatus(
        transfer.txHash,
        transfer.bridge,
        transfer.fromChain as number,
        transfer.toChain as number,
      );

      if (status.status === 'DONE') {
        const receivedAmount = status.receiving?.amount
          ? BigInt(status.receiving.amount)
          : transfer.amount;

        store.completeTransfer(
          transfer.id,
          receivedAmount,
          transfer.toToken,
          transfer.toChain,
        );

        // Credit the received token balance
        const existingBalance = store.getBalance(transfer.toChain, transfer.toToken);
        const currentAmount = existingBalance?.amount ?? 0n;
        const price = this.dataLoader.getPrice(
          transfer.toToken as string,
          transfer.toChain as number,
          this.connector.getCurrentTimestamp(),
        ) ?? 0;

        store.setBalance(
          transfer.toChain,
          transfer.toToken,
          currentAmount + receivedAmount,
          Number(currentAmount + receivedAmount) * price,
          existingBalance?.symbol ?? 'UNKNOWN',
          existingBalance?.decimals ?? 18,
        );

        logger.debug(
          { transferId: transfer.id, receivedAmount: receivedAmount.toString() },
          'Simulated transfer completed',
        );
      }
    }
  }

  /**
   * Phase 4: Evaluate exits — check positions against stop-loss and take-profit.
   */
  private evaluateExits(store: Store, timestamp: number): void {
    const positions = store.getAllPositions();

    for (const position of positions) {
      const currentPrice = this.dataLoader.getPrice(
        position.tokenAddress as string,
        position.chainId as number,
        timestamp,
      );

      if (currentPrice === undefined) continue;

      const pnlPercent = (currentPrice - position.entryPrice) / position.entryPrice;

      // Check stop-loss
      const stopLossThreshold = this.strategy.customStoploss(position, pnlPercent);
      if (pnlPercent <= stopLossThreshold) {
        if (this.strategy.confirmTradeExit(position, 'stoploss')) {
          logger.debug(
            { positionId: position.id, pnlPercent, stopLossThreshold },
            'Stop-loss triggered',
          );
          // Remove position from store
          // (In a full implementation, this would trigger a sell order)
        }
      }

      // Check minimal ROI (take-profit)
      const holdingMinutes = (timestamp - position.enteredAt) / 60000;
      const roiEntries = Object.entries(this.strategy.minimalRoi)
        .map(([k, v]) => [Number(k), v] as [number, number])
        .sort(([a], [b]) => b - a); // sort descending by time

      for (const [roiMinutes, roiTarget] of roiEntries) {
        if (holdingMinutes >= roiMinutes && pnlPercent >= roiTarget) {
          if (this.strategy.confirmTradeExit(position, 'roi')) {
            logger.debug(
              { positionId: position.id, pnlPercent, roiTarget, holdingMinutes },
              'ROI target reached',
            );
          }
          break;
        }
      }
    }
  }

  /**
   * Phase 5: Evaluate entries — call strategy for new signals.
   *
   * If the strategy attempts to access future data (lookahead violation),
   * the LookaheadError is caught and logged as a warning. The tick continues
   * without executing any trade.
   */
  private async evaluateEntries(store: Store, timestamp: number): Promise<void> {
    // Build strategy context (same shape as live mode)
    const context = this.buildStrategyContext(store, timestamp);

    // Check filters
    if (!this.strategy.evaluateFilters(context)) {
      return;
    }

    // Check max positions
    const currentPositions = store.getAllPositions().length;
    if (currentPositions >= this.strategy.maxPositions) {
      return;
    }

    let signal: StrategySignal | null;
    try {
      // Decide: call strategy
      signal = this.strategy.shouldExecute(context);
    } catch (error) {
      if (error instanceof LookaheadError) {
        logger.warn(
          {
            strategy: this.strategy.name,
            timestamp,
            requestedTimestamp: error.requestedTimestamp,
            cursorTimestamp: error.cursorTimestamp,
          },
          'Lookahead violation detected in strategy — skipping tick',
        );
        return;
      }
      throw error;
    }

    if (signal === null) {
      return;
    }

    // Act: build and execute
    const plan = this.strategy.buildExecution(signal, context);

    if (!this.strategy.confirmTradeEntry(plan)) {
      return;
    }

    // Execute actions through simulated connector
    await this.executeActions(store, signal, timestamp);
  }

  /**
   * Build a StrategyContext from current store state and historical data.
   * Ensures no lookahead — only data at or before the current timestamp.
   */
  private buildStrategyContext(store: Store, timestamp: number): StrategyContext {
    // Build balances map
    const balances = new Map<string, bigint>();
    for (const entry of store.getAllBalances()) {
      const key = `${entry.chainId as number}-${entry.tokenAddress as string}`;
      balances.set(key, entry.amount);
    }

    // Build prices map from store (already limited to current timestamp via historical data)
    const prices = new Map<string, number>();
    for (const entry of store.getAllBalances()) {
      const key = `${entry.chainId as number}-${entry.tokenAddress as string}`;
      const price = this.dataLoader.getPrice(
        entry.tokenAddress as string,
        entry.chainId as number,
        timestamp,
      );
      if (price !== undefined) {
        prices.set(key, price);
      }
    }

    return {
      timestamp,
      balances,
      positions: store.getAllPositions(),
      prices,
      activeTransfers: store.getActiveTransfers(),
    };
  }

  /**
   * Execute simulated actions based on a strategy signal.
   */
  private async executeActions(
    store: Store,
    signal: StrategySignal,
    timestamp: number,
  ): Promise<void> {
    const fromChainNum = signal.sourceChain as number;
    const toChainNum = signal.destChain as number;
    const fromTokenStr = signal.tokenPair.from.address as string;
    const toTokenStr = signal.tokenPair.to.address as string;

    // Get available balance for the from token
    const availableBalance = store.getAvailableBalance(signal.sourceChain, signal.tokenPair.from.address);

    if (availableBalance <= 0n) {
      logger.debug({ fromToken: fromTokenStr, chain: fromChainNum }, 'No available balance for trade');
      return;
    }

    // Use strength as position size factor (0-1)
    const tradeAmount = BigInt(Math.floor(Number(availableBalance) * signal.strength));

    if (tradeAmount <= 0n) return;

    try {
      // Get quote via simulated connector
      const quote = await this.connector.getQuote({
        fromChain: signal.sourceChain,
        toChain: signal.destChain,
        fromToken: signal.tokenPair.from.address,
        toToken: signal.tokenPair.to.address,
        fromAmount: tradeAmount.toString(),
        slippage: this.config.slippage,
      });

      const toAmount = BigInt(quote.estimate.toAmount);

      // Execute the trade
      const txHash = this.connector.executeTransaction(
        fromTokenStr,
        toTokenStr,
        fromChainNum,
        toChainNum,
        tradeAmount,
        toAmount,
      );

      // Deduct from balance
      const currentFromBalance = store.getBalance(signal.sourceChain, signal.tokenPair.from.address);
      if (currentFromBalance) {
        const newAmount = currentFromBalance.amount - tradeAmount;
        store.setBalance(
          signal.sourceChain,
          signal.tokenPair.from.address,
          newAmount,
          Number(newAmount) * (this.dataLoader.getPrice(fromTokenStr, fromChainNum, timestamp) ?? 0),
          currentFromBalance.symbol,
          currentFromBalance.decimals,
        );
      }

      // For same-chain trades, immediately credit the to balance
      if (fromChainNum === toChainNum) {
        const currentToBalance = store.getBalance(signal.destChain, signal.tokenPair.to.address);
        const existingAmount = currentToBalance?.amount ?? 0n;
        const toPrice = this.dataLoader.getPrice(toTokenStr, toChainNum, timestamp) ?? 0;

        store.setBalance(
          signal.destChain,
          signal.tokenPair.to.address,
          existingAmount + toAmount,
          Number(existingAmount + toAmount) * toPrice,
          signal.tokenPair.to.symbol,
          signal.tokenPair.to.decimals,
        );
      } else {
        // Cross-chain: create in-flight transfer (will be completed when bridge delay elapses)
        store.createTransfer({
          txHash,
          fromChain: signal.sourceChain,
          toChain: signal.destChain,
          fromToken: signal.tokenPair.from.address,
          toToken: signal.tokenPair.to.address,
          amount: tradeAmount,
          bridge: 'simulated-bridge',
          quoteData: quote,
        });
      }

      logger.debug(
        {
          txHash,
          fromToken: fromTokenStr,
          toToken: toTokenStr,
          amount: tradeAmount.toString(),
          toAmount: toAmount.toString(),
        },
        'Simulated trade executed in backtest',
      );
    } catch (error) {
      logger.warn({ error, signal }, 'Trade execution failed during backtest');
    }
  }

  /**
   * Compute total portfolio value in smallest units of the initial token.
   *
   * Uses historical prices to normalize across tokens/chains: each balance
   * is converted to its USD value (amount * price / 10^decimals), then the
   * total USD value is converted back into initial-token smallest units.
   *
   * Falls back to raw amount sum if no price data is available.
   */
  private computePortfolioValue(store: Store, timestamp: number): bigint {
    let totalValue = 0n;

    for (const balance of store.getAllBalances()) {
      const price = this.dataLoader.getPrice(
        balance.tokenAddress as string,
        balance.chainId as number,
        timestamp,
      );

      if (price !== undefined && price > 0) {
        // Convert to a common denomination using price:
        // usdValue = (amount / 10^decimals) * priceUsd
        // Then convert back to initial token units (USDC 6 decimals assumed):
        // valueInInitialUnits = usdValue * 10^6
        const usdValue = (Number(balance.amount) / Math.pow(10, balance.decimals)) * price;
        const valueInInitialUnits = BigInt(Math.floor(usdValue * 1e6));
        totalValue += valueInInitialUnits;
      } else {
        // If no price data, add raw amount (best effort)
        totalValue += balance.amount;
      }
    }

    return totalValue;
  }

  /**
   * Log a summary of the backtest results.
   */
  private logSummary(result: BacktestResult): void {
    const totalReturn = result.initialCapital > 0n
      ? Number((result.finalPortfolioValue - result.initialCapital) * 10000n / result.initialCapital) / 100
      : 0;

    const winningTrades = result.tradeLog.filter((t) => t.pnl > 0n).length;
    const winRate = result.totalTrades > 0
      ? ((winningTrades / result.totalTrades) * 100).toFixed(1)
      : '0.0';

    logger.info(
      {
        strategy: this.config.strategyName,
        totalReturn: `${totalReturn.toFixed(2)}%`,
        totalTrades: result.totalTrades,
        winRate: `${winRate}%`,
        initialCapital: result.initialCapital.toString(),
        finalPortfolioValue: result.finalPortfolioValue.toString(),
        durationMs: result.durationMs,
      },
      'Backtest completed',
    );
  }
}
