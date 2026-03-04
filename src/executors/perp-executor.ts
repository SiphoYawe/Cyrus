// PerpExecutor — stage pipeline: Trigger -> Open -> Manage -> Close
// Handles 'perp' action types via HyperliquidConnector

import { BaseExecutor } from './base-executor.js';
import type { StageResult } from './base-executor.js';
import type { ExecutorAction, PerpAction } from '../core/action-types.js';
import type { ExecutionResult } from '../core/types.js';
import { transferId, chainId, tokenAddress } from '../core/types.js';
import { Store } from '../core/store.js';
import { createLogger } from '../utils/logger.js';
import type { HyperliquidConnectorInterface } from '../connectors/hyperliquid-connector.js';
import type { PerpPosition } from '../connectors/hyperliquid-types.js';
import { randomUUID } from 'node:crypto';

const logger = createLogger('perp-executor');

const MAX_LEVERAGE = 50;
const MIN_LEVERAGE = 1;

export interface PerpExecutorConfig {
  readonly maxLeverage: number;
  readonly defaultSlippage: number;
  readonly maxFundingRateThreshold: number;
  readonly positionPollIntervalMs?: number;
}

export class PerpExecutor extends BaseExecutor {
  private readonly connector: HyperliquidConnectorInterface;
  private readonly executorConfig: PerpExecutorConfig;
  private position: PerpPosition | null = null;
  private readonly store: Store;

  constructor(
    connector: HyperliquidConnectorInterface,
    config: PerpExecutorConfig,
  ) {
    super();
    this.connector = connector;
    this.executorConfig = config;
    this.store = Store.getInstance();
  }

  canHandle(action: ExecutorAction): boolean {
    return action.type === 'perp';
  }

  async execute(action: ExecutorAction): Promise<ExecutionResult> {
    this.position = null;
    return super.execute(action);
  }

  protected async trigger(action: ExecutorAction): Promise<StageResult> {
    const perp = action as PerpAction;

    // Validate leverage
    const maxLev = Math.min(this.executorConfig.maxLeverage, MAX_LEVERAGE);
    if (perp.leverage < MIN_LEVERAGE || perp.leverage > maxLev) {
      return {
        success: false,
        error: `Leverage ${perp.leverage} out of range [${MIN_LEVERAGE}, ${maxLev}]`,
      };
    }

    // Check margin — convert size from wei (18 decimals) to decimal for USD comparison
    const balance = await this.connector.queryBalance();
    const sizeDecimal = parseFloat(this.bigintToDecimal(perp.size, 18));
    const requiredMargin = sizeDecimal / perp.leverage;
    if (balance.withdrawable < requiredMargin) {
      return {
        success: false,
        error: `Insufficient margin: need ${requiredMargin}, available ${balance.withdrawable}`,
      };
    }

    // Check funding rate conditions if configured
    if (this.executorConfig.maxFundingRateThreshold > 0) {
      const fundingRates = await this.connector.queryFundingRates();
      const rate = fundingRates.get(perp.symbol);
      if (
        rate &&
        Math.abs(parseFloat(rate.fundingRate)) > this.executorConfig.maxFundingRateThreshold
      ) {
        logger.warn(
          { symbol: perp.symbol, fundingRate: rate.fundingRate },
          'Funding rate exceeds threshold',
        );
        // Don't block, just warn -- strategy should have considered this
      }
    }

    logger.info(
      { symbol: perp.symbol, side: perp.side, leverage: perp.leverage },
      'Trigger stage passed',
    );
    return { success: true };
  }

  protected async open(action: ExecutorAction): Promise<StageResult> {
    const perp = action as PerpAction;
    const sizeStr = this.bigintToDecimal(perp.size, 18);

    let result;
    if (perp.orderType === 'market') {
      result = await this.connector.placeMarketOrder(
        perp.symbol,
        perp.side,
        sizeStr,
        perp.leverage,
      );
    } else {
      if (perp.limitPrice === undefined) {
        return { success: false, error: 'Limit price required for limit orders' };
      }
      result = await this.connector.placeLimitOrder(
        perp.symbol,
        perp.side,
        sizeStr,
        perp.limitPrice.toString(),
        perp.leverage,
        perp.timeInForce ?? 'GTC',
      );
    }

    if (result.status !== 'ok') {
      return { success: false, error: result.error ?? 'Order placement failed' };
    }

    const posId = randomUUID();
    this.position = {
      id: posId,
      symbol: perp.symbol,
      side: perp.side,
      size: perp.size,
      entryPrice: parseFloat(result.avgPrice ?? '0'),
      currentPrice: parseFloat(result.avgPrice ?? '0'),
      leverage: perp.leverage,
      unrealizedPnl: 0,
      accumulatedFunding: 0,
      openTimestamp: Date.now(),
      orderId: result.orderId ?? null,
    };

    logger.info(
      {
        positionId: posId,
        symbol: perp.symbol,
        side: perp.side,
        orderId: result.orderId,
      },
      'Position opened',
    );

    return {
      success: true,
      data: { positionId: posId, orderId: result.orderId },
    };
  }

