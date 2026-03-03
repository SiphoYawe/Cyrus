import { describe, it, expect } from 'vitest';
import {
  CyrusError,
  LiFiQuoteError,
  BridgeTimeoutError,
  InsufficientBalanceError,
  ConfigValidationError,
  ApprovalError,
} from './errors.js';

describe('domain error classes', () => {
  it('CyrusError has name and context', () => {
    const err = new CyrusError('test error', { foo: 'bar' });
    expect(err.name).toBe('CyrusError');
    expect(err.message).toBe('test error');
    expect(err.context.foo).toBe('bar');
    expect(err).toBeInstanceOf(Error);
  });

  it('LiFiQuoteError serializes context', () => {
    const err = new LiFiQuoteError('No route found', {
      chainId: 1,
      fromToken: '0xabc',
      toToken: '0xdef',
      amount: '1000000',
      statusCode: 404,
    });
    expect(err.name).toBe('LiFiQuoteError');
    expect(err.context.chainId).toBe(1);
    expect(err.context.statusCode).toBe(404);
  });

  it('BridgeTimeoutError includes elapsed time', () => {
    const err = new BridgeTimeoutError({
      transferId: 'tx-1',
      bridge: 'stargate',
      fromChain: 1,
      toChain: 42161,
      elapsed: 1800000,
    });
    expect(err.name).toBe('BridgeTimeoutError');
    expect(err.message).toContain('1800000');
    expect(err.message).toContain('stargate');
  });

  it('InsufficientBalanceError shows required vs available', () => {
    const err = new InsufficientBalanceError({
      chainId: 1,
      token: '0xabc',
      required: 1000000n,
      available: 500000n,
    });
    expect(err.name).toBe('InsufficientBalanceError');
    expect(err.message).toContain('1000000');
    expect(err.message).toContain('500000');
  });

  it('ConfigValidationError shows path and values', () => {
    const err = new ConfigValidationError({
      path: 'risk.defaultSlippage',
      expected: 'number between 0 and 0.1',
      received: '-0.5',
    });
    expect(err.name).toBe('ConfigValidationError');
    expect(err.context.path).toBe('risk.defaultSlippage');
  });

  it('ApprovalError includes token and spender', () => {
    const err = new ApprovalError({
      token: '0xabc',
      spender: '0xdef',
      amount: '1000000',
    });
    expect(err.name).toBe('ApprovalError');
    expect(err.context.token).toBe('0xabc');
  });
});
