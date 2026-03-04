// PairPositionManager — handles close operations, exit evaluation, and P&L tracking
// for stat arb pair positions on Hyperliquid.
// CRITICAL: Both legs MUST close simultaneously. No partial closes EVER.
// Stoploss applies to COMBINED P&L only, never individual legs.

import { Store } from '../core/store.js';
import { createLogger } from '../utils/logger.js';
import type { HyperliquidOrderManager, PerpOrderResult, PerpOrderParams } from '../connectors/hyperliquid-order-manager.js';
import type { FundingRateTracker } from '../stat-arb/funding-rate-tracker.js';
import type {
  StatArbPosition,
  StatArbExitReason,
  StatArbCloseData,
} from '../core/store-slices/stat-arb-slice.js';
import { calculateStoplossBreached } from '../core/store-slices/stat-arb-slice.js';

const logger = createLogger('pair-position-manager');

const DEFAULT_SIZE_DECIMALS = 18;
const DEFAULT_MAX_LOSS_PERCENT = 30;
const DEFAULT_TIME_STOP_MULTIPLIER = 3;
const DEFAULT_EXIT_Z_THRESHOLD = 0.5;
const CLOSE_RETRY_DELAY_MS = 500;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PairCloseResult {
  readonly positionId: string;
  readonly longExitPrice: number;
  readonly shortExitPrice: number;
  readonly longRealizedPnl: number;
  readonly shortRealizedPnl: number;
  readonly fundingPnl: number;
  readonly totalFees: number;
  readonly netPnl: number;
  readonly exitReason: StatArbExitReason;
  readonly exitTimestamp: number;
}

export interface ExitEvaluation {
  readonly shouldExit: boolean;
  readonly exitReason: StatArbExitReason | null;
  readonly metadata: Record<string, unknown>;
}

export interface PairPositionManagerConfig {
  readonly sizeDecimals: number;
  readonly maxLossPercent: number;
  readonly timeStopMultiplier: number;
  readonly exitZScoreThreshold: number;
}

const DEFAULT_CONFIG: PairPositionManagerConfig = {
  sizeDecimals: DEFAULT_SIZE_DECIMALS,
  maxLossPercent: DEFAULT_MAX_LOSS_PERCENT,
  timeStopMultiplier: DEFAULT_TIME_STOP_MULTIPLIER,
  exitZScoreThreshold: DEFAULT_EXIT_Z_THRESHOLD,
} as const;

// ---------------------------------------------------------------------------
// PairPositionManager
// ---------------------------------------------------------------------------

export class PairPositionManager {
  private readonly orderManager: HyperliquidOrderManager;
  private readonly fundingTracker: FundingRateTracker;
  private readonly store: Store;
  private readonly config: PairPositionManagerConfig;

