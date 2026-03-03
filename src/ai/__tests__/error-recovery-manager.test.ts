import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ErrorRecoveryManager } from '../error-recovery-manager.js';
import { Store } from '../../core/store.js';
import type { ErrorContext, RecoveryOption } from '../types.js';

function createErrorContext(overrides: Partial<ErrorContext> = {}): ErrorContext {
  return {
    errorType: 'unknown',
    originalAction: 'bridge',
    fromChain: 1,
    toChain: 42161,
    token: 'USDC',
    amount: '1000',
    bridgeSucceeded: false,
    errorMessage: 'Something went wrong',
    ...overrides,
  };
}

describe('ErrorRecoveryManager', () => {
  let manager: ErrorRecoveryManager;

  beforeEach(() => {
    Store.getInstance().reset();
    manager = new ErrorRecoveryManager();
  });

  afterEach(() => {
    manager.cleanup();
  });

  describe('classifyError', () => {
    it('identifies slippage errors correctly', () => {
      expect(manager.classifyError(new Error('Transaction failed: slippage too high'))).toBe('slippage');
      expect(manager.classifyError(new Error('Price impact exceeds limit'))).toBe('slippage');
      expect(manager.classifyError(new Error('Insufficient output amount'))).toBe('slippage');
    });

    it('identifies deposit-failure when bridgeSucceeded is true', () => {
      const result = manager.classifyError(
        new Error('Execution reverted during deposit'),
        { bridgeSucceeded: true },
      );
      expect(result).toBe('deposit-failure');
    });

    it('identifies quote-expired errors', () => {
      expect(manager.classifyError(new Error('Execution reverted'))).toBe('quote-expired');
      expect(manager.classifyError(new Error('Deadline exceeded'))).toBe('quote-expired');
      expect(manager.classifyError(new Error('Quote expired'))).toBe('quote-expired');
    });

    it('identifies insufficient-balance errors', () => {
      expect(manager.classifyError(new Error('Insufficient funds for transfer'))).toBe('insufficient-balance');
      expect(manager.classifyError(new Error('Insufficient balance'))).toBe('insufficient-balance');
    });

    it('identifies bridge-timeout errors', () => {
      expect(manager.classifyError(new Error('Bridge timeout waiting for confirmation'))).toBe('bridge-timeout');
      expect(manager.classifyError(new Error('Request timeout'))).toBe('bridge-timeout');
    });

    it('returns unknown for unrecognized errors', () => {
      expect(manager.classifyError(new Error('Something completely unexpected'))).toBe('unknown');
      expect(manager.classifyError(new Error(''))).toBe('unknown');
    });
  });

  describe('generateOptions', () => {
    it('returns 3 options for slippage (hold, retry, bridge-back)', () => {
      const ctx = createErrorContext({ errorType: 'slippage' });
      const options = manager.generateOptions(ctx);

      expect(options).toHaveLength(3);
      expect(options[0].label).toBe('Hold funds');
      expect(options[1].label).toBe('Retry with higher slippage');
      expect(options[2].label).toBe('Bridge back to origin');
    });

    it('returns 3 options for deposit-failure', () => {
      const ctx = createErrorContext({ errorType: 'deposit-failure', bridgeSucceeded: true });
      const options = manager.generateOptions(ctx);

      expect(options).toHaveLength(3);
      expect(options[0].label).toBe('Hold on target chain');
      expect(options[1].label).toBe('Retry deposit only');
      expect(options[2].label).toBe('Bridge back to origin');
    });

    it('returns 2 options for bridge-timeout (hold, bridge-back)', () => {
      const ctx = createErrorContext({ errorType: 'bridge-timeout' });
      const options = manager.generateOptions(ctx);

      expect(options).toHaveLength(2);
      expect(options[0].label).toBe('Hold and wait');
      expect(options[1].label).toBe('Bridge back');
    });

    it('returns 2 options for insufficient-balance (cancel, retry)', () => {
      const ctx = createErrorContext({ errorType: 'insufficient-balance' });
      const options = manager.generateOptions(ctx);

      expect(options).toHaveLength(2);
      expect(options[0].label).toBe('Cancel operation');
      expect(options[1].label).toBe('Retry with reduced amount');
    });

    it('returns 1 option for unknown (hold)', () => {
      const ctx = createErrorContext({ errorType: 'unknown' });
      const options = manager.generateOptions(ctx);

      expect(options).toHaveLength(1);
      expect(options[0].label).toBe('Hold funds');
    });

    it('returns 1 option for quote-expired (hold)', () => {
      const ctx = createErrorContext({ errorType: 'quote-expired' });
      const options = manager.generateOptions(ctx);

      expect(options).toHaveLength(1);
      expect(options[0].label).toBe('Hold funds');
    });

    it('default option is always the safest (isDefault: true, riskLevel: low)', () => {
      const errorTypes = [
        'slippage',
        'deposit-failure',
        'bridge-timeout',
        'insufficient-balance',
        'quote-expired',
        'unknown',
      ] as const;

      for (const errorType of errorTypes) {
        const ctx = createErrorContext({ errorType, bridgeSucceeded: errorType === 'deposit-failure' });
        const options = manager.generateOptions(ctx);
        const defaultOption = options.find(o => o.isDefault);

        expect(defaultOption).toBeDefined();
        expect(defaultOption!.riskLevel).toBe('low');
        expect(defaultOption!.isDefault).toBe(true);
      }
    });

    it('every option has a unique id', () => {
      const ctx = createErrorContext({ errorType: 'slippage' });
      const options = manager.generateOptions(ctx);
      const ids = options.map(o => o.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
    });
  });

  describe('shouldAutoRetry', () => {
    it('returns true only for quote-expired', () => {
      expect(manager.shouldAutoRetry(createErrorContext({ errorType: 'quote-expired' }))).toBe(true);
    });

    it('returns false for all other error types', () => {
      expect(manager.shouldAutoRetry(createErrorContext({ errorType: 'slippage' }))).toBe(false);
      expect(manager.shouldAutoRetry(createErrorContext({ errorType: 'deposit-failure' }))).toBe(false);
      expect(manager.shouldAutoRetry(createErrorContext({ errorType: 'bridge-timeout' }))).toBe(false);
      expect(manager.shouldAutoRetry(createErrorContext({ errorType: 'insufficient-balance' }))).toBe(false);
      expect(manager.shouldAutoRetry(createErrorContext({ errorType: 'unknown' }))).toBe(false);
    });
  });

  describe('getDefaultOption', () => {
    it('returns the option marked as isDefault', () => {
      const options: RecoveryOption[] = [
        { id: '1', label: 'A', description: '', estimatedCostUsd: 0, riskLevel: 'medium', isDefault: false },
        { id: '2', label: 'B', description: '', estimatedCostUsd: 0, riskLevel: 'low', isDefault: true },
      ];
      expect(manager.getDefaultOption(options).id).toBe('2');
    });

    it('falls back to first option if none is marked default', () => {
      const options: RecoveryOption[] = [
        { id: '1', label: 'A', description: '', estimatedCostUsd: 0, riskLevel: 'medium', isDefault: false },
        { id: '2', label: 'B', description: '', estimatedCostUsd: 0, riskLevel: 'low', isDefault: false },
      ];
      expect(manager.getDefaultOption(options).id).toBe('1');
    });
  });

  describe('requestRecoverySelection', () => {
    it('timeout auto-selects default option', async () => {
      const shortTimeoutManager = new ErrorRecoveryManager({ recoveryTimeoutMs: 50 });
      const ctx = createErrorContext({ errorType: 'slippage' });
      const options = shortTimeoutManager.generateOptions(ctx);
      const defaultOption = options.find(o => o.isDefault)!;

      const selectedId = await shortTimeoutManager.requestRecoverySelection(ctx, options);

      expect(selectedId).toBe(defaultOption.id);
      shortTimeoutManager.cleanup();
    });

    it('emits recovery_options event on the store emitter', () => {
      const store = Store.getInstance();
      const listener = vi.fn();
      store.emitter.on('recovery_options', listener);

      const ctx = createErrorContext({ errorType: 'slippage' });
      const options = manager.generateOptions(ctx);

      // Fire and forget -- we just want to verify the event was emitted
      const promise = manager.requestRecoverySelection(ctx, options);

      expect(listener).toHaveBeenCalledTimes(1);
      const emitted = listener.mock.calls[0][0];
      expect(emitted.recoveryId).toBeDefined();
      expect(emitted.errorContext).toBe(ctx);
      expect(emitted.options).toBe(options);

      // Cleanup the pending promise
      manager.cleanup();
      // Await the resolved promise to prevent unhandled rejection
      return promise;
    });
  });

  describe('handleUserSelection', () => {
    it('resolves pending promise with selected option id', async () => {
      const ctx = createErrorContext({ errorType: 'slippage' });
      const options = manager.generateOptions(ctx);

      // Capture the recoveryId from the emitted event
      const store = Store.getInstance();
      let recoveryId = '';
      store.emitter.on('recovery_options', (event: { recoveryId: string }) => {
        recoveryId = event.recoveryId;
      });

      const selectionPromise = manager.requestRecoverySelection(ctx, options);

      // Select the second option
      const selectedOptionId = options[1].id;
      manager.handleUserSelection(recoveryId, selectedOptionId);

      const result = await selectionPromise;
      expect(result).toBe(selectedOptionId);
    });

    it('ignores selection for unknown recovery id', () => {
      // Should not throw
      manager.handleUserSelection('non-existent-id', 'some-option');
    });
  });

  describe('cleanup', () => {
    it('clears all pending recoveries and resolves with default option', async () => {
      const ctx = createErrorContext({ errorType: 'slippage' });
      const options = manager.generateOptions(ctx);
      const defaultOption = options.find(o => o.isDefault)!;

      // Start a recovery but do not resolve it via user selection
      const promise = manager.requestRecoverySelection(ctx, options);

      // Cleanup should resolve the pending promise with the default option
      manager.cleanup();

      const result = await promise;
      expect(result).toBe(defaultOption.id);

      // After cleanup, handleUserSelection should be a no-op (no pending)
      manager.handleUserSelection('any-id', 'any-option');
    });
  });
});
