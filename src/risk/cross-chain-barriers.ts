import { createLogger } from '../utils/logger.js';
import type { BarrierResult, CrossChainBarrierConfig, TransferPlan } from './types.js';

const logger = createLogger('cross-chain-barriers');

/**
 * Evaluate cross-chain barriers before executing a transfer.
 *
 * Checks gas ceiling, slippage threshold, and bridge timeout.
 * Any breach aborts execution.
 *
 * @param transferPlan - Estimated transfer costs from the quote
 * @param config - Cross-chain barrier configuration
 * @returns BarrierResult — 'hold' if all pass, 'close' with reason if any breach
 */
export function evaluateCrossChainBarriers(
  transferPlan: TransferPlan,
  config: CrossChainBarrierConfig,
): BarrierResult {
  // Gas ceiling check
  if (transferPlan.estimatedGasCostUsd > config.gasCeiling) {
    logger.warn(
      {
        estimatedGas: transferPlan.estimatedGasCostUsd,
        gasCeiling: config.gasCeiling,
      },
      'Gas ceiling barrier breached — aborting transfer',
    );
    return {
      type: 'close',
      reason: 'gas-ceiling',
      details: `Gas ceiling breached: estimated $${transferPlan.estimatedGasCostUsd.toFixed(2)} > ceiling $${config.gasCeiling.toFixed(2)}`,
    };
  }

  // Slippage threshold check
  if (transferPlan.estimatedSlippage > config.slippageThreshold) {
    logger.warn(
      {
        estimatedSlippage: transferPlan.estimatedSlippage,
        slippageThreshold: config.slippageThreshold,
      },
      'Slippage threshold barrier breached — aborting transfer',
    );
    return {
      type: 'close',
      reason: 'slippage-threshold',
      details: `Slippage threshold breached: estimated ${(transferPlan.estimatedSlippage * 100).toFixed(2)}% > threshold ${(config.slippageThreshold * 100).toFixed(2)}%`,
    };
  }

  // Bridge timeout check
  if (transferPlan.estimatedBridgeTimeSeconds > config.bridgeTimeout) {
    logger.warn(
      {
        estimatedBridgeTime: transferPlan.estimatedBridgeTimeSeconds,
        bridgeTimeout: config.bridgeTimeout,
      },
      'Bridge timeout barrier breached — aborting transfer',
    );
    return {
      type: 'close',
      reason: 'bridge-timeout',
      details: `Bridge timeout breached: estimated ${transferPlan.estimatedBridgeTimeSeconds}s > timeout ${config.bridgeTimeout}s`,
    };
  }

  return { type: 'hold' };
}
