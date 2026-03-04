// Backtest-specific error classes

import { CyrusError } from '../utils/errors.js';

/**
 * Thrown when a backtest attempts to access data beyond the current simulated timestamp.
 * This indicates a lookahead bias bug — strategies must only see data at or before the current tick.
 */
export class LookaheadError extends CyrusError {
  readonly requestedTimestamp: number;
  readonly cursorTimestamp: number;

  constructor(context: {
    requestedTimestamp: number;
    cursorTimestamp: number;
    token?: string;
    chainId?: number;
  }) {
    super(
      `Lookahead violation: requested timestamp ${context.requestedTimestamp} is beyond cursor ${context.cursorTimestamp}`,
      {
        requestedTimestamp: context.requestedTimestamp,
        cursorTimestamp: context.cursorTimestamp,
        token: context.token,
        chainId: context.chainId,
      },
    );
    this.requestedTimestamp = context.requestedTimestamp;
    this.cursorTimestamp = context.cursorTimestamp;
  }
}
