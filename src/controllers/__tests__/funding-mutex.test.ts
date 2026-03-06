import { describe, it, expect, beforeEach } from 'vitest';
import { FundingMutex } from '../funding-mutex.js';

describe('FundingMutex', () => {
  let mutex: FundingMutex;

  beforeEach(() => {
    mutex = new FundingMutex(100); // 100ms timeout for fast tests
  });

  it('allows first acquirer to succeed', () => {
    expect(mutex.acquire('funding')).toBe(true);
    expect(mutex.getHolder()).toBe('funding');
  });

  it('blocks second acquirer while held', () => {
    mutex.acquire('funding');
    expect(mutex.acquire('withdrawal')).toBe(false);
    expect(mutex.getHolder()).toBe('funding');
  });

  it('allows acquisition after release', () => {
    mutex.acquire('funding');
    mutex.release('funding');
    expect(mutex.acquire('withdrawal')).toBe(true);
    expect(mutex.getHolder()).toBe('withdrawal');
  });

  it('only allows holder to release', () => {
    mutex.acquire('funding');
    mutex.release('withdrawal'); // wrong holder — should not release
    expect(mutex.isHeld()).toBe(true);
    expect(mutex.getHolder()).toBe('funding');
  });

  it('auto-releases after timeout', async () => {
    mutex.acquire('funding');
    expect(mutex.isHeld()).toBe(true);

    await new Promise((r) => setTimeout(r, 150));

    expect(mutex.isHeld()).toBe(false);
    expect(mutex.getHolder()).toBeNull();
  });

  it('allows re-acquisition after auto-release', async () => {
    mutex.acquire('funding');
    await new Promise((r) => setTimeout(r, 150));

    expect(mutex.acquire('withdrawal')).toBe(true);
    expect(mutex.getHolder()).toBe('withdrawal');
  });

  it('forceRelease clears regardless of holder', () => {
    mutex.acquire('withdrawal');
    mutex.forceRelease();
    expect(mutex.isHeld()).toBe(false);
    expect(mutex.getHolder()).toBeNull();
  });

  it('reports not held when empty', () => {
    expect(mutex.isHeld()).toBe(false);
    expect(mutex.getHolder()).toBeNull();
  });
});
