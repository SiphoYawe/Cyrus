// StatusPoller — polls LI.FI status endpoint until a terminal status is reached

import { createLogger } from '../utils/logger.js';
import {
  STATUS_POLL_BACKOFF,
  DEFAULT_STATUS_POLL_MAX_DURATION_MS,
} from '../core/constants.js';
import type { LiFiConnectorInterface } from './types.js';
import { parseStatusResponse } from './status-parser.js';
import type { StatusUpdate } from './status-parser.js';

const logger = createLogger('status-poller');

export interface PollParams {
  readonly txHash: string;
  readonly bridge: string;
  readonly fromChain: number;
  readonly toChain: number;
}

export interface StatusPollerOptions {
  /** Maximum duration in ms before timing out. Defaults to 30 minutes. */
  readonly maxDurationMs?: number;
  /** Injected sleep function — allows tests to override. Defaults to real setTimeout. */
  readonly sleep?: (ms: number) => Promise<void>;
}

const TERMINAL_STATUSES = new Set(['DONE', 'FAILED']);

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class StatusPoller {
  private readonly connector: LiFiConnectorInterface;
  private readonly maxDurationMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(connector: LiFiConnectorInterface, options: StatusPollerOptions = {}) {
    this.connector = connector;
    this.maxDurationMs = options.maxDurationMs ?? DEFAULT_STATUS_POLL_MAX_DURATION_MS;
    this.sleep = options.sleep ?? defaultSleep;
  }

  /**
   * Returns the polling delay in ms for a given attempt number (1-based).
   *
   * Tier 1: attempts 1-6  -> 10s
   * Tier 2: attempts 7-12 -> 30s
   * Tier 3: attempts 13-24 -> 60s
   * Tier 4: attempts 25+  -> 120s
   */
  static getPollingDelay(attempt: number): number {
    if (attempt <= STATUS_POLL_BACKOFF.TIER_1.maxAttempt) {
      return STATUS_POLL_BACKOFF.TIER_1.delayMs;
    }
    if (attempt <= STATUS_POLL_BACKOFF.TIER_2.maxAttempt) {
      return STATUS_POLL_BACKOFF.TIER_2.delayMs;
    }
    if (attempt <= STATUS_POLL_BACKOFF.TIER_3.maxAttempt) {
      return STATUS_POLL_BACKOFF.TIER_3.delayMs;
    }
    return STATUS_POLL_BACKOFF.TIER_4.delayMs;
  }

  /**
   * Polls the status endpoint until a terminal status (DONE or FAILED) is reached,
   * or the max duration is exceeded. NOT_FOUND and PENDING are non-terminal — keep polling.
   *
   * Supports cancellation via AbortSignal.
   */
  async pollUntilTerminal(
    params: PollParams,
    signal?: AbortSignal,
  ): Promise<StatusUpdate> {
    const startTime = Date.now();
    let attempt = 0;

    logger.info(
      { txHash: params.txHash, bridge: params.bridge, fromChain: params.fromChain, toChain: params.toChain },
      'Starting status polling',
    );

    while (true) {
      // Check abort signal
      if (signal?.aborted) {
        logger.warn({ txHash: params.txHash }, 'Polling aborted');
        return { status: 'FAILED' };
      }

      // Check max duration
      const elapsed = Date.now() - startTime;
      if (elapsed >= this.maxDurationMs) {
        logger.warn(
          { txHash: params.txHash, elapsed, maxDurationMs: this.maxDurationMs, attempts: attempt },
          'Polling timed out',
        );
        return { status: 'FAILED' };
      }

      attempt++;

      try {
        const rawResponse = await this.connector.getStatus(
          params.txHash,
          params.bridge,
          params.fromChain,
          params.toChain,
        );

        const statusUpdate = parseStatusResponse(rawResponse);

        logger.debug(
          {
            txHash: params.txHash,
            attempt,
            status: statusUpdate.status,
            substatus: statusUpdate.substatus,
          },
          'Poll result',
        );

        if (TERMINAL_STATUSES.has(statusUpdate.status)) {
          logger.info(
            {
              txHash: params.txHash,
              status: statusUpdate.status,
              substatus: statusUpdate.substatus,
              attempts: attempt,
              elapsed: Date.now() - startTime,
            },
            'Terminal status reached',
          );
          return statusUpdate;
        }

        // Non-terminal (NOT_FOUND or PENDING) — wait and poll again
      } catch (error) {
        logger.warn(
          { txHash: params.txHash, attempt, error: error instanceof Error ? error.message : String(error) },
          'Status poll request failed, will retry',
        );
      }

      // Wait before next poll
      const delay = StatusPoller.getPollingDelay(attempt);
      await this.sleep(delay);
    }
  }
}
