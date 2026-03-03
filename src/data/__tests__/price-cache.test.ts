import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PriceCache } from '../price-cache.js';

describe('PriceCache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns cached value within TTL', () => {
    const cache = new PriceCache(30_000);
    cache.set('1-0xabc', 100.5);
    expect(cache.get('1-0xabc')).toBe(100.5);
  });

  it('returns null after TTL expires', () => {
    const cache = new PriceCache(30_000);
    cache.set('1-0xabc', 100.5);
    vi.advanceTimersByTime(31_000);
    expect(cache.get('1-0xabc')).toBeNull();
  });

  it('returns null for non-existent key', () => {
    const cache = new PriceCache();
    expect(cache.get('missing')).toBeNull();
  });

  it('clear removes all entries', () => {
    const cache = new PriceCache();
    cache.set('a', 1);
    cache.set('b', 2);
    expect(cache.size).toBe(2);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get('a')).toBeNull();
  });

  it('invalidate removes a specific key', () => {
    const cache = new PriceCache();
    cache.set('a', 1);
    cache.set('b', 2);
    cache.invalidate('a');
    expect(cache.get('a')).toBeNull();
    expect(cache.get('b')).toBe(2);
  });

  it('overwrites existing entries', () => {
    const cache = new PriceCache();
    cache.set('a', 100);
    cache.set('a', 200);
    expect(cache.get('a')).toBe(200);
  });
});
