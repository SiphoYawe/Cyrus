import { describe, it, expect } from 'vitest';
import {
  chainId,
  tokenAddress,
  transferId,
  isChainId,
  isTokenAddress,
  isTransferId,
} from './types.js';

describe('branded type constructors', () => {
  it('creates ChainId from number', () => {
    const id = chainId(42161);
    expect(id).toBe(42161);
  });

  it('creates TokenAddress from string (lowercased)', () => {
    const addr = tokenAddress('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48');
    expect(addr).toBe('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
  });

  it('creates TransferId from string', () => {
    const id = transferId('abc-123');
    expect(id).toBe('abc-123');
  });
});

describe('type guards', () => {
  it('isChainId returns true for positive integers', () => {
    expect(isChainId(1)).toBe(true);
    expect(isChainId(42161)).toBe(true);
  });

  it('isChainId returns false for invalid values', () => {
    expect(isChainId(0)).toBe(false);
    expect(isChainId(-1)).toBe(false);
    expect(isChainId(1.5)).toBe(false);
    expect(isChainId('1')).toBe(false);
    expect(isChainId(null)).toBe(false);
  });

  it('isTokenAddress returns true for valid 0x addresses', () => {
    expect(isTokenAddress('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48')).toBe(true);
    expect(isTokenAddress('0x0000000000000000000000000000000000000000')).toBe(true);
  });

  it('isTokenAddress returns false for invalid values', () => {
    expect(isTokenAddress('not-an-address')).toBe(false);
    expect(isTokenAddress('0xshort')).toBe(false);
    expect(isTokenAddress(123)).toBe(false);
  });

  it('isTransferId returns true for non-empty strings', () => {
    expect(isTransferId('abc')).toBe(true);
  });

  it('isTransferId returns false for empty string', () => {
    expect(isTransferId('')).toBe(false);
    expect(isTransferId(null)).toBe(false);
  });
});
