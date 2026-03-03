import { describe, it, expect } from 'vitest';
import { classifyLiFiError, ERROR_KIND } from './error-classifier.js';

describe('classifyLiFiError', () => {
  it('classifies 400 as non-retryable QUOTE error', () => {
    const result = classifyLiFiError(400);
    expect(result.retryable).toBe(false);
    expect(result.maxRetries).toBe(0);
    expect(result.errorKind).toBe(ERROR_KIND.QUOTE);
    expect(result.baseDelayMs).toBe(0);
  });

  it('classifies 404 as non-retryable QUOTE error', () => {
    const result = classifyLiFiError(404);
    expect(result.retryable).toBe(false);
    expect(result.maxRetries).toBe(0);
    expect(result.errorKind).toBe(ERROR_KIND.QUOTE);
    expect(result.baseDelayMs).toBe(0);
  });

  it('classifies 429 as retryable RATE_LIMIT error with 5 retries', () => {
    const result = classifyLiFiError(429);
    expect(result.retryable).toBe(true);
    expect(result.maxRetries).toBe(5);
    expect(result.errorKind).toBe(ERROR_KIND.RATE_LIMIT);
    expect(result.baseDelayMs).toBe(1000);
  });

  it('classifies 500 as retryable SERVER error with 1 retry', () => {
    const result = classifyLiFiError(500);
    expect(result.retryable).toBe(true);
    expect(result.maxRetries).toBe(1);
    expect(result.errorKind).toBe(ERROR_KIND.SERVER);
    expect(result.baseDelayMs).toBe(2000);
  });

  it('classifies 503 as retryable SERVER error with 1 retry', () => {
    const result = classifyLiFiError(503);
    expect(result.retryable).toBe(true);
    expect(result.maxRetries).toBe(1);
    expect(result.errorKind).toBe(ERROR_KIND.SERVER);
    expect(result.baseDelayMs).toBe(2000);
  });

  it('classifies unknown status codes as non-retryable SERVER error', () => {
    const result = classifyLiFiError(418);
    expect(result.retryable).toBe(false);
    expect(result.maxRetries).toBe(0);
    expect(result.errorKind).toBe(ERROR_KIND.SERVER);
    expect(result.baseDelayMs).toBe(0);
  });

  it('classifies 401 as non-retryable SERVER error', () => {
    const result = classifyLiFiError(401);
    expect(result.retryable).toBe(false);
    expect(result.maxRetries).toBe(0);
    expect(result.errorKind).toBe(ERROR_KIND.SERVER);
  });

  it('classifies 403 as non-retryable SERVER error', () => {
    const result = classifyLiFiError(403);
    expect(result.retryable).toBe(false);
    expect(result.maxRetries).toBe(0);
    expect(result.errorKind).toBe(ERROR_KIND.SERVER);
  });
});
