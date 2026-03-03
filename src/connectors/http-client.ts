// REST HTTP client for LI.FI API — wraps native fetch with error classification and retry

import { LIFI_BASE_URL } from '../core/constants.js';
import { createLogger } from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';
import { CyrusError, LiFiQuoteError, RateLimitError } from '../utils/errors.js';
import { classifyLiFiError, ERROR_KIND } from './error-classifier.js';

const logger = createLogger('http-client');

export interface LiFiHttpClientOptions {
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly fetchFn?: typeof globalThis.fetch;
}

export class LiFiHttpClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly fetchFn: typeof globalThis.fetch;

  constructor(options: LiFiHttpClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? LIFI_BASE_URL;
    this.apiKey = options.apiKey;
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
  }

  async get<T>(path: string, params?: Record<string, string | number | boolean | undefined>): Promise<T> {
    const url = this.buildUrl(path, params);
    logger.debug({ method: 'GET', path, params }, 'HTTP request');

    return this.requestWithRetry<T>('GET', url);
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    const url = this.buildUrl(path);
    logger.debug({ method: 'POST', path }, 'HTTP request');

    return this.requestWithRetry<T>('POST', url, body);
  }

  private buildUrl(
    path: string,
    params?: Record<string, string | number | boolean | undefined>
  ): string {
    const url = new URL(`${this.baseUrl}${path}`);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      }
    }
    return url.toString();
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    };
    if (this.apiKey) {
      headers['x-lifi-api-key'] = this.apiKey;
    }
    return headers;
  }

  private async requestWithRetry<T>(
    method: string,
    url: string,
    body?: unknown
  ): Promise<T> {
    const makeRequest = async (): Promise<T> => {
      const response = await this.fetchFn(url, {
        method,
        headers: this.buildHeaders(),
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });

      if (!response.ok) {
        const classification = classifyLiFiError(response.status);
        const responseBody = await response.text().catch(() => 'no body');

        logger.warn(
          {
            method,
            url,
            status: response.status,
            retryable: classification.retryable,
            responseBody: responseBody.slice(0, 500),
          },
          'HTTP error response'
        );

        // Construct the appropriate domain error based on classification
        switch (classification.errorKind) {
          case ERROR_KIND.RATE_LIMIT:
            throw new RateLimitError({ endpoint: url });
          case ERROR_KIND.QUOTE:
            throw new LiFiQuoteError(
              `LI.FI API error ${response.status}: ${responseBody.slice(0, 200)}`,
              { statusCode: response.status }
            );
          default:
            throw new CyrusError(
              `LI.FI API error ${response.status}: ${responseBody.slice(0, 200)}`,
              { statusCode: response.status, url, method }
            );
        }
      }

      const data = (await response.json()) as T;
      logger.debug({ method, url, status: response.status }, 'HTTP response OK');
      return data;
    };

    // Attempt the request — if it fails, check if retryable based on error type
    try {
      return await makeRequest();
    } catch (error) {
      // RateLimitError (429) → retry with rate limit policy
      if (error instanceof RateLimitError) {
        const classification = classifyLiFiError(429);
        return withRetry(makeRequest, {
          maxRetries: classification.maxRetries,
          baseDelayMs: classification.baseDelayMs,
          maxDelayMs: 30_000,
        });
      }

      // CyrusError (non-quote) → may be server error, check if retryable
      if (error instanceof CyrusError && !(error instanceof LiFiQuoteError)) {
        const statusCode = (error.context.statusCode as number) ?? 0;
        const classification = classifyLiFiError(statusCode);
        if (classification.retryable) {
          return withRetry(makeRequest, {
            maxRetries: classification.maxRetries,
            baseDelayMs: classification.baseDelayMs,
            maxDelayMs: 30_000,
          });
        }
      }

      // Non-retryable errors (LiFiQuoteError, unknown) — rethrow
      throw error;
    }
  }
}
