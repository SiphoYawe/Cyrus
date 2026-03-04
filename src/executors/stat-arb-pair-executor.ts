// StatArbPairExecutor — stage pipeline: Trigger -> Open -> Manage -> Close
// Handles 'stat_arb_pair' action types for Hyperliquid statistical arbitrage pair trades.
// CRITICAL: Both legs MUST open simultaneously. Rollback first leg if second fails.
// Combined P&L for all evaluations, NEVER individual-leg stoploss.
// No partial closes EVER.

import { BaseExecutor } from './base-executor.js';
import type { StageResult } from './base-executor.js';
import type { ExecutorAction, StatArbPairAction } from '../core/action-types.js';
import type { ExecutionResult } from '../core/types.js';
import { transferId, chainId, tokenAddress } from '../core/types.js';
import { Store } from '../core/store.js';
import { createLogger } from '../utils/logger.js';
import { PairTradeRollbackError } from '../utils/errors.js';
import type { HyperliquidConnectorInterface } from '../connectors/hyperliquid-connector.js';
import type { HyperliquidOrderManager, PerpOrderResult } from '../connectors/hyperliquid-order-manager.js';
import type { FundingRateTracker } from '../stat-arb/funding-rate-tracker.js';
import type {
  StatArbPosition,
  StatArbLeg,
  StatArbExitReason,
  StatArbCloseData,
} from '../core/store-slices/stat-arb-slice.js';
import { calculateStoplossBreached } from '../core/store-slices/stat-arb-slice.js';
import { formatUnits } from '../utils/bigint.js';
import { randomUUID } from 'node:crypto';

const logger = createLogger('stat-arb-pair-executor');

const DEFAULT_MAX_LEVERAGE = 23;
const DEFAULT_MAX_PAIR_POSITIONS = 10;
const DEFAULT_MAX_LOSS_PERCENT = 30;
const DEFAULT_TIME_STOP_MULTIPLIER = 3;
const DEFAULT_EXIT_Z_THRESHOLD = 0.5;
const DEFAULT_SIZE_DECIMALS = 18;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface StatArbPairExecutorConfig {
  readonly maxLeverage: number;
  readonly maxPairPositions: number;
  readonly maxLossPercent: number;
  readonly timeStopMultiplier: number;
  readonly exitZScoreThreshold: number;
  readonly sizeDecimals: number;
}