  protected async manage(action: ExecutorAction): Promise<StageResult> {
    if (!this.position) {
      return { success: false, error: 'No position to manage' };
    }

    const perp = action as PerpAction;

    // Query current position state from the exchange
    const positions = await this.connector.queryPositions();
    const currentPos = positions.find((p) => p.coin === perp.symbol);

    if (currentPos) {
      // Update position tracking
      this.position.currentPrice = parseFloat(currentPos.entryPx);
      this.position.unrealizedPnl = parseFloat(currentPos.unrealizedPnl);
    }

    // Query and accumulate funding
    const fundingRates = await this.connector.queryFundingRates();
    const rate = fundingRates.get(perp.symbol);
    if (rate) {
      const sizeDecimal = parseFloat(this.bigintToDecimal(this.position.size, 18));
      const fundingPayment = parseFloat(rate.fundingRate) * sizeDecimal;
      this.position.accumulatedFunding += fundingPayment;
    }

    // Calculate combined P&L
    const combinedPnl = this.position.unrealizedPnl + this.position.accumulatedFunding;

    // Evaluate Triple Barrier from action metadata
    const stoploss = typeof perp.metadata.stoploss === 'number' ? perp.metadata.stoploss : -0.1;
    const takeProfit = typeof perp.metadata.takeProfit === 'number' ? perp.metadata.takeProfit : 0.05;
    const timeLimitMs = typeof perp.metadata.timeLimitMs === 'number' ? perp.metadata.timeLimitMs : 24 * 60 * 60 * 1000;

    const sizeForPnl = parseFloat(this.bigintToDecimal(this.position.size, 18));
    const pnlPercent =
      this.position.entryPrice > 0
        ? combinedPnl / (sizeForPnl / this.position.leverage)
        : 0;

    const elapsed = Date.now() - this.position.openTimestamp;

    // Check barriers
    if (pnlPercent <= stoploss) {
      logger.info({ pnlPercent, stoploss }, 'Stop-loss triggered');
      return { success: true, data: { closeReason: 'stoploss', pnlPercent } };
    }

    if (pnlPercent >= takeProfit) {
      logger.info({ pnlPercent, takeProfit }, 'Take-profit triggered');
      return { success: true, data: { closeReason: 'takeProfit', pnlPercent } };
    }

    if (elapsed >= timeLimitMs) {
      logger.info({ elapsed, timeLimitMs }, 'Time-limit triggered');
      return { success: true, data: { closeReason: 'timeLimit', pnlPercent } };
    }

    // Position still active -- no barrier hit. In real execution this would
    // wait/poll. For the stage pipeline, we return success to proceed to close
    // only when a barrier is hit. Here we simulate immediate barrier evaluation.
    return {
      success: true,
      data: { closeReason: 'managed', pnlPercent, combinedPnl },
    };
  }

  protected async close(action: ExecutorAction): Promise<StageResult> {
    if (!this.position) {
      return { success: false, error: 'No position to close' };
    }

    const perp = action as PerpAction;
    const result = await this.connector.closePosition(perp.symbol);

    if (result.status !== 'ok') {
      return { success: false, error: result.error ?? 'Failed to close position' };
    }

    const realizedPnl = this.position.unrealizedPnl + this.position.accumulatedFunding;

    // Record trade
    const tradeId = randomUUID();
    const ARBITRUM_CHAIN = chainId(42161);
    const ZERO_ADDRESS = tokenAddress('0x0000000000000000000000000000000000000000');
    this.store.addTrade({
      id: tradeId,
      strategyId: perp.strategyId,
      fromChain: ARBITRUM_CHAIN,
      toChain: ARBITRUM_CHAIN,
      fromToken: ZERO_ADDRESS,
      toToken: ZERO_ADDRESS,
      fromAmount: this.position.size,
      toAmount: this.position.size,
      pnlUsd: realizedPnl,
      executedAt: Date.now(),
    });

    const tid = transferId(this.position.id);
    logger.info(
      {
        positionId: this.position.id,
        symbol: this.position.symbol,
        side: this.position.side,
        realizedPnl,
        accumulatedFunding: this.position.accumulatedFunding,
      },
      'Position closed',
    );

    this.position = null;

    return {
      success: true,
      data: {
        transferId: tid,
        txHash: result.orderId?.toString() ?? null,
        realizedPnl,
        tradeId,
      },
    };
  }

  private bigintToDecimal(value: bigint, decimals: number): string {
    const str = value.toString();
    if (decimals === 0) return str;
    if (str.length <= decimals) {
      return '0.' + str.padStart(decimals, '0');
    }
    const intPart = str.slice(0, str.length - decimals);
    const fracPart = str.slice(str.length - decimals);
    return `${intPart}.${fracPart}`;
  }
}
