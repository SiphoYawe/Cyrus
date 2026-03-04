// HyperliquidOrderManager — wraps Hyperliquid connector for order placement
// Handles bigint-to-decimal conversion, rejection mapping, and partial fills

import { createLogger } from '../utils/logger.js';
import { formatUnits, parseUnits } from '../utils/bigint.js';
import { PerpOrderRejectedError } from '../utils/errors.js';
import type { HyperliquidConnectorInterface } from './hyperliquid-connector.js';
import type { HyperliquidOrderResult } from './hyperliquid-types.js';

const logger = createLogger('hyperliquid-order-manager');

// --- Interfaces ---

export type OrderSide = 'buy' | 'sell';
export type OrderType = 'market' | 'limit';
export type TimeInForce = 'GTC' | 'IOC' | 'FOK';
export type OrderStatus = 'pending' | 'partial' | 'filled' | 'cancelled' | 'rejected';

export interface PerpOrderParams {
  readonly symbol: string;
  readonly side: OrderSide;
  readonly size: bigint;
  readonly leverage: number;
  readonly type: OrderType;
  readonly price?: bigint;
  readonly timeInForce?: TimeInForce;
  readonly decimals: number;
}

export interface PerpOrderResult {
  readonly orderId: string;
  status: OrderStatus;
  fillPrice: string;
  fillSize: string;
  averageFillPrice: string;
  remainingSize: string;
  fees: string;
  readonly timestamp: number;
}

export interface PerpOrderCancelResult {
  readonly orderId: string;
  readonly status: 'cancelled' | 'filled';
  readonly filledSize: string;
  readonly cancelledSize: string;
}

export interface PerpOrderStatus {
  readonly orderId: string;
  readonly status: OrderStatus;
  readonly fillPercentage: number;
  readonly averageFillPrice: string;
  readonly remainingSize: string;
}

// --- Rejection reason mapping ---

const REJECTION_REASON_MAP: Record<string, string> = {
  'insufficient margin': 'INSUFFICIENT_MARGIN',
  'not enough margin': 'INSUFFICIENT_MARGIN',
  'invalid symbol': 'INVALID_SYMBOL',
  'unknown asset': 'INVALID_SYMBOL',
  'size too small': 'SIZE_TOO_SMALL',
  'below minimum': 'SIZE_TOO_SMALL',
  'leverage exceeded': 'LEVERAGE_EXCEEDED',
  'max leverage': 'LEVERAGE_EXCEEDED',
  'self trade': 'SELF_TRADE',
  'rate limit': 'RATE_LIMITED',
  'too many requests': 'RATE_LIMITED',
} as const;

function mapRejectionReason(error: string): string {
  const lower = error.toLowerCase();
  for (const [pattern, reason] of Object.entries(REJECTION_REASON_MAP)) {
    if (lower.includes(pattern)) return reason;
  }
  return 'UNKNOWN';
}

function sideToConnector(side: OrderSide): 'long' | 'short' {
  return side === 'buy' ? 'long' : 'short';
}

// --- HyperliquidOrderManager ---

export class HyperliquidOrderManager {
  private readonly connector: HyperliquidConnectorInterface;
  private readonly activeOrders = new Map<string, PerpOrderResult>();

  constructor(connector: HyperliquidConnectorInterface) {
    this.connector = connector;
  }

  async placeOrder(params: PerpOrderParams): Promise<PerpOrderResult> {
    const startTime = Date.now();
    const sizeStr = formatUnits(params.size, params.decimals);
    const connectorSide = sideToConnector(params.side);

    logger.debug(
      { symbol: params.symbol, side: params.side, size: sizeStr, leverage: params.leverage, type: params.type },
      'Placing order',
    );

    let apiResult: HyperliquidOrderResult;

    if (params.type === 'market') {
      apiResult = await this.placeMarketOrder(params.symbol, connectorSide, sizeStr, params.leverage);
    } else {
      if (params.price === undefined) {
        throw new PerpOrderRejectedError({
          symbol: params.symbol,
          side: params.side,
          size: sizeStr,
          leverage: params.leverage,
          rejectionReason: 'MISSING_PRICE',
        });
      }
      const priceStr = formatUnits(params.price, params.decimals);
      const tif = params.timeInForce ?? 'GTC';
      apiResult = await this.placeLimitOrder(params.symbol, connectorSide, sizeStr, priceStr, params.leverage, tif);
    }

    const result = this.parseOrderResult(apiResult, params, sizeStr);

    // Market orders should fill immediately
    if (params.type === 'market' && result.status !== 'filled') {
      logger.warn(
        { orderId: result.orderId, status: result.status, symbol: params.symbol },
        'Market order did not fill immediately',
      );
    }

    this.activeOrders.set(result.orderId, result);

    logger.debug(
      { orderId: result.orderId, elapsed: Date.now() - startTime, status: result.status },
      'Order placed',
    );

    return result;
  }

  async cancelOrder(symbol: string, orderId: string): Promise<PerpOrderCancelResult> {
    const numericId = parseInt(orderId, 10);
    const existing = this.activeOrders.get(orderId);

    try {
      const success = await this.connector.cancelOrder(symbol, numericId);

      if (!success) {
        // Order may already be filled
        if (existing && existing.status === 'filled') {
          return {
            orderId,
            status: 'filled',
            filledSize: existing.fillSize,
            cancelledSize: '0',
          };
        }
      }

      const filledSize = existing?.fillSize ?? '0';
      const remainingSize = existing?.remainingSize ?? '0';

      if (existing) {
        existing.status = 'cancelled';
        existing.remainingSize = '0';
      }

      return {
        orderId,
        status: 'cancelled',
        filledSize,
        cancelledSize: remainingSize,
      };
    } catch (error) {
      // If cancel fails because order is already filled, return fill status
      if (existing && existing.status === 'filled') {
        return {
          orderId,
          status: 'filled',
          filledSize: existing.fillSize,
          cancelledSize: '0',
        };
      }
      throw error;
    }
  }

