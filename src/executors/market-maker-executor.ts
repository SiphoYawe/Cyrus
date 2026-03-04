// MarketMakerExecutor — stage pipeline: Trigger -> Open -> Manage -> Close
// Handles 'market_make' action types with simulated order book interaction

import { BaseExecutor } from './base-executor.js';
import type { StageResult } from './base-executor.js';
import type { ExecutorAction, MarketMakeAction } from '../core/action-types.js';
import type { ExecutionResult } from '../core/types.js';
import { transferId, chainId, tokenAddress } from '../core/types.js';
import { Store } from '../core/store.js';
import { createLogger } from '../utils/logger.js';
import { randomUUID } from 'node:crypto';

const logger = createLogger('market-maker-executor');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ManagedOrder {
  readonly id: string;
  readonly side: 'bid' | 'ask';
  readonly level: number;
  readonly price: number;
  readonly size: bigint;
  status: 'open' | 'filled' | 'cancelled';
}

export interface MarketMakerExecutorConfig {
  readonly minCapitalUsd: number;
  readonly maxSpread: number;
  readonly maxLevels: number;
  readonly staleOrderThreshold: number;
  readonly fillSimulation: boolean; // when true, simulate fills for testing
}

export interface FillRecord {
  readonly orderId: string;
  readonly side: 'bid' | 'ask';
  readonly price: number;
  readonly size: bigint;
  readonly timestamp: number;
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export class MarketMakerExecutor extends BaseExecutor {
  private readonly executorConfig: MarketMakerExecutorConfig;
  private readonly store: Store;
  private orders: ManagedOrder[] = [];
  private fills: FillRecord[] = [];
  private midPriceAtOpen: number = 0;
  private totalPnl: number = 0;

  constructor(config: MarketMakerExecutorConfig) {
    super();
    this.executorConfig = config;
    this.store = Store.getInstance();
  }

  canHandle(action: ExecutorAction): boolean {
    return action.type === 'market_make';
  }

  async execute(action: ExecutorAction): Promise<ExecutionResult> {
    // Reset state per execution
    this.orders = [];
    this.fills = [];
    this.midPriceAtOpen = 0;
    this.totalPnl = 0;
    return super.execute(action);
  }

  // --- Trigger: validate capital and market conditions ---

  protected async trigger(action: ExecutorAction): Promise<StageResult> {
    const mm = action as MarketMakeAction;

    // Validate spread bounds
    if (mm.spread <= 0 || mm.spread > this.executorConfig.maxSpread) {
      return {
        success: false,
        error: `Spread ${mm.spread} out of range (0, ${this.executorConfig.maxSpread}]`,
      };
    }

    // Validate levels
    if (mm.levels < 1 || mm.levels > this.executorConfig.maxLevels) {
      return {
        success: false,
        error: `Levels ${mm.levels} out of range [1, ${this.executorConfig.maxLevels}]`,
      };
    }

    // Validate order size
    if (mm.orderSize <= 0n) {
      return {
        success: false,
        error: 'Order size must be positive',
      };
    }

    // Validate mid price from metadata
    const midPrice = typeof mm.metadata['midPrice'] === 'number'
      ? mm.metadata['midPrice']
      : 0;

    if (midPrice <= 0) {
      return {
        success: false,
        error: 'Invalid mid price: must be positive',
      };
    }

    // Check minimum capital (total order value across all levels)
    const totalOrderValueUsd = Number(mm.orderSize) * mm.levels * 2; // bids + asks
    if (totalOrderValueUsd < this.executorConfig.minCapitalUsd) {
      return {
        success: false,
        error: `Insufficient capital: total order value ${totalOrderValueUsd} < min ${this.executorConfig.minCapitalUsd}`,
      };
    }

    this.midPriceAtOpen = midPrice;

    logger.info(
      {
        symbol: mm.symbol,
        spread: mm.spread,
        levels: mm.levels,
        midPrice,
      },
      'Trigger stage passed',
    );

    return { success: true, data: { midPrice } };
  }

  // --- Open: place multi-level bid/ask orders ---

  protected async open(action: ExecutorAction): Promise<StageResult> {
    const mm = action as MarketMakeAction;
    const midPrice = this.midPriceAtOpen;

    if (midPrice <= 0) {
      return { success: false, error: 'No mid price available from trigger stage' };
    }

    // Generate order levels from metadata or compute fresh
    const orderLevels = mm.metadata['orderLevels'] as
      | { level: number; bidPrice: number; askPrice: number; size: bigint }[]
      | undefined;

    if (orderLevels && orderLevels.length > 0) {
      // Use strategy-computed levels
      for (const level of orderLevels) {
        const bidOrder: ManagedOrder = {
          id: randomUUID(),
          side: 'bid',
          level: level.level,
          price: level.bidPrice,
          size: level.size,
          status: 'open',
        };

        const askOrder: ManagedOrder = {
          id: randomUUID(),
          side: 'ask',
          level: level.level,
          price: level.askPrice,
          size: level.size,
          status: 'open',
        };

        this.orders.push(bidOrder, askOrder);
      }
    } else {
      // Fallback: compute levels from spread
      for (let i = 1; i <= mm.levels; i++) {
        const levelMultiplier = i * 0.5;
        const bidPrice = midPrice * (1 - mm.spread * levelMultiplier);
        const askPrice = midPrice * (1 + mm.spread * levelMultiplier);

        const bidOrder: ManagedOrder = {
          id: randomUUID(),
          side: 'bid',
          level: i,
          price: bidPrice,
          size: mm.orderSize,
          status: 'open',
        };

        const askOrder: ManagedOrder = {
          id: randomUUID(),
          side: 'ask',
          level: i,
          price: askPrice,
          size: mm.orderSize,
          status: 'open',
        };

        this.orders.push(bidOrder, askOrder);
      }
    }

    logger.info(
      { orderCount: this.orders.length, symbol: mm.symbol },
      'Orders placed',
    );

    return {
      success: true,
      data: { orderCount: this.orders.length },
    };
  }

  // --- Manage: detect stale orders, handle fills, update inventory ---

  protected async manage(action: ExecutorAction): Promise<StageResult> {
    const mm = action as MarketMakeAction;
    const currentMidPrice = typeof mm.metadata['midPrice'] === 'number'
      ? mm.metadata['midPrice']
      : this.midPriceAtOpen;

    const staleThreshold = typeof mm.metadata['staleOrderThreshold'] === 'number'
      ? mm.metadata['staleOrderThreshold']
      : this.executorConfig.staleOrderThreshold;

    // Detect and handle stale orders
    let staleCount = 0;
    let replacementCount = 0;
    for (const order of this.orders) {
      if (order.status !== 'open') continue;

      const deviation = Math.abs(order.price - currentMidPrice) / currentMidPrice;
      const expectedDeviation = this.config_spread(mm) * order.level * 0.5;

      // Order is stale if its price deviates significantly from expected level
      if (Math.abs(deviation - expectedDeviation) > staleThreshold) {
        order.status = 'cancelled';
        staleCount++;

        // Place replacement at correct level
        const levelMultiplier = order.level * 0.5;
        const newPrice = order.side === 'bid'
          ? currentMidPrice * (1 - mm.spread * levelMultiplier)
          : currentMidPrice * (1 + mm.spread * levelMultiplier);

        const replacement: ManagedOrder = {
          id: randomUUID(),
          side: order.side,
          level: order.level,
          price: newPrice,
          size: order.size,
          status: 'open',
        };
        this.orders.push(replacement);
        replacementCount++;
      }
    }

    // Simulate fills if configured (for testing)
    if (this.executorConfig.fillSimulation) {
      this.simulateFills(currentMidPrice);
    }

    // Calculate running P&L from fills
    this.totalPnl = this.calculatePnl();

    logger.info(
      {
        staleCount,
        replacementCount,
        totalFills: this.fills.length,
        pnl: this.totalPnl,
      },
      'Manage stage completed',
    );

    return {
      success: true,
      data: {
        staleCount,
        replacementCount,
        fillCount: this.fills.length,
        pnl: this.totalPnl,
        openOrders: this.orders.filter((o) => o.status === 'open').length,
      },
    };
  }

  // --- Close: cancel all orders, report P&L ---

  protected async close(action: ExecutorAction): Promise<StageResult> {
    const mm = action as MarketMakeAction;

    // Cancel all open orders
    let cancelledCount = 0;
    for (const order of this.orders) {
      if (order.status === 'open') {
        order.status = 'cancelled';
        cancelledCount++;
      }
    }

    // Record trade in store
    const tradeId = randomUUID();
    const ARBITRUM_CHAIN = chainId(42161);
    const ZERO_ADDRESS = tokenAddress('0x0000000000000000000000000000000000000000');

    this.store.addTrade({
      id: tradeId,
      strategyId: mm.strategyId,
      fromChain: ARBITRUM_CHAIN,
      toChain: ARBITRUM_CHAIN,
      fromToken: ZERO_ADDRESS,
      toToken: ZERO_ADDRESS,
      fromAmount: mm.orderSize * BigInt(mm.levels),
      toAmount: mm.orderSize * BigInt(mm.levels),
      pnlUsd: this.totalPnl,
      executedAt: Date.now(),
    });

    const tid = transferId(tradeId);

    logger.info(
      {
        cancelledCount,
        totalFills: this.fills.length,
        pnl: this.totalPnl,
        tradeId,
      },
      'Market maker session closed',
    );

    return {
      success: true,
      data: {
        transferId: tid,
        txHash: null,
        cancelledCount,
        fillCount: this.fills.length,
        pnl: this.totalPnl,
        tradeId,
      },
    };
  }

  // --- Accessors for testing ---

  /** Get all managed orders. */
  getOrders(): readonly ManagedOrder[] {
    return this.orders;
  }

  /** Get all fill records. */
  getFills(): readonly FillRecord[] {
    return this.fills;
  }

  /** Get current total P&L. */
  getPnl(): number {
    return this.totalPnl;
  }

  // --- Private helpers ---

  private config_spread(mm: MarketMakeAction): number {
    return mm.spread;
  }

  /**
   * Simulate order fills based on mid price movement.
   * Bids fill when mid price drops to or below bid price.
   * Asks fill when mid price rises to or above ask price.
   */
  private simulateFills(currentMidPrice: number): void {
    for (const order of this.orders) {
      if (order.status !== 'open') continue;

      let shouldFill = false;
      if (order.side === 'bid' && currentMidPrice <= order.price) {
        shouldFill = true;
      } else if (order.side === 'ask' && currentMidPrice >= order.price) {
        shouldFill = true;
      }

      if (shouldFill) {
        order.status = 'filled';
        this.fills.push({
          orderId: order.id,
          side: order.side,
          price: order.price,
          size: order.size,
          timestamp: Date.now(),
        });
      }
    }
  }

  /**
   * Calculate P&L from fills.
   * For each bid fill we bought at the bid price.
   * For each ask fill we sold at the ask price.
   * Net P&L = sum of (ask fills * ask price) - sum of (bid fills * bid price)
   * normalized to number of matched pairs.
   */
  private calculatePnl(): number {
    let bidValue = 0;
    let askValue = 0;
    let bidVolume = 0n;
    let askVolume = 0n;

    for (const fill of this.fills) {
      if (fill.side === 'bid') {
        bidValue += fill.price * Number(fill.size);
        bidVolume += fill.size;
      } else {
        askValue += fill.price * Number(fill.size);
        askVolume += fill.size;
      }
    }

    // P&L is the difference between what we sold and what we bought
    return askValue - bidValue;
  }
}
