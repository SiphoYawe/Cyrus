import { randomUUID } from 'node:crypto';
import { createLogger } from '../utils/logger.js';
import { Store } from '../core/store.js';
import type {
  ErrorClassification,
  ErrorContext,
  RecoveryOption,
} from './types.js';

const logger = createLogger('error-recovery');

const DEFAULT_RECOVERY_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export interface ErrorRecoveryManagerOptions {
  readonly recoveryTimeoutMs?: number;
}

export class ErrorRecoveryManager {
  private readonly store: Store;
  private readonly recoveryTimeoutMs: number;
  private readonly pendingRecoveries = new Map<string, {
    options: RecoveryOption[];
    resolve: (optionId: string) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(options: ErrorRecoveryManagerOptions = {}) {
    this.store = Store.getInstance();
    this.recoveryTimeoutMs = options.recoveryTimeoutMs ?? DEFAULT_RECOVERY_TIMEOUT_MS;
  }

  classifyError(error: Error, context: Partial<ErrorContext> = {}): ErrorClassification {
    const message = error.message.toLowerCase();

    if (message.includes('slippage') || message.includes('price impact') || message.includes('insufficient output')) {
      return 'slippage';
    }
    if (context.bridgeSucceeded && (message.includes('revert') || message.includes('deposit'))) {
      return 'deposit-failure';
    }
    if (message.includes('execution reverted') || message.includes('deadline exceeded') || message.includes('quote expired')) {
      return 'quote-expired';
    }
    if (message.includes('insufficient') && (message.includes('fund') || message.includes('balance'))) {
      return 'insufficient-balance';
    }
    if (message.includes('timeout') || message.includes('bridge timeout')) {
      return 'bridge-timeout';
    }
    return 'unknown';
  }

  generateOptions(errorContext: ErrorContext): RecoveryOption[] {
    switch (errorContext.errorType) {
      case 'slippage':
        return [
          {
            id: randomUUID(),
            label: 'Hold funds',
            description: 'Keep funds at current location. Safest option — no additional costs.',
            estimatedCostUsd: 0,
            riskLevel: 'low',
            isDefault: true,
          },
          {
            id: randomUUID(),
            label: 'Retry with higher slippage',
            description: 'Retry the transaction with slippage increased by 0.5%. May succeed but at a worse rate.',
            estimatedCostUsd: 0,
            riskLevel: 'medium',
            isDefault: false,
          },
          {
            id: randomUUID(),
            label: 'Bridge back to origin',
            description: `Bridge funds back to chain ${errorContext.fromChain}. Incurs bridge fees.`,
            estimatedCostUsd: 0,
            riskLevel: 'medium',
            isDefault: false,
          },
        ];

      case 'deposit-failure':
        return [
          {
            id: randomUUID(),
            label: 'Hold on target chain',
            description: `Keep funds on chain ${errorContext.toChain}. Safest option after bridge succeeded.`,
            estimatedCostUsd: 0,
            riskLevel: 'low',
            isDefault: true,
          },
          {
            id: randomUUID(),
            label: 'Retry deposit only',
            description: 'Retry the deposit without re-bridging. Bridge already succeeded.',
            estimatedCostUsd: 0,
            riskLevel: 'medium',
            isDefault: false,
          },
          {
            id: randomUUID(),
            label: 'Bridge back to origin',
            description: `Bridge funds back to chain ${errorContext.fromChain}.`,
            estimatedCostUsd: 0,
            riskLevel: 'high',
            isDefault: false,
          },
        ];

      case 'bridge-timeout':
        return [
          {
            id: randomUUID(),
            label: 'Hold and wait',
            description: 'Continue waiting for the bridge transfer to complete. Some bridges take 15+ minutes.',
            estimatedCostUsd: 0,
            riskLevel: 'low',
            isDefault: true,
          },
          {
            id: randomUUID(),
            label: 'Bridge back',
            description: `Attempt to bridge funds back to chain ${errorContext.fromChain}.`,
            estimatedCostUsd: 0,
            riskLevel: 'high',
            isDefault: false,
          },
        ];

      case 'insufficient-balance':
        return [
          {
            id: randomUUID(),
            label: 'Cancel operation',
            description: 'Cancel the operation. No funds are at risk.',
            estimatedCostUsd: 0,
            riskLevel: 'low',
            isDefault: true,
          },
          {
            id: randomUUID(),
            label: 'Retry with reduced amount',
            description: 'Retry with a smaller amount that fits available balance.',
            estimatedCostUsd: 0,
            riskLevel: 'medium',
            isDefault: false,
          },
        ];

      case 'quote-expired':
      case 'unknown':
      default:
        return [
          {
            id: randomUUID(),
            label: 'Hold funds',
            description: 'Keep funds at current location. No action taken.',
            estimatedCostUsd: 0,
            riskLevel: 'low',
            isDefault: true,
          },
        ];
    }
  }

  shouldAutoRetry(errorContext: ErrorContext): boolean {
    return errorContext.errorType === 'quote-expired';
  }

  getDefaultOption(options: RecoveryOption[]): RecoveryOption {
    return options.find(o => o.isDefault) ?? options[0];
  }

  async requestRecoverySelection(
    errorContext: ErrorContext,
    options: RecoveryOption[],
  ): Promise<string> {
    const recoveryId = randomUUID();

    // Send to dashboard via event emitter
    this.store.emitter.emit('recovery_options' as never, {
      recoveryId,
      errorContext,
      options,
    });

    return new Promise<string>((resolve) => {
      const timer = setTimeout(() => {
        // Auto-select default on timeout
        const defaultOption = this.getDefaultOption(options);
        logger.info(
          { recoveryId, defaultOption: defaultOption.label, timeoutMs: this.recoveryTimeoutMs },
          'Recovery selection timed out, using default option',
        );
        this.pendingRecoveries.delete(recoveryId);
        resolve(defaultOption.id);
      }, this.recoveryTimeoutMs);

      this.pendingRecoveries.set(recoveryId, { options, resolve, timer });
    });
  }

  handleUserSelection(recoveryId: string, optionId: string): void {
    const pending = this.pendingRecoveries.get(recoveryId);
    if (!pending) {
      logger.warn({ recoveryId }, 'Recovery selection for unknown or expired recovery');
      return;
    }

    clearTimeout(pending.timer);
    this.pendingRecoveries.delete(recoveryId);
    pending.resolve(optionId);

    const selected = pending.options.find(o => o.id === optionId);
    logger.info(
      { recoveryId, selectedOption: selected?.label ?? optionId },
      'User selected recovery option',
    );
  }

  cleanup(): void {
    for (const [id, pending] of this.pendingRecoveries) {
      clearTimeout(pending.timer);
      const defaultOption = this.getDefaultOption(pending.options);
      pending.resolve(defaultOption.id);
    }
    this.pendingRecoveries.clear();
  }
}
