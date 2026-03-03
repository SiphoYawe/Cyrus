import { describe, it, expect } from 'vitest';
import {
  formatUnits,
  parseUnits,
  mulDiv,
  percentOf,
  min,
  max,
  abs,
} from './bigint.js';

describe('formatUnits', () => {
  it('formats 18-decimal values (ETH)', () => {
    expect(formatUnits(1000000000000000000n, 18)).toBe('1');
    expect(formatUnits(1500000000000000000n, 18)).toBe('1.5');
    expect(formatUnits(100000000000000n, 18)).toBe('0.0001');
  });

  it('formats 6-decimal values (USDC)', () => {
    expect(formatUnits(1000000n, 6)).toBe('1');
    expect(formatUnits(10000000n, 6)).toBe('10');
    expect(formatUnits(1500000n, 6)).toBe('1.5');
    expect(formatUnits(123456n, 6)).toBe('0.123456');
  });

  it('formats zero', () => {
    expect(formatUnits(0n, 18)).toBe('0');
    expect(formatUnits(0n, 6)).toBe('0');
  });

  it('handles negative values', () => {
    expect(formatUnits(-1000000000000000000n, 18)).toBe('-1');
  });
});

describe('parseUnits', () => {
  it('parses 18-decimal values (ETH)', () => {
    expect(parseUnits('1', 18)).toBe(1000000000000000000n);
    expect(parseUnits('1.5', 18)).toBe(1500000000000000000n);
    expect(parseUnits('0.0001', 18)).toBe(100000000000000n);
  });

  it('parses 6-decimal values (USDC)', () => {
    expect(parseUnits('1', 6)).toBe(1000000n);
    expect(parseUnits('10', 6)).toBe(10000000n);
    expect(parseUnits('1.5', 6)).toBe(1500000n);
  });

  it('parses zero', () => {
    expect(parseUnits('0', 18)).toBe(0n);
  });

  it('throws on too many decimals', () => {
    expect(() => parseUnits('1.1234567', 6)).toThrow('Too many decimal places');
  });
});

describe('mulDiv', () => {
  it('computes (a * b) / d', () => {
    expect(mulDiv(100n, 200n, 50n)).toBe(400n);
  });

  it('throws on division by zero', () => {
    expect(() => mulDiv(100n, 200n, 0n)).toThrow('Division by zero');
  });
});

describe('percentOf', () => {
  it('calculates basis points', () => {
    // 50% of 1000 = 500
    expect(percentOf(1000n, 5000n)).toBe(500n);
    // 1% of 10000 = 100
    expect(percentOf(10000n, 100n)).toBe(100n);
  });
});

describe('min/max/abs', () => {
  it('min returns smaller value', () => {
    expect(min(10n, 20n)).toBe(10n);
    expect(min(20n, 10n)).toBe(10n);
  });

  it('max returns larger value', () => {
    expect(max(10n, 20n)).toBe(20n);
  });

  it('abs returns absolute value', () => {
    expect(abs(-10n)).toBe(10n);
    expect(abs(10n)).toBe(10n);
    expect(abs(0n)).toBe(0n);
  });
});
