// Pre-flight checks before executing a swap/bridge transaction
// Validates gas costs, slippage, and bridge timeout against configured thresholds

import type { QuoteResult } from '../connectors/types.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('pre-flight-checks');

export interface PreFlightConfig {
  readonly maxGasCostUsd: number;
  readonly defaultSlippage: number;
  readonly maxBridgeTimeout?: number; // seconds
}

export interface PreFlightResult {
  readonly passed: boolean;
  readonly failures: string[];
}

export class PreFlightChecker {
  /**
   * Check if estimated gas cost is within the ceiling.
   */
  checkGasCeiling(estimatedGasUsd: number, maxGasCostUsd: number): boolean {
    const passed = estimatedGasUsd <= maxGasCostUsd;
    if (!passed) {
      logger.warn(
        { estimatedGasUsd, maxGasCostUsd },
        'Gas cost exceeds ceiling',
      );
    }
    return passed;
  }

  /**
   * Check if quote slippage is within the threshold.
   * Slippage is compared as a fraction (e.g. 0.005 = 0.5%).
   */
  checkSlippage(quoteSlippage: number, maxSlippage: number): boolean {
    const passed = quoteSlippage <= maxSlippage;
    if (!passed) {
      logger.warn(
        { quoteSlippage, maxSlippage },
        'Slippage exceeds threshold',
      );
    }
    return passed;
  }

  /**
   * Check if estimated bridge duration is within the timeout.
   * Both values are in seconds.
   */
  checkBridgeTimeout(estimatedDuration: number, maxDuration: number): boolean {
    const passed = estimatedDuration <= maxDuration;
    if (!passed) {
      logger.warn(
        { estimatedDuration, maxDuration },
        'Bridge duration exceeds timeout',
      );
    }
    return passed;
  }

  /**
   * Run all pre-flight checks against a quote and config.
   */
  runAllChecks(
    quote: QuoteResult,
    config: PreFlightConfig,
  ): PreFlightResult {
    const failures: string[] = [];

    // 1. Gas ceiling check
    const totalGasUsd = quote.estimate.gasCosts.reduce(
      (sum, gc) => sum + parseFloat(gc.amountUSD || '0'),
      0,
    );

    if (!this.checkGasCeiling(totalGasUsd, config.maxGasCostUsd)) {
      failures.push(
        `Gas cost $${totalGasUsd.toFixed(2)} exceeds ceiling $${config.maxGasCostUsd}`,
      );
    }

    // 2. Slippage check — compute effective slippage from toAmount vs toAmountMin
    const toAmount = parseFloat(quote.estimate.toAmount || '0');
    const toAmountMin = parseFloat(quote.estimate.toAmountMin || '0');

    if (toAmount > 0) {
      const effectiveSlippage = (toAmount - toAmountMin) / toAmount;
      if (!this.checkSlippage(effectiveSlippage, config.defaultSlippage)) {
        failures.push(
          `Effective slippage ${(effectiveSlippage * 100).toFixed(2)}% exceeds max ${(config.defaultSlippage * 100).toFixed(2)}%`,
        );
      }
    }

    // 3. Bridge timeout check (if configured)
    if (config.maxBridgeTimeout !== undefined) {
      const estimatedDuration = quote.estimate.executionDuration;
      if (!this.checkBridgeTimeout(estimatedDuration, config.maxBridgeTimeout)) {
        failures.push(
          `Estimated duration ${estimatedDuration}s exceeds max ${config.maxBridgeTimeout}s`,
        );
      }
    }

    const passed = failures.length === 0;

    if (passed) {
      logger.info(
        { tool: quote.tool, totalGasUsd, toAmount, toAmountMin },
        'All pre-flight checks passed',
      );
    } else {
      logger.warn(
        { tool: quote.tool, failures },
        'Pre-flight checks failed',
      );
    }

    return { passed, failures };
  }
}
