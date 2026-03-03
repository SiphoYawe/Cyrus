import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TTLCache } from './cache.js';

describe('TTLCache', () => {
  let cache: TTLCache<string>;

  beforeEach(() => {
    cache = new TTLCache<string>();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns undefined for missing keys', () => {
    expect(cache.get('nonexistent')).toBeUndefined();
  });

  it('stores and retrieves values', () => {
    cache.set('key1', 'value1', 60_000);
    expect(cache.get('key1')).toBe('value1');
  });

  it('returns undefined after TTL expires', () => {
    cache.set('key1', 'value1', 1000);
    expect(cache.get('key1')).toBe('value1');

    vi.advanceTimersByTime(1001);
    expect(cache.get('key1')).toBeUndefined();
  });

  it('has() returns true for valid entries', () => {
    cache.set('key1', 'value1', 60_000);
    expect(cache.has('key1')).toBe(true);
  });

  it('has() returns false for expired entries', () => {
    cache.set('key1', 'value1', 1000);
    vi.advanceTimersByTime(1001);
    expect(cache.has('key1')).toBe(false);
  });

  it('has() returns false for missing entries', () => {
    expect(cache.has('key1')).toBe(false);
  });

  it('invalidate() removes a specific key', () => {
    cache.set('key1', 'value1', 60_000);
    cache.set('key2', 'value2', 60_000);

    cache.invalidate('key1');

    expect(cache.get('key1')).toBeUndefined();
    expect(cache.get('key2')).toBe('value2');
  });

  it('clear() removes all entries', () => {
    cache.set('key1', 'value1', 60_000);
    cache.set('key2', 'value2', 60_000);

    cache.clear();

    expect(cache.get('key1')).toBeUndefined();
    expect(cache.get('key2')).toBeUndefined();
  });

  it('overwrites existing entries with new TTL', () => {
    cache.set('key1', 'old', 1000);
    cache.set('key1', 'new', 60_000);

    vi.advanceTimersByTime(1001);
    expect(cache.get('key1')).toBe('new');
  });

  it('size counts only non-expired entries', () => {
    cache.set('key1', 'value1', 1000);
    cache.set('key2', 'value2', 60_000);

    expect(cache.size).toBe(2);

    vi.advanceTimersByTime(1001);
    expect(cache.size).toBe(1);
  });

  it('works with complex object values', () => {
    const objectCache = new TTLCache<{ foo: number; bar: string }>();
    const value = { foo: 42, bar: 'hello' };
    objectCache.set('key1', value, 60_000);

    const retrieved = objectCache.get('key1');
    expect(retrieved).toEqual(value);
  });
});
