// PairExecutor — stage pipeline: Trigger -> Open -> Manage -> Close
// Handles 'pair' action types via PearProtocolConnector.
// CRITICAL: Both legs MUST open and close simultaneously.
// Combined P&L for barrier evaluation, NOT individual legs.
// No partial closes EVER.

import { BaseExecutor } from './base-executor.js';
import type { StageResult } from './base-executor.js';
import type { ExecutorAction, PairAction } from '../core/action-types.js';
import type { ExecutionResult } from '../core/types.js';
import { transferId, chainId, tokenAddress } from '../core/types.js';
import { Store } from '../core/store.js';
import { createLogger } from '../utils/logger.js';
import type { PearProtocolConnectorInterface } from '../connectors/pear-protocol-connector.js';
import { randomUUID } from 'node:crypto';

const logger = createLogger('pair-executor');

const MAX_LEVERAGE = 10;
const MIN_LEVERAGE = 1;
const MAX_OPEN_PAIR_POSITIONS = 5;

// ---------------------------------------------------------------------------
// Internal position tracking
// ---------------------------------------------------------------------------

interface PairPosition {
  readonly id: string;
  readonly pairId: string;
  readonly longSymbol: string;
  readonly shortSymbol: string;
  readonly longSize: bigint;
  readonly shortSize: bigint;
  readonly leverage: number;
  readonly entrySpread: number;
  currentSpread: number;
  combinedPnl: number;
  readonly openTimestamp: number;
  readonly positionId: string; // from Pear Protocol
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface PairExecutorConfig {
  readonly maxLeverage: number;
  readonly maxOpenPositions: number;
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export class PairExecutor extends BaseExecutor {
  private readonly connector: PearProtocolConnectorInterface;
  private readonly executorConfig: PairExecutorConfig;
  private position: PairPosition | null = null;
  private readonly store: Store;

  constructor(
    connector: PearProtocolConnectorInterface,
    config: PairExecutorConfig,
  ) {
    super();
    this.connector = connector;
    this.executorConfig = config;
    this.store = Store.getInstance();
  }

  canHandle(action: ExecutorAction): boolean {
    return action.type === 'pair';
  }

  async execute(action: ExecutorAction): Promise<ExecutionResult> {
    this.position = null;
    return super.execute(action);
  }

  protected async trigger(action: ExecutorAction): Promise<StageResult> {
    const pair = action as PairAction;

    // Validate leverage
    const maxLev = Math.min(this.executorConfig.maxLeverage, MAX_LEVERAGE);
    if (pair.leverage < MIN_LEVERAGE || pair.leverage > maxLev) {
      return {
        success: false,
        error: `Leverage ${pair.leverage} out of range [${MIN_LEVERAGE}, ${maxLev}]`,
      };
    }

    // Check margin availability
    const margin = await this.connector.queryMargin();
    const longSizeDecimal = parseFloat(this.bigintToDecimal(pair.longSize, 6));
    const shortSizeDecimal = parseFloat(this.bigintToDecimal(pair.shortSize, 6));
    const totalNotional = longSizeDecimal + shortSizeDecimal;
    const requiredMargin = totalNotional / pair.leverage;

    if (margin.available < requiredMargin) {
      return {
        success: false,
        error: `Insufficient margin: need ${requiredMargin.toFixed(2)}, available ${margin.available.toFixed(2)}`,
      };
    }

    // Check position count
    const existingPositions = await this.connector.queryPositions();
    const maxPos = Math.min(
      this.executorConfig.maxOpenPositions,
      MAX_OPEN_PAIR_POSITIONS,
    );
    if (existingPositions.length >= maxPos) {
      return {
        success: false,
        error: `Max open positions reached: ${existingPositions.length}/${maxPos}`,
      };
    }

    // Validate spread divergence still valid
    const spreadData = await this.connector.querySpreadData(pair.pairId);
    const absZ = Math.abs(spreadData.zScore);
    // Require z-score still significant (at least 1.5 std devs) to avoid stale entries
    if (absZ < 1.5) {
      return {
        success: false,
        error: `Spread divergence no longer significant: z=${spreadData.zScore.toFixed(2)}`,
      };
    }

    logger.info(
      {
        pairId: pair.pairId,
        longSymbol: pair.longSymbol,
        shortSymbol: pair.shortSymbol,
        leverage: pair.leverage,
        zScore: spreadData.zScore,
      },
      'Trigger stage passed',
    );

    return {
      success: true,
      data: { entrySpread: spreadData.currentSpread },
    };
  }

  protected async open(action: ExecutorAction): Promise<StageResult> {
    const pair = action as PairAction;
    const longSizeStr = this.bigintToDecimal(pair.longSize, 6);
    const shortSizeStr = this.bigintToDecimal(pair.shortSize, 6);

    // Open BOTH legs simultaneously — single atomic call to Pear Protocol
    const result = await this.connector.openPairTrade(
      pair.pairId,
      longSizeStr,
      shortSizeStr,
      pair.leverage,
    );

    if (result.status !== 'ok') {
      return { success: false, error: result.error ?? 'Pair trade opening failed' };
    }

    const posId = randomUUID();
    const spreadData = await this.connector.querySpreadData(pair.pairId);

    this.position = {
      id: posId,
      pairId: pair.pairId,
      longSymbol: pair.longSymbol,
      shortSymbol: pair.shortSymbol,
      longSize: pair.longSize,
      shortSize: pair.shortSize,
      leverage: pair.leverage,
      entrySpread: spreadData.currentSpread,
      currentSpread: spreadData.currentSpread,
      combinedPnl: 0,
      openTimestamp: Date.now(),
      positionId: result.positionId ?? posId,
    };

    logger.info(
      {
        positionId: posId,
        pairId: pair.pairId,
        longSymbol: pair.longSymbol,
        shortSymbol: pair.shortSymbol,
        leverage: pair.leverage,
      },
      'Both legs opened simultaneously',
    );

    return {
      success: true,
      data: {
        positionId: posId,
        pearPositionId: result.positionId,
        entrySpread: spreadData.currentSpread,
      },
    };
  }

  protected async manage(action: ExecutorAction): Promise<StageResult> {
    if (!this.position) {
      return { success: false, error: 'No position to manage' };
    }

    const pair = action as PairAction;

    // Query current spread data from Pear Protocol
    const spreadData = await this.connector.querySpreadData(pair.pairId);
    this.position.currentSpread = spreadData.currentSpread;

    // Query current positions to get unrealized P&L
    const positions = await this.connector.queryPositions();
    const currentPos = positions.find((p) => p.pairId === pair.pairId);

    // Calculate COMBINED P&L (both legs together)
    if (currentPos) {
      this.position.combinedPnl = parseFloat(currentPos.unrealizedPnl);
    } else {
      // Estimate combined P&L from spread movement
      const spreadChange = this.position.currentSpread - this.position.entrySpread;
      const totalNotional =
        parseFloat(this.bigintToDecimal(this.position.longSize, 6)) +
        parseFloat(this.bigintToDecimal(this.position.shortSize, 6));
      this.position.combinedPnl = spreadChange * totalNotional * this.position.leverage;
    }

    // Evaluate Triple Barrier against COMBINED P&L (not individual legs)
    const stoploss = typeof pair.metadata['stoploss'] === 'number'
      ? pair.metadata['stoploss']
      : -0.08;
    const takeProfit = typeof pair.metadata['takeProfit'] === 'number'
      ? pair.metadata['takeProfit']
      : 0.16;
    const timeLimitMs = typeof pair.metadata['timeLimitMs'] === 'number'
      ? pair.metadata['timeLimitMs']
      : 4 * 60 * 60 * 1000;

    const totalNotional =
      parseFloat(this.bigintToDecimal(this.position.longSize, 6)) +
      parseFloat(this.bigintToDecimal(this.position.shortSize, 6));
    const marginUsed = totalNotional / this.position.leverage;
    const pnlPercent = marginUsed > 0 ? this.position.combinedPnl / marginUsed : 0;

    const elapsed = Date.now() - this.position.openTimestamp;

    // Check barriers — always based on COMBINED P&L
    if (pnlPercent <= stoploss) {
      logger.info(
        { pnlPercent, stoploss, combinedPnl: this.position.combinedPnl },
        'Stop-loss triggered on combined P&L',
      );
      return { success: true, data: { closeReason: 'stoploss', pnlPercent } };
    }

    if (pnlPercent >= takeProfit) {
      logger.info(
        { pnlPercent, takeProfit, combinedPnl: this.position.combinedPnl },
        'Take-profit triggered on combined P&L',
      );
      return { success: true, data: { closeReason: 'takeProfit', pnlPercent } };
    }

    if (elapsed >= timeLimitMs) {
      logger.info(
        { elapsed, timeLimitMs, pnlPercent },
        'Time-limit triggered',
      );
      return { success: true, data: { closeReason: 'timeLimit', pnlPercent } };
    }

    return {
      success: true,
      data: {
        closeReason: 'managed',
        pnlPercent,
        combinedPnl: this.position.combinedPnl,
        currentSpread: this.position.currentSpread,
      },
    };
  }

  protected async close(action: ExecutorAction): Promise<StageResult> {
    if (!this.position) {
      return { success: false, error: 'No position to close' };
    }

    // Close BOTH legs simultaneously — NEVER allow partial closes
    const result = await this.connector.closePairTrade(this.position.positionId);

    if (result.status !== 'ok') {
      return {
        success: false,
        error: result.error ?? 'Failed to close pair trade (both legs)',
      };
    }

    const realizedPnl = this.position.combinedPnl;

    // Record trade in store
    const tradeId = randomUUID();
    const ARBITRUM_CHAIN = chainId(42161);
    const ZERO_ADDRESS = tokenAddress('0x0000000000000000000000000000000000000000');

    this.store.addTrade({
      id: tradeId,
      strategyId: action.strategyId,
      fromChain: ARBITRUM_CHAIN,
      toChain: ARBITRUM_CHAIN,
      fromToken: ZERO_ADDRESS,
      toToken: ZERO_ADDRESS,
      fromAmount: this.position.longSize + this.position.shortSize,
      toAmount: this.position.longSize + this.position.shortSize,
      pnlUsd: realizedPnl,
      executedAt: Date.now(),
    });

    const tid = transferId(this.position.id);
    logger.info(
      {
        positionId: this.position.id,
        pairId: this.position.pairId,
        longSymbol: this.position.longSymbol,
        shortSymbol: this.position.shortSymbol,
        realizedPnl,
        entrySpread: this.position.entrySpread,
        exitSpread: this.position.currentSpread,
      },
      'Both legs closed simultaneously',
    );

    this.position = null;

    return {
      success: true,
      data: {
        transferId: tid,
        txHash: result.positionId ?? null,
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
