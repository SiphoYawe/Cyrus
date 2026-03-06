// FundingMutex — shared coordination between FundingController and WithdrawalController
// Prevents simultaneous funding and withdrawal operations that could conflict

import { createLogger } from '../utils/logger.js';

const logger = createLogger('funding-mutex');

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export class FundingMutex {
  private holder: 'funding' | 'withdrawal' | null = null;
  private acquiredAt = 0;
  private readonly timeoutMs: number;

  constructor(timeoutMs?: number) {
    this.timeoutMs = timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Try to acquire the mutex. Returns true if acquired.
   * Auto-releases stale locks past the timeout.
   */
  acquire(requester: 'funding' | 'withdrawal'): boolean {
    this.autoRelease();

    if (this.holder !== null) {
      logger.debug(
        { requester, holder: this.holder, elapsedMs: Date.now() - this.acquiredAt },
        'Mutex held by another controller, skipping',
      );
      return false;
    }

    this.holder = requester;
    this.acquiredAt = Date.now();
    logger.debug({ requester }, 'Mutex acquired');
    return true;
  }

  /**
   * Release the mutex. Only the holder can release it.
   */
  release(requester: 'funding' | 'withdrawal'): void {
    if (this.holder === requester) {
      logger.debug({ requester }, 'Mutex released');
      this.holder = null;
      this.acquiredAt = 0;
    }
  }

  /**
   * Force-release regardless of holder (used during shutdown).
   */
  forceRelease(): void {
    if (this.holder) {
      logger.info({ holder: this.holder }, 'Mutex force-released');
    }
    this.holder = null;
    this.acquiredAt = 0;
  }

  isHeld(): boolean {
    this.autoRelease();
    return this.holder !== null;
  }

  getHolder(): 'funding' | 'withdrawal' | null {
    this.autoRelease();
    return this.holder;
  }

  private autoRelease(): void {
    if (this.holder !== null && Date.now() - this.acquiredAt > this.timeoutMs) {
      logger.warn(
        { holder: this.holder, elapsedMs: Date.now() - this.acquiredAt },
        'Mutex auto-released due to timeout',
      );
      this.holder = null;
      this.acquiredAt = 0;
    }
  }
}
