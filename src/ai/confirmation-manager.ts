import { randomUUID } from 'node:crypto';
import { createLogger } from '../utils/logger.js';
import { Store } from '../core/store.js';
import type { Preview, ConfirmationDecision } from './types.js';

const logger = createLogger('confirmation-manager');

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_THRESHOLD_USD = 1000;

export interface ConfirmationManagerOptions {
  readonly timeoutMs?: number;
  readonly thresholdUsd?: number;
}

export class ConfirmationManager {
  private readonly store: Store;
  private readonly timeoutMs: number;
  private readonly thresholdUsd: number;
  private readonly pending = new Map<string, {
    preview: Preview;
    resolve: (decision: ConfirmationDecision) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(options: ConfirmationManagerOptions = {}) {
    this.store = Store.getInstance();
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.thresholdUsd = options.thresholdUsd ?? DEFAULT_THRESHOLD_USD;
  }

  requiresConfirmation(amountUsd: number, isUserInitiated: boolean): boolean {
    // User-initiated commands always require confirmation
    if (isUserInitiated) return true;
    // Autonomous operations above threshold require confirmation
    return amountUsd >= this.thresholdUsd;
  }

  async requestConfirmation(preview: Preview): Promise<ConfirmationDecision> {
    const confirmationId = randomUUID();

    // Send to dashboard via WebSocket
    this.store.emitter.emit('confirmation_request' as any, {
      confirmationId,
      preview,
    });

    logger.info(
      { confirmationId, planId: preview.planId, totalCostUsd: preview.totalCost.totalUsd },
      'Confirmation requested',
    );

    return new Promise<ConfirmationDecision>((resolve) => {
      const timer = setTimeout(() => {
        logger.info(
          { confirmationId, planId: preview.planId, timeoutMs: this.timeoutMs },
          'Confirmation timed out, auto-rejecting',
        );
        this.pending.delete(confirmationId);
        resolve('timeout');
      }, this.timeoutMs);

      this.pending.set(confirmationId, { preview, resolve, timer });
    });
  }

  handleResponse(confirmationId: string, decision: 'approved' | 'rejected'): void {
    const entry = this.pending.get(confirmationId);
    if (!entry) {
      logger.warn({ confirmationId }, 'Confirmation response for unknown or expired request');
      return;
    }

    clearTimeout(entry.timer);
    this.pending.delete(confirmationId);
    entry.resolve(decision);

    logger.info(
      { confirmationId, decision, planId: entry.preview.planId },
      'Confirmation response received',
    );
  }

  getThresholdUsd(): number {
    return this.thresholdUsd;
  }

  cleanup(): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      this.pending.delete(id);
    }
  }
}
