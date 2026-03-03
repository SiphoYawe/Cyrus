import { createLogger } from '../utils/logger.js';
import type { Position } from '../core/types.js';
import type {
  BarrierConfig,
  BarrierResult,
} from './types.js';

const logger = createLogger('triple-barrier');

// Bounds for volatility adjustment clamping
const MAX_STOPLOSS = -0.20;
const MIN_TAKEPROFIT = 0.005;

/**
 * Custom stoploss hook signature — strategies implement this
 * to dynamically adjust stoploss per position.
 */
export type CustomStoplossHook = (position: Position, currentProfit: number) => number | null;

/**
 * Position with tracking state needed by the barrier engine.
 */
export interface BarrierPosition extends Position {
  highWaterMark?: number;
  lastEvaluatedAt?: number;
}

/**
 * Triple Barrier Risk Engine.
 *
 * Every position is protected by three barriers:
 * 1. Stop-loss — caps downside losses
 * 2. Take-profit — locks in upside gains
 * 3. Time-limit — closes stale positions
 *
 * Extended with trailing stop and cross-chain barriers.
 * Exit evaluation priority follows Freqtrade pattern:
 *   1) Custom stoploss hook → 2) Stop-loss → 3) ROI targets (take-profit) → 4) Trailing stop → 5) Time-limit
 */
export class TripleBarrierEngine {
  /**
   * Evaluate all barriers for a position in priority order.
   *
   * @param position - The position to evaluate
   * @param currentPrice - Current market price
   * @param config - Barrier configuration from the strategy
   * @param customStoploss - Optional custom stoploss hook from the strategy
   * @returns BarrierResult — either 'hold' or 'close' with reason
   */
  evaluate(
    position: BarrierPosition,
    currentPrice: number,
    config: BarrierConfig,
    customStoploss?: CustomStoplossHook,
  ): BarrierResult {
    try {
      // Safety: validate price data
      if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
        logger.warn(
          { positionId: position.id, currentPrice },
          'Stale or invalid price data — holding position, will retry next tick',
        );
        return { type: 'hold' };
      }

      if (!Number.isFinite(position.entryPrice) || position.entryPrice <= 0) {
        logger.warn(
          { positionId: position.id, entryPrice: position.entryPrice },
          'Invalid entry price — holding position',
        );
        return { type: 'hold' };
      }

      const currentProfit = (currentPrice - position.entryPrice) / position.entryPrice;

      // Update high water mark for trailing stop
      if (position.highWaterMark === undefined || currentPrice > position.highWaterMark) {
        position.highWaterMark = currentPrice;
      }

      // Priority 1: Custom stoploss hook
      if (customStoploss) {
        const customSL = customStoploss(position, currentProfit);
        if (customSL !== null) {
          if (currentProfit <= customSL) {
            logger.debug(
              { positionId: position.id, currentProfit, customStoploss: customSL },
              'Custom stoploss override triggered',
            );
            return {
              type: 'close',
              reason: 'custom-stoploss',
              details: `Custom stoploss triggered: profit ${(currentProfit * 100).toFixed(2)}% <= threshold ${(customSL * 100).toFixed(2)}%`,
            };
          }
        }
        // null means fall through to declarative stoploss
      }

      // Priority 2: Stop-loss
      if (currentProfit <= config.stopLoss) {
        return {
          type: 'close',
          reason: 'stop-loss',
          details: `Stop-loss triggered: profit ${(currentProfit * 100).toFixed(2)}% <= threshold ${(config.stopLoss * 100).toFixed(2)}%`,
        };
      }

      // Priority 3: Take-profit (ROI targets)
      if (currentProfit >= config.takeProfit) {
        return {
          type: 'close',
          reason: 'take-profit',
          details: `Take-profit triggered: profit ${(currentProfit * 100).toFixed(2)}% >= threshold ${(config.takeProfit * 100).toFixed(2)}%`,
        };
      }

      // Priority 4: Trailing stop
      if (config.trailingStop?.enabled) {
        const trailingResult = this.evaluateTrailingStop(
          position,
          currentPrice,
          config.trailingStop.activationPrice,
          config.trailingStop.trailingDelta,
        );
        if (trailingResult.type === 'close') {
          return trailingResult;
        }
      }

      // Priority 5: Time-limit
      const elapsed = Date.now() - position.enteredAt;
      if (elapsed >= config.timeLimit * 1000) {
        return {
          type: 'close',
          reason: 'time-limit',
          details: `Time-limit triggered: open for ${Math.round(elapsed / 1000)}s >= limit ${config.timeLimit}s`,
        };
      }

      // Update tracking timestamp
      position.lastEvaluatedAt = Date.now();

      return { type: 'hold' };
    } catch (error) {
      // Safety: stale data never triggers a false barrier breach
      logger.warn(
        { positionId: position.id, error: (error as Error).message },
        'Error evaluating barriers — holding position, will retry next tick',
      );
      return { type: 'hold' };
    }
  }

  /**
   * Evaluate trailing stop for a position.
   */
  private evaluateTrailingStop(
    position: BarrierPosition,
    currentPrice: number,
    activationPrice: number,
    trailingDelta: number,
  ): BarrierResult {
    const highWaterMark = position.highWaterMark ?? currentPrice;

    // Check if position price has reached activation price
    if (highWaterMark < activationPrice) {
      return { type: 'hold' };
    }

    // Compute trailing stop level: highWaterMark - (highWaterMark * trailingDelta)
    const trailingStopLevel = highWaterMark * (1 - trailingDelta);

    // If current price drops below trailing stop level, trigger close
    if (currentPrice <= trailingStopLevel) {
      return {
        type: 'close',
        reason: 'trailing-stop',
        details: `Trailing stop triggered: price ${currentPrice.toFixed(4)} <= trailing level ${trailingStopLevel.toFixed(4)} (HWM: ${highWaterMark.toFixed(4)}, delta: ${(trailingDelta * 100).toFixed(2)}%)`,
      };
    }

    return { type: 'hold' };
  }

  /**
   * Adjust barrier config for market volatility.
   *
   * Scales stop-loss and take-profit by the volatility factor.
   * Higher volatility → wider barriers to avoid premature exits.
   * Clamped to reasonable bounds.
   *
   * @param baseConfig - Original barrier configuration
   * @param volatilityFactor - Multiplier (e.g. 1.5 = 50% wider barriers)
   * @returns Adjusted barrier configuration
   */
  adjustForVolatility(baseConfig: BarrierConfig, volatilityFactor: number): BarrierConfig {
    const adjustedSL = Math.max(baseConfig.stopLoss * volatilityFactor, MAX_STOPLOSS);
    const adjustedTP = Math.max(baseConfig.takeProfit * volatilityFactor, MIN_TAKEPROFIT);

    return {
      ...baseConfig,
      stopLoss: adjustedSL,
      takeProfit: adjustedTP,
    };
  }
}