  constructor(
    orderManager: HyperliquidOrderManager,
    fundingTracker: FundingRateTracker,
    config?: Partial<PairPositionManagerConfig>,
    store?: Store,
  ) {
    this.orderManager = orderManager;
    this.fundingTracker = fundingTracker;
    this.store = store ?? Store.getInstance();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ---------------------------------------------------------------------------
  // Close position (AC1, AC2, AC7, AC8)
  // ---------------------------------------------------------------------------

  async closePosition(
    positionId: string,
    exitReason: StatArbExitReason,
  ): Promise<PairCloseResult> {
    const pos = this.store.getActiveStatArbPosition(positionId);
    if (!pos) {
      throw new Error(`Position not found or already closed: ${positionId}`);
    }

    if (pos.status !== 'active') {
      throw new Error(`Position ${positionId} is not active (status: ${pos.status})`);
    }

    const decimals = this.config.sizeDecimals;
    const longSizeBig = BigInt(Math.round(pos.legA.size * 10 ** decimals));
    const shortSizeBig = BigInt(Math.round(pos.legB.size * 10 ** decimals));

    // Close both legs simultaneously (AC1)
    const longCloseParams: PerpOrderParams = {
      symbol: pos.legA.symbol,
      side: 'sell',
      size: longSizeBig,
      leverage: pos.leverage,
      type: 'market',
      decimals,
    };

    const shortCloseParams: PerpOrderParams = {
      symbol: pos.legB.symbol,
      side: 'buy',
      size: shortSizeBig,
      leverage: pos.leverage,
      type: 'market',
      decimals,
    };

    let longCloseResult: PerpOrderResult;
    let shortCloseResult: PerpOrderResult;

    // Place long close with retry (AC7)
    longCloseResult = await this.placeCloseWithRetry(longCloseParams, positionId, 'long');

    // Place short close with retry (AC7)
    shortCloseResult = await this.placeCloseWithRetry(shortCloseParams, positionId, 'short');

    // Calculate realized P&L (AC2)
    const longExitPrice = parseFloat(longCloseResult.fillPrice || longCloseResult.averageFillPrice || '0');
    const shortExitPrice = parseFloat(shortCloseResult.fillPrice || shortCloseResult.averageFillPrice || '0');

    const longRealizedPnl = (longExitPrice - pos.legA.entryPrice) * pos.legA.size * pos.leverage;
    const shortRealizedPnl = (pos.legB.entryPrice - shortExitPrice) * pos.legB.size * pos.leverage;

    // Accumulated funding from tracker
    const fundingSummary = this.fundingTracker.getCumulativeFunding(positionId);
    const fundingPnl = Number(fundingSummary.netTotal) / 1e18;

    // Total fees from close orders (open fees already accounted at entry)
    const longCloseFees = parseFloat(longCloseResult.fees || '0');
    const shortCloseFees = parseFloat(shortCloseResult.fees || '0');
    const totalFees = longCloseFees + shortCloseFees;

    const netPnl = longRealizedPnl + shortRealizedPnl + fundingPnl - totalFees;
    const exitTimestamp = Date.now();

    // Finalize funding tracking
    this.fundingTracker.finalizeFunding(positionId);

    // Update position in store (AC8)
    const closeData: StatArbCloseData = {
      reason: exitReason,
      closeTimestamp: exitTimestamp,
      closePnl: netPnl,
      legAClosePrice: longExitPrice,
      legBClosePrice: shortExitPrice,
    };

    this.store.closeStatArbPosition(positionId, closeData);

    const result: PairCloseResult = {
      positionId,
      longExitPrice,
      shortExitPrice,
      longRealizedPnl,
      shortRealizedPnl,
      fundingPnl,
      totalFees,
      netPnl,
      exitReason,
      exitTimestamp,
    };

    logger.info(
      {
        positionId,
        pair: pos.pair.key,
        exitReason,
        longRealizedPnl,
        shortRealizedPnl,
        fundingPnl,
        totalFees,
        netPnl,
        returnPercent: pos.marginUsed > 0 ? ((netPnl / pos.marginUsed) * 100).toFixed(2) : '0',
      },
      'Position closed with both legs',
    );

    return result;
  }

  // ---------------------------------------------------------------------------
  // Exit evaluation methods (AC3, AC4, AC5, AC6)
  // ---------------------------------------------------------------------------

  evaluateMeanReversionExit(
    position: StatArbPosition,
    currentZScore: number,
  ): ExitEvaluation {
    const shouldExit = Math.abs(currentZScore) <= this.config.exitZScoreThreshold;

    if (shouldExit) {
      logger.info(
        {
          positionId: position.positionId,
          pair: position.pair.key,
          currentZScore,
          threshold: this.config.exitZScoreThreshold,
        },
        'Mean reversion exit triggered',
      );
    }

    return {
      shouldExit,
      exitReason: shouldExit ? 'mean_reversion' : null,
      metadata: { exitZScore: currentZScore },
    };
  }

  evaluateTimeStopExit(
    position: StatArbPosition,
    currentTimestamp: number,
  ): ExitEvaluation {
    const holdingDurationMs = currentTimestamp - position.openTimestamp;
    const timeLimitMs = this.config.timeStopMultiplier * position.halfLifeHours * 3_600_000;
    const shouldExit = holdingDurationMs > timeLimitMs;

    if (shouldExit) {
      logger.warn(
        {
          positionId: position.positionId,
          pair: position.pair.key,
          holdingHours: (holdingDurationMs / 3_600_000).toFixed(1),
          limitHours: (timeLimitMs / 3_600_000).toFixed(1),
        },
        'Time stop exit triggered — statistical edge likely decayed',
      );
    }

    return {
      shouldExit,
      exitReason: shouldExit ? 'time_stop' : null,
      metadata: {
        holdingDurationMs,
        timeLimitMs,
        holdingHours: holdingDurationMs / 3_600_000,
        limitHours: timeLimitMs / 3_600_000,
      },
    };
  }

  evaluateStoplossExit(
    position: StatArbPosition,
    combinedUnrealizedPnl: number,
  ): ExitEvaluation {
    // Update combined PnL temporarily for the check
    const posWithPnl = { ...position, combinedPnl: combinedUnrealizedPnl };
    const stoplossPercent = this.config.maxLossPercent / 100;
    const shouldExit = calculateStoplossBreached(posWithPnl, stoplossPercent);

    if (shouldExit) {
      const lossPercent = position.marginUsed > 0
        ? (combinedUnrealizedPnl / position.marginUsed) * 100
        : 0;

      logger.error(
        {
          positionId: position.positionId,
          pair: position.pair.key,
          combinedPnl: combinedUnrealizedPnl,
          marginUsed: position.marginUsed,
          lossPercent: lossPercent.toFixed(2),
          longPnl: position.legA.unrealizedPnl,
          shortPnl: position.legB.unrealizedPnl,
          funding: position.accumulatedFunding,
        },
        'Stoploss exit triggered on combined P&L',
      );
    }

    return {
      shouldExit,
      exitReason: shouldExit ? 'stoploss' : null,
      metadata: {
        combinedPnl: combinedUnrealizedPnl,
        marginUsed: position.marginUsed,
        lossPercent: position.marginUsed > 0
          ? (combinedUnrealizedPnl / position.marginUsed) * 100
          : 0,
        maxLossPercent: this.config.maxLossPercent,
      },
    };
  }

  evaluateTelegramCloseExit(position: StatArbPosition): ExitEvaluation {
    // Check store for close signals matching this pair
    const signals = this.store.getAllStatArbSignals();
    const closeSignal = signals.find(
      (s) =>
        s.pair.key === position.pair.key &&
        s.consumed === false &&
        s.timestamp > position.openTimestamp,
    );

    // Also check the exit signals on the emitter
    // A telegram close is indicated by a signal with matching pair key after position opened
    if (!closeSignal) {
      return { shouldExit: false, exitReason: null, metadata: {} };
    }

    // Mark signal as consumed
    this.store.markSignalConsumed(position.pair.key);

    logger.info(
      {
        positionId: position.positionId,
        pair: position.pair.key,
        signalId: closeSignal.signalId,
      },
      'Telegram close signal received for pair',
    );

    return {
      shouldExit: true,
      exitReason: 'telegram_close',
      metadata: { telegramSignalId: closeSignal.signalId },
    };
  }

  /**
   * Evaluate all exit conditions in priority order:
   * 1. Stoploss (highest — risk management)
   * 2. Telegram close (external signal)
   * 3. Mean reversion (statistical target)
   * 4. Time stop (statistical decay)
   */
  evaluateAllExitConditions(
    position: StatArbPosition,
    currentZScore: number | undefined,
    currentTimestamp: number,
    combinedUnrealizedPnl: number,
  ): ExitEvaluation {
    // 1. Stoploss — highest priority
    const stoploss = this.evaluateStoplossExit(position, combinedUnrealizedPnl);
    if (stoploss.shouldExit) return stoploss;

    // 2. Telegram close
    const telegram = this.evaluateTelegramCloseExit(position);
    if (telegram.shouldExit) return telegram;

    // 3. Mean reversion
    if (currentZScore !== undefined) {
      const meanRev = this.evaluateMeanReversionExit(position, currentZScore);
      if (meanRev.shouldExit) return meanRev;
    }

    // 4. Time stop
    const timeStop = this.evaluateTimeStopExit(position, currentTimestamp);
    if (timeStop.shouldExit) return timeStop;

    return { shouldExit: false, exitReason: null, metadata: {} };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async placeCloseWithRetry(
    params: PerpOrderParams,
    positionId: string,
    legSide: 'long' | 'short',
  ): Promise<PerpOrderResult> {
    try {
      return await this.orderManager.placeOrder(params);
    } catch (firstError) {
      logger.warn(
        {
          positionId,
          symbol: params.symbol,
          legSide,
          error: firstError instanceof Error ? firstError.message : String(firstError),
        },
        'Close order failed, retrying once',
      );

      // Wait before retry
      await new Promise((resolve) => setTimeout(resolve, CLOSE_RETRY_DELAY_MS));

      try {
        return await this.orderManager.placeOrder(params);
      } catch (retryError) {
        logger.fatal(
          {
            positionId,
            symbol: params.symbol,
            legSide,
            firstError: firstError instanceof Error ? firstError.message : String(firstError),
            retryError: retryError instanceof Error ? retryError.message : String(retryError),
          },
          `Close order failed for ${legSide} leg after retry. Manual intervention required.`,
        );

        throw retryError;
      }
    }
  }
}
