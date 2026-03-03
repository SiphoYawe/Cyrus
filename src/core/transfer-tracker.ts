// TransferTracker — manages concurrent status polling for in-flight transfers

import { createLogger } from '../utils/logger.js';
import type { StatusPoller } from '../connectors/status-poller.js';
import type { TerminalStatusHandler } from './terminal-handlers.js';
import type { InFlightTransfer, TransferResult, TransferStatus } from './types.js';
import { DEFAULT_MAX_CONCURRENT_TRANSFERS } from './constants.js';

const logger = createLogger('transfer-tracker');

interface TrackedEntry {
  readonly transfer: InFlightTransfer;
  readonly abortController: AbortController;
  readonly promise: Promise<TransferResult>;
}

export class TransferTracker {
  private readonly statusPoller: StatusPoller;
  private readonly terminalHandler: TerminalStatusHandler;
  private readonly maxConcurrent: number;
  private readonly tracked: Map<string, TrackedEntry> = new Map();

  constructor(
    statusPoller: StatusPoller,
    terminalHandler: TerminalStatusHandler,
    maxConcurrent: number = DEFAULT_MAX_CONCURRENT_TRANSFERS,
  ) {
    this.statusPoller = statusPoller;
    this.terminalHandler = terminalHandler;
    this.maxConcurrent = maxConcurrent;
  }

  /**
   * Begins tracking an in-flight transfer. Returns a promise that resolves
   * when the transfer reaches a terminal status.
   *
   * Throws if max concurrent limit would be exceeded.
   */
  trackTransfer(transfer: InFlightTransfer): Promise<TransferResult> {
    if (this.tracked.has(transfer.id as string)) {
      logger.warn({ transferId: transfer.id }, 'Transfer already being tracked');
      return this.tracked.get(transfer.id as string)!.promise;
    }

    if (this.tracked.size >= this.maxConcurrent) {
      const error = new Error(
        `Max concurrent transfers reached (${this.maxConcurrent}). Cannot track transfer ${transfer.id}.`,
      );
      logger.error({ transferId: transfer.id, maxConcurrent: this.maxConcurrent }, error.message);
      return Promise.reject(error);
    }

    if (!transfer.txHash) {
      const error = new Error(`Cannot track transfer ${transfer.id} — txHash is null.`);
      logger.error({ transferId: transfer.id }, error.message);
      return Promise.reject(error);
    }

    const abortController = new AbortController();

    const promise = this.runPollingLoop(transfer, abortController.signal);

    const entry: TrackedEntry = { transfer, abortController, promise };
    this.tracked.set(transfer.id as string, entry);

    logger.info(
      { transferId: transfer.id, activeCount: this.tracked.size },
      'Transfer tracking started',
    );

    return promise;
  }

  /**
   * Returns the number of currently active tracked transfers.
   */
  getActiveCount(): number {
    return this.tracked.size;
  }

  /**
   * Cancels tracking for a specific transfer. The tracking promise will resolve
   * with a FAILED status.
   */
  cancelTracking(transferId: string): void {
    const entry = this.tracked.get(transferId);
    if (entry) {
      entry.abortController.abort();
      logger.info({ transferId }, 'Transfer tracking cancelled');
    }
  }

  /**
   * Cancels all active tracking. Used during shutdown.
   */
  cancelAll(): void {
    logger.info({ activeCount: this.tracked.size }, 'Cancelling all transfer tracking');
    for (const [id, entry] of this.tracked) {
      entry.abortController.abort();
    }
  }

  private async runPollingLoop(
    transfer: InFlightTransfer,
    signal: AbortSignal,
  ): Promise<TransferResult> {
    try {
      const statusUpdate = await this.statusPoller.pollUntilTerminal(
        {
          txHash: transfer.txHash!,
          bridge: transfer.bridge,
          fromChain: transfer.fromChain as number,
          toChain: transfer.toChain as number,
        },
        signal,
      );

      const result = this.terminalHandler.handleTerminalStatus(transfer, statusUpdate);

      logger.info(
        { transferId: transfer.id, finalStatus: result.status },
        'Transfer tracking completed',
      );

      return result;
    } catch (error) {
      logger.error(
        { transferId: transfer.id, error: error instanceof Error ? error.message : String(error) },
        'Transfer tracking error',
      );

      return {
        transferId: transfer.id,
        status: 'failed' as TransferStatus,
        receivedAmount: null,
        receivedToken: null,
        receivedChain: null,
      };
    } finally {
      this.tracked.delete(transfer.id as string);
    }
  }
}
