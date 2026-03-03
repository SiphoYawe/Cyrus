import { describe, it, expect } from 'vitest';
import { PreFlightChecker } from './pre-flight-checks.js';
import type { PreFlightConfig } from './pre-flight-checks.js';
import type { QuoteResult } from '../connectors/types.js';

function createMockQuote(overrides: {
  gasCostUsd?: string;
  toAmount?: string;
  toAmountMin?: string;
  executionDuration?: number;
} = {}): QuoteResult {
  const {
    gasCostUsd = '2.50',
    toAmount = '1000000',
    toAmountMin = '995000',
    executionDuration = 60,
  } = overrides;

  return {
    transactionRequest: {
      to: '0xdeadbeef00000000000000000000000000000001',
      data: '0x1234',
      value: '0',
      gasLimit: '200000',
      chainId: 1,
    },
    estimate: {
      approvalAddress: '0xspender0000000000000000000000000000000001',
      toAmount,
      toAmountMin,
      executionDuration,
      gasCosts: [{ amount: '1000000000000000', amountUSD: gasCostUsd, token: { symbol: 'ETH' } }],
    },
    tool: 'stargate',
    toolDetails: { key: 'stargate', name: 'Stargate', logoURI: '' },
    action: { fromChainId: 1, toChainId: 42161, fromToken: {}, toToken: {} },
  };
}

describe('PreFlightChecker', () => {
  const checker = new PreFlightChecker();

  // --- Gas ceiling ---

  describe('checkGasCeiling', () => {
    it('returns true when gas cost is within ceiling', () => {
      expect(checker.checkGasCeiling(5.0, 50.0)).toBe(true);
    });

    it('returns true when gas cost equals ceiling exactly', () => {
      expect(checker.checkGasCeiling(50.0, 50.0)).toBe(true);
    });

    it('returns false when gas cost exceeds ceiling', () => {
      expect(checker.checkGasCeiling(51.0, 50.0)).toBe(false);
    });

    it('returns true for zero gas cost', () => {
      expect(checker.checkGasCeiling(0, 50.0)).toBe(true);
    });
  });

  // --- Slippage threshold ---

  describe('checkSlippage', () => {
    it('returns true when slippage is within threshold', () => {
      expect(checker.checkSlippage(0.003, 0.005)).toBe(true);
    });

    it('returns true when slippage equals threshold exactly', () => {
      expect(checker.checkSlippage(0.005, 0.005)).toBe(true);
    });

    it('returns false when slippage exceeds threshold', () => {
      expect(checker.checkSlippage(0.01, 0.005)).toBe(false);
    });

    it('returns true for zero slippage', () => {
      expect(checker.checkSlippage(0, 0.005)).toBe(true);
    });
  });

  // --- Bridge timeout ---

  describe('checkBridgeTimeout', () => {
    it('returns true when duration is within timeout', () => {
      expect(checker.checkBridgeTimeout(60, 300)).toBe(true);
    });

    it('returns true when duration equals timeout exactly', () => {
      expect(checker.checkBridgeTimeout(300, 300)).toBe(true);
    });

    it('returns false when duration exceeds timeout', () => {
      expect(checker.checkBridgeTimeout(600, 300)).toBe(false);
    });
  });

  // --- runAllChecks ---

  describe('runAllChecks', () => {
    it('passes all checks when quote is within thresholds', () => {
      const quote = createMockQuote({
        gasCostUsd: '2.50',
        toAmount: '1000000',
        toAmountMin: '995000', // 0.5% slippage
        executionDuration: 60,
      });

      const config: PreFlightConfig = {
        maxGasCostUsd: 50,
        defaultSlippage: 0.005,
        maxBridgeTimeout: 300,
      };

      const result = checker.runAllChecks(quote, config);

      expect(result.passed).toBe(true);
      expect(result.failures).toHaveLength(0);
    });

    it('fails when gas cost exceeds ceiling', () => {
      const quote = createMockQuote({ gasCostUsd: '75.00' });

      const config: PreFlightConfig = {
        maxGasCostUsd: 50,
        defaultSlippage: 0.01,
      };

      const result = checker.runAllChecks(quote, config);

      expect(result.passed).toBe(false);
      expect(result.failures.length).toBeGreaterThanOrEqual(1);
      expect(result.failures.some((f) => f.includes('Gas cost'))).toBe(true);
    });

    it('fails when slippage exceeds threshold', () => {
      const quote = createMockQuote({
        toAmount: '1000000',
        toAmountMin: '900000', // 10% slippage
      });

      const config: PreFlightConfig = {
        maxGasCostUsd: 100,
        defaultSlippage: 0.005,
      };

      const result = checker.runAllChecks(quote, config);

      expect(result.passed).toBe(false);
      expect(result.failures.some((f) => f.includes('slippage'))).toBe(true);
    });

    it('fails when bridge duration exceeds timeout', () => {
      const quote = createMockQuote({ executionDuration: 600 });

      const config: PreFlightConfig = {
        maxGasCostUsd: 100,
        defaultSlippage: 0.01,
        maxBridgeTimeout: 300,
      };

      const result = checker.runAllChecks(quote, config);

      expect(result.passed).toBe(false);
      expect(result.failures.some((f) => f.includes('duration'))).toBe(true);
    });

    it('skips bridge timeout check when maxBridgeTimeout is not set', () => {
      const quote = createMockQuote({ executionDuration: 99999 });

      const config: PreFlightConfig = {
        maxGasCostUsd: 100,
        defaultSlippage: 0.01,
        // maxBridgeTimeout not set
      };

      const result = checker.runAllChecks(quote, config);

      // Should not fail on timeout
      expect(result.failures.every((f) => !f.includes('duration'))).toBe(true);
    });

    it('collects multiple failures', () => {
      const quote = createMockQuote({
        gasCostUsd: '75.00',
        toAmount: '1000000',
        toAmountMin: '900000', // 10% slippage
        executionDuration: 600,
      });

      const config: PreFlightConfig = {
        maxGasCostUsd: 50,
        defaultSlippage: 0.005,
        maxBridgeTimeout: 300,
      };

      const result = checker.runAllChecks(quote, config);

      expect(result.passed).toBe(false);
      expect(result.failures.length).toBe(3);
    });
  });
});
