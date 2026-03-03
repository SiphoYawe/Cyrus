import { sleep } from './sleep.js';
import { createLogger } from './logger.js';

const logger = createLogger('retry');

export interface RetryOptions {
  readonly maxRetries: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

const DEFAULT_OPTIONS: RetryOptions = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
};

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: Partial<RetryOptions> = {}
): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt === opts.maxRetries) {
        break;
      }

      const delay = Math.min(
        Math.pow(2, attempt) * opts.baseDelayMs,
        opts.maxDelayMs
      );

      logger.warn(
        { attempt: attempt + 1, maxRetries: opts.maxRetries, delay, error: lastError.message },
        'Retrying after error'
      );

      await sleep(delay);
    }
  }

  throw lastError;
}
