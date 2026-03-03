// Error classification for LI.FI API responses — determines retry strategy

export const ERROR_KIND = {
  QUOTE: 'QUOTE',
  RATE_LIMIT: 'RATE_LIMIT',
  SERVER: 'SERVER',
} as const;

export type ErrorKind = (typeof ERROR_KIND)[keyof typeof ERROR_KIND];

export interface ClassifiedError {
  readonly retryable: boolean;
  readonly maxRetries: number;
  readonly errorKind: ErrorKind;
  readonly baseDelayMs: number;
}

/**
 * Classify an HTTP status code from LI.FI API into retry behavior.
 *
 * - 400 → not retryable (bad request / invalid params)
 * - 404 → not retryable (no route found)
 * - 429 → retryable, up to 5 retries, 1s base delay (rate limit)
 * - 500 → retryable, up to 1 retry, 2s base delay (server error)
 * - 503 → retryable, up to 1 retry, 2s base delay (service unavailable)
 * - others → not retryable by default
 */
export function classifyLiFiError(statusCode: number): ClassifiedError {
  switch (statusCode) {
    case 400:
      return {
        retryable: false,
        maxRetries: 0,
        errorKind: ERROR_KIND.QUOTE,
        baseDelayMs: 0,
      };

    case 404:
      return {
        retryable: false,
        maxRetries: 0,
        errorKind: ERROR_KIND.QUOTE,
        baseDelayMs: 0,
      };

    case 429:
      return {
        retryable: true,
        maxRetries: 5,
        errorKind: ERROR_KIND.RATE_LIMIT,
        baseDelayMs: 1000,
      };

    case 500:
      return {
        retryable: true,
        maxRetries: 1,
        errorKind: ERROR_KIND.SERVER,
        baseDelayMs: 2000,
      };

    case 503:
      return {
        retryable: true,
        maxRetries: 1,
        errorKind: ERROR_KIND.SERVER,
        baseDelayMs: 2000,
      };

    default:
      return {
        retryable: false,
        maxRetries: 0,
        errorKind: ERROR_KIND.SERVER,
        baseDelayMs: 0,
      };
  }
}