  async getOrderStatus(orderId: string): Promise<PerpOrderStatus> {
    const tracked = this.activeOrders.get(orderId);

    if (tracked) {
      const totalSize = parseFloat(tracked.fillSize) + parseFloat(tracked.remainingSize);
      const fillPercentage = totalSize > 0 ? parseFloat(tracked.fillSize) / totalSize : 0;

      return {
        orderId,
        status: tracked.status,
        fillPercentage,
        averageFillPrice: tracked.averageFillPrice,
        remainingSize: tracked.remainingSize,
      };
    }

    // Not tracked locally — return unknown
    return {
      orderId,
      status: 'pending',
      fillPercentage: 0,
      averageFillPrice: '0',
      remainingSize: '0',
    };
  }

  updatePartialFill(orderId: string, fillPrice: string, fillSize: string): void {
    const existing = this.activeOrders.get(orderId);
    if (!existing) return;

    const prevFilledSize = parseFloat(existing.fillSize);
    const prevAvgPrice = parseFloat(existing.averageFillPrice);
    const newFillSize = parseFloat(fillSize);
    const newFillPrice = parseFloat(fillPrice);

    const totalFilledSize = prevFilledSize + newFillSize;

    // Volume-weighted average price
    const newAvgPrice = totalFilledSize > 0
      ? (prevAvgPrice * prevFilledSize + newFillPrice * newFillSize) / totalFilledSize
      : 0;

    const totalOriginalSize = prevFilledSize + parseFloat(existing.remainingSize);
    const newRemainingSize = totalOriginalSize - totalFilledSize;

    existing.fillSize = totalFilledSize.toString();
    existing.averageFillPrice = newAvgPrice.toString();
    existing.remainingSize = Math.max(0, newRemainingSize).toString();
    existing.status = newRemainingSize <= 0 ? 'filled' : 'partial';
  }

  // --- Private helpers ---

  private async placeMarketOrder(
    symbol: string,
    side: 'long' | 'short',
    size: string,
    leverage: number,
  ): Promise<HyperliquidOrderResult> {
    try {
      return await this.connector.placeMarketOrder(symbol, side, size, leverage);
    } catch (error) {
      this.handleOrderError(error, symbol, side === 'long' ? 'buy' : 'sell', size, leverage);
      throw error; // unreachable — handleOrderError always throws
    }
  }

  private async placeLimitOrder(
    symbol: string,
    side: 'long' | 'short',
    size: string,
    price: string,
    leverage: number,
    tif: TimeInForce,
  ): Promise<HyperliquidOrderResult> {
    try {
      return await this.connector.placeLimitOrder(symbol, side, size, price, leverage, tif);
    } catch (error) {
      this.handleOrderError(error, symbol, side === 'long' ? 'buy' : 'sell', size, leverage);
      throw error;
    }
  }

  private parseOrderResult(
    apiResult: HyperliquidOrderResult,
    params: PerpOrderParams,
    sizeStr: string,
  ): PerpOrderResult {
    if (apiResult.status === 'error') {
      const reason = mapRejectionReason(apiResult.error ?? 'unknown');
      logger.error(
        { symbol: params.symbol, side: params.side, error: apiResult.error, reason },
        'Order rejected',
      );
      throw new PerpOrderRejectedError({
        symbol: params.symbol,
        side: params.side,
        size: sizeStr,
        leverage: params.leverage,
        rejectionReason: reason,
        originalResponse: apiResult,
      });
    }

    const orderId = String(apiResult.orderId ?? Date.now());
    const filledSize = apiResult.filledSize ?? '0';
    const avgPrice = apiResult.avgPrice ?? '0';
    const hasFilledSize = parseFloat(filledSize) > 0;

    let status: OrderStatus;
    if (params.type === 'market') {
      status = hasFilledSize ? 'filled' : 'rejected';
    } else {
      const requestedSize = parseFloat(sizeStr);
      const filled = parseFloat(filledSize);
      if (filled >= requestedSize) {
        status = 'filled';
      } else if (filled > 0) {
        status = 'partial';
      } else {
        // For IOC/FOK with no fill, mark as cancelled
        if (params.timeInForce === 'IOC' || params.timeInForce === 'FOK') {
          status = 'cancelled';
        } else {
          status = 'pending';
        }
      }
    }

    const remainingSize = Math.max(0, parseFloat(sizeStr) - parseFloat(filledSize)).toString();

    return {
      orderId,
      status,
      fillPrice: avgPrice,
      fillSize: filledSize,
      averageFillPrice: avgPrice,
      remainingSize,
      fees: '0',
      timestamp: Date.now(),
    };
  }

  private handleOrderError(
    error: unknown,
    symbol: string,
    side: OrderSide,
    size: string,
    leverage: number,
  ): never {
    const message = error instanceof Error ? error.message : String(error);
    const reason = mapRejectionReason(message);

    logger.error(
      { symbol, side, size, leverage, error: message, reason },
      'Order rejected by Hyperliquid',
    );

    throw new PerpOrderRejectedError({
      symbol,
      side,
      size,
      leverage,
      rejectionReason: reason,
      originalResponse: error,
    });
  }
}