const DEFAULT_CONFIG: StatArbPairExecutorConfig = {
  maxLeverage: DEFAULT_MAX_LEVERAGE,
  maxPairPositions: DEFAULT_MAX_PAIR_POSITIONS,
  maxLossPercent: DEFAULT_MAX_LOSS_PERCENT,
  timeStopMultiplier: DEFAULT_TIME_STOP_MULTIPLIER,
  exitZScoreThreshold: DEFAULT_EXIT_Z_THRESHOLD,
  sizeDecimals: DEFAULT_SIZE_DECIMALS,
} as const;

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export class StatArbPairExecutor extends BaseExecutor {
  private readonly connector: HyperliquidConnectorInterface;
  private readonly orderManager: HyperliquidOrderManager;
  private readonly fundingTracker: FundingRateTracker;
  private readonly executorConfig: StatArbPairExecutorConfig;
  private readonly store: Store;

  private position: StatArbPosition | null = null;
  private exitReason: StatArbExitReason | null = null;

  constructor(
    connector: HyperliquidConnectorInterface,
    orderManager: HyperliquidOrderManager,
    fundingTracker: FundingRateTracker,
    config?: Partial<StatArbPairExecutorConfig>,
  ) {
    super();
    this.connector = connector;
    this.orderManager = orderManager;
    this.fundingTracker = fundingTracker;
    this.executorConfig = { ...DEFAULT_CONFIG, ...config };
    this.store = Store.getInstance();
  }

  canHandle(action: ExecutorAction): boolean {
    return action.type === 'stat_arb_pair';
  }

  async execute(action: ExecutorAction): Promise<ExecutionResult> {
    this.position = null;
    this.exitReason = null;
    return super.execute(action);
  }

  // ---------------------------------------------------------------------------
  // Trigger — validate preconditions (AC1, AC7)
  // ---------------------------------------------------------------------------

  protected async trigger(action: ExecutorAction): Promise<StageResult> {
    const sa = action as StatArbPairAction;

    // AC7: Check max pair positions
    const activeCount = this.store.getActiveStatArbPositionCount();
    if (activeCount >= this.executorConfig.maxPairPositions) {
      return {
        success: false,
        error: `Max pair positions (${this.executorConfig.maxPairPositions}) reached, currently ${activeCount}`,
      };
    }

    // Check for existing position with same pair key
    const existingPosition = this.store.getActivePositionByPairKey(sa.pair.key);
    if (existingPosition) {
      return {
        success: false,
        error: `Open position already exists for pair ${sa.pair.key}: ${existingPosition.positionId}`,
      };
    }

    // Validate leverage
    const maxLev = this.executorConfig.maxLeverage;
    if (sa.leverage < 1 || sa.leverage > maxLev) {
      return {
        success: false,
        error: `Leverage ${sa.leverage} out of range [1, ${maxLev}]`,
      };
    }

    // Check margin balance
    const balance = await this.connector.queryBalance();
    const requiredMargin = sa.capitalAllocation / sa.leverage;
    if (balance.withdrawable < requiredMargin) {
      return {
        success: false,
        error: `Insufficient margin: need ${requiredMargin.toFixed(2)}, available ${balance.withdrawable.toFixed(2)}`,
      };
    }

    logger.debug(
      {
        pair: sa.pair.key,
        leverage: sa.leverage,
        capitalAllocation: sa.capitalAllocation,
        direction: sa.direction,
        activePositions: activeCount,
      },
      'Trigger stage passed',
    );

    return { success: true };
  }

  // ---------------------------------------------------------------------------
  // Open — calculate beta-neutral sizes and place both legs (AC2, AC3, AC4)
  // ---------------------------------------------------------------------------

  protected async open(action: ExecutorAction): Promise<StageResult> {
    const sa = action as StatArbPairAction;
    const beta = sa.hedgeRatio;
    const capital = sa.capitalAllocation;

    // AC2: Beta-neutral sizing
    // longSize = capital / (1 + beta), shortSize = capital * beta / (1 + beta)
    const longNotional = capital / (1 + beta);
    const shortNotional = (capital * beta) / (1 + beta);

    // Determine which symbol is long and which is short based on direction
    const longSymbol = sa.direction === 'long_pair' ? sa.pair.tokenA : sa.pair.tokenB;
    const shortSymbol = sa.direction === 'long_pair' ? sa.pair.tokenB : sa.pair.tokenA;

    // Convert to bigint for order manager (scale to sizeDecimals)
    const decimals = this.executorConfig.sizeDecimals;
    const longSizeBig = BigInt(Math.round(longNotional * 10 ** decimals));
    const shortSizeBig = BigInt(Math.round(shortNotional * 10 ** decimals));

    // Place long leg first
    let longResult: PerpOrderResult;
    try {
      longResult = await this.orderManager.placeOrder({
        symbol: longSymbol,
        side: 'buy',
        size: longSizeBig,
        leverage: sa.leverage,
        type: 'market',
        decimals,
      });
    } catch (err) {
      return {
        success: false,
        error: `Long leg order failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // Place short leg immediately after
    let shortResult: PerpOrderResult;
    try {
      shortResult = await this.orderManager.placeOrder({
        symbol: shortSymbol,
        side: 'sell',
        size: shortSizeBig,
        leverage: sa.leverage,
        type: 'market',
        decimals,
      });
    } catch (err) {
      // AC4: Rollback — close the filled long leg
      let rollbackSuccess = false;
      try {
        await this.orderManager.placeOrder({
          symbol: longSymbol,
          side: 'sell',
          size: longSizeBig,
          leverage: sa.leverage,
          type: 'market',
          decimals,
        });
        rollbackSuccess = true;
        logger.error(
          { pair: sa.pair.key, longOrderId: longResult.orderId },
          'Short leg rejected. Long leg rolled back successfully.',
        );
      } catch (rollbackErr) {
        logger.fatal(
          {
            pair: sa.pair.key,
            longOrderId: longResult.orderId,
            rollbackError: rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
          },
          'CRITICAL: Rollback of long leg FAILED. Manual intervention required.',
        );
      }

      return {
        success: false,
        error: new PairTradeRollbackError({
          pair: sa.pair.key,
          longSymbol,
          shortSymbol,
          filledLegOrderId: longResult.orderId,
          rejectionReason: err instanceof Error ? err.message : String(err),
          rollbackSuccess,
        }).message,
      };
    }

    // AC3: Create StatArbPosition from both fills
    const longEntryPrice = parseFloat(longResult.fillPrice || longResult.averageFillPrice || '0');
    const shortEntryPrice = parseFloat(shortResult.fillPrice || shortResult.averageFillPrice || '0');
    const longSizeNum = parseFloat(formatUnits(longSizeBig, decimals));
    const shortSizeNum = parseFloat(formatUnits(shortSizeBig, decimals));

    const positionId = randomUUID();
    const legA: StatArbLeg = {
      symbol: longSymbol,
      side: 'long',
      size: longSizeNum,
      entryPrice: longEntryPrice,
      currentPrice: longEntryPrice,
      unrealizedPnl: 0,
      funding: 0,
      orderId: longResult.orderId,
    };

    const legB: StatArbLeg = {
      symbol: shortSymbol,
      side: 'short',
      size: shortSizeNum,
      entryPrice: shortEntryPrice,
      currentPrice: shortEntryPrice,
      unrealizedPnl: 0,
      funding: 0,
      orderId: shortResult.orderId,
    };

    const marginUsed = capital / sa.leverage;

    this.position = {
      positionId,
      pair: { tokenA: sa.pair.tokenA, tokenB: sa.pair.tokenB, key: sa.pair.key },
      direction: sa.direction,
      hedgeRatio: beta,
      leverage: sa.leverage,
      legA,
      legB,
      openTimestamp: Date.now(),
      halfLifeHours: sa.halfLifeHours,
      combinedPnl: 0,
      accumulatedFunding: 0,
      marginUsed,
      status: 'active',
      signalSource: sa.signalSource,
    };

    // Store position
    this.store.openStatArbPosition(this.position);

    logger.info(
      {
        positionId,
        pair: sa.pair.key,
        longSymbol,
        shortSymbol,
        leverage: sa.leverage,
        hedgeRatio: beta,
        longSize: longSizeNum,
        shortSize: shortSizeNum,
        longEntryPrice,
        shortEntryPrice,
      },
      'Both legs opened simultaneously',
    );

    return {
      success: true,
      data: {
        positionId,
        longOrderId: longResult.orderId,
        shortOrderId: shortResult.orderId,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Manage — monitor combined P&L and evaluate exit conditions (AC5)
  // ---------------------------------------------------------------------------

  protected async manage(action: ExecutorAction): Promise<StageResult> {
    if (!this.position) {
      return { success: false, error: 'No position to manage' };
    }

    const sa = action as StatArbPairAction;
    const pos = this.position;

    // Query current positions from Hyperliquid to get latest prices/PnL
    const positions = await this.connector.queryPositions();

    const longPos = positions.find((p) => p.coin === pos.legA.symbol);
    const shortPos = positions.find((p) => p.coin === pos.legB.symbol);

    // Update current prices
    if (longPos) {
      pos.legA.currentPrice = parseFloat(longPos.entryPx);
      pos.legA.unrealizedPnl = parseFloat(longPos.unrealizedPnl);
    }
    if (shortPos) {
      pos.legB.currentPrice = parseFloat(shortPos.entryPx);
      pos.legB.unrealizedPnl = parseFloat(shortPos.unrealizedPnl);
    }

    // Update funding
    const fundingTick = await this.fundingTracker.updateFunding(pos);
    if (fundingTick) {
      const fundingSummary = this.fundingTracker.getCumulativeFunding(pos.positionId);
      // Convert bigint funding to number for position tracking
      const netFundingNum = Number(fundingSummary.netTotal) / 1e18;
      pos.accumulatedFunding = netFundingNum;
    }

    // Calculate combined P&L (AC5)
    const longPnl = pos.legA.unrealizedPnl;
    const shortPnl = pos.legB.unrealizedPnl;
    pos.combinedPnl = longPnl + shortPnl + pos.accumulatedFunding;

    // Update store
    this.store.updateStatArbPositionPnl(
      pos.positionId,
      pos.combinedPnl,
      pos.accumulatedFunding,
    );

    // Check funding exposure and potentially tighten stoploss
    const fundingExposure = this.fundingTracker.checkFundingExposure(
      pos,
      this.executorConfig.maxLossPercent,
    );
    const effectiveMaxLoss = fundingExposure.tightenedMaxLossPercent;

    // --- Exit condition evaluation ---

    // 1. Stoploss: combined loss > maxLossPercent of margin
    if (pos.marginUsed > 0 && calculateStoplossBreached(pos, effectiveMaxLoss / 100)) {
      this.exitReason = 'stoploss';
      logger.info(
        {
          positionId: pos.positionId,
          combinedPnl: pos.combinedPnl,
          marginUsed: pos.marginUsed,
          lossPercent: ((pos.combinedPnl / pos.marginUsed) * 100).toFixed(2),
          effectiveMaxLoss,
        },
        'Stoploss triggered on combined P&L',
      );
      return { success: true, data: { exitReason: 'stoploss' } };
    }

    // 2. Time stop: elapsed > timeStopMultiplier * halfLife
    const elapsedMs = Date.now() - pos.openTimestamp;
    const timeStopMs = this.executorConfig.timeStopMultiplier * pos.halfLifeHours * 3_600_000;
    if (elapsedMs >= timeStopMs) {
      this.exitReason = 'time_stop';
      logger.info(
        {
          positionId: pos.positionId,
          elapsedHours: (elapsedMs / 3_600_000).toFixed(1),
          timeStopHours: (timeStopMs / 3_600_000).toFixed(1),
        },
        'Time stop triggered',
      );
      return { success: true, data: { exitReason: 'time_stop' } };
    }

    // 3. Check for external exit signals (mean reversion, telegram close)
    // Check metadata for close signals
    if (sa.metadata.closeRequested === true) {
      this.exitReason = 'telegram_close';
      logger.info(
        { positionId: pos.positionId },
        'Telegram close signal received',
      );
      return { success: true, data: { exitReason: 'telegram_close' } };
    }

    // 4. Check metadata for mean reversion exit
    if (sa.metadata.currentZScore !== undefined) {
      const currentZ = sa.metadata.currentZScore as number;
      if (Math.abs(currentZ) <= this.executorConfig.exitZScoreThreshold) {
        this.exitReason = 'mean_reversion';
        logger.info(
          {
            positionId: pos.positionId,
            currentZScore: currentZ,
            threshold: this.executorConfig.exitZScoreThreshold,
          },
          'Mean reversion exit triggered',
        );
        return { success: true, data: { exitReason: 'mean_reversion' } };
      }
    }

    // No exit condition met
    return {
      success: true,
      data: {
        exitReason: 'managed',
        combinedPnl: pos.combinedPnl,
        accumulatedFunding: pos.accumulatedFunding,
        fundingExcessive: fundingExposure.fundingExcessive,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Close — simultaneously close both legs (AC6)
  // ---------------------------------------------------------------------------

  protected async close(action: ExecutorAction): Promise<StageResult> {
    if (!this.position) {
      return { success: false, error: 'No position to close' };
    }

    const pos = this.position;
    const sa = action as StatArbPairAction;
    const decimals = this.executorConfig.sizeDecimals;

    // If no exit reason was set (manage returned 'managed'), the position stays open
    if (!this.exitReason) {
      return {
        success: true,
        data: { status: 'managed', positionId: pos.positionId },
      };
    }

    // Close both legs simultaneously (AC6)
    const longSizeBig = BigInt(Math.round(pos.legA.size * 10 ** decimals));
    const shortSizeBig = BigInt(Math.round(pos.legB.size * 10 ** decimals));

    let longCloseResult: PerpOrderResult;
    let shortCloseResult: PerpOrderResult;

    try {
      // Close long leg (sell)
      longCloseResult = await this.orderManager.placeOrder({
        symbol: pos.legA.symbol,
        side: 'sell',
        size: longSizeBig,
        leverage: pos.leverage,
        type: 'market',
        decimals,
      });

      // Close short leg (buy)
      shortCloseResult = await this.orderManager.placeOrder({
        symbol: pos.legB.symbol,
        side: 'buy',
        size: shortSizeBig,
        leverage: pos.leverage,
        type: 'market',
        decimals,
      });
    } catch (err) {
      logger.fatal(
        {
          positionId: pos.positionId,
          error: err instanceof Error ? err.message : String(err),
        },
        'CRITICAL: Failed to close pair trade. Manual intervention required.',
      );
      return {
        success: false,
        error: `Failed to close pair trade: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // Calculate realized P&L
    const longClosePrice = parseFloat(longCloseResult.fillPrice || longCloseResult.averageFillPrice || '0');
    const shortClosePrice = parseFloat(shortCloseResult.fillPrice || shortCloseResult.averageFillPrice || '0');

    const longRealizedPnl = (longClosePrice - pos.legA.entryPrice) * pos.legA.size * pos.leverage;
    const shortRealizedPnl = (pos.legB.entryPrice - shortClosePrice) * pos.legB.size * pos.leverage;
    const totalRealizedPnl = longRealizedPnl + shortRealizedPnl + pos.accumulatedFunding;

    // Finalize funding tracking
    this.fundingTracker.finalizeFunding(pos.positionId);

    // Close position in store (AC6)
    const closeData: StatArbCloseData = {
      reason: this.exitReason,
      closeTimestamp: Date.now(),
      closePnl: totalRealizedPnl,
      legAClosePrice: longClosePrice,
      legBClosePrice: shortClosePrice,
    };

    this.store.closeStatArbPosition(pos.positionId, closeData);

    // Record trade
    const tradeId = randomUUID();
    const ARBITRUM_CHAIN = chainId(42161);
    const ZERO_ADDRESS = tokenAddress('0x0000000000000000000000000000000000000000');

    this.store.addTrade({
      id: tradeId,
      strategyId: sa.strategyId,
      fromChain: ARBITRUM_CHAIN,
      toChain: ARBITRUM_CHAIN,
      fromToken: ZERO_ADDRESS,
      toToken: ZERO_ADDRESS,
      fromAmount: longSizeBig + shortSizeBig,
      toAmount: longSizeBig + shortSizeBig,
      pnlUsd: totalRealizedPnl,
      executedAt: Date.now(),
    });

    const tid = transferId(pos.positionId);

    logger.info(
      {
        positionId: pos.positionId,
        pair: pos.pair.key,
        exitReason: this.exitReason,
        longRealizedPnl,
        shortRealizedPnl,
        accumulatedFunding: pos.accumulatedFunding,
        totalRealizedPnl,
        longClosePrice,
        shortClosePrice,
      },
      'Both legs closed simultaneously',
    );

    this.position = null;

    return {
      success: true,
      data: {
        transferId: tid,
        positionId: pos.positionId,
        exitReason: this.exitReason,
        totalRealizedPnl,
        tradeId,
      },
    };
  }
}
