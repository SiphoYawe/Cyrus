import { describe, it, expect } from 'vitest';
import { parseStatusResponse } from './status-parser.js';

describe('parseStatusResponse', () => {
  describe('COMPLETED response', () => {
    it('parses a fully completed transfer', () => {
      const raw = {
        status: 'DONE',
        substatus: 'COMPLETED',
        receiving: {
          amount: '995000',
          token: {
            address: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
            symbol: 'USDC',
            decimals: 6,
            chainId: 42161,
          },
          chainId: 42161,
        },
        sending: {
          amount: '1000000',
          token: {
            address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
            symbol: 'USDC',
            decimals: 6,
            chainId: 1,
          },
          chainId: 1,
        },
        tool: 'stargate',
        substatusMessage: 'Transfer completed successfully',
        lifiExplorerLink: 'https://explorer.lifi.io/tx/0xabc',
      };

      const result = parseStatusResponse(raw);

      expect(result.status).toBe('DONE');
      expect(result.substatus).toBe('COMPLETED');
      expect(result.receiving).toBeDefined();
      expect(result.receiving!.amount).toBe('995000');
      expect(result.receiving!.token.symbol).toBe('USDC');
      expect(result.receiving!.token.decimals).toBe(6);
      expect(result.receiving!.token.chainId).toBe(42161);
      expect(result.receiving!.chainId).toBe(42161);
      expect(result.sending).toBeDefined();
      expect(result.sending!.amount).toBe('1000000');
      expect(result.tool).toBe('stargate');
      expect(result.substatusMessage).toBe('Transfer completed successfully');
      expect(result.lifiExplorerLink).toBe('https://explorer.lifi.io/tx/0xabc');
    });
  });

  describe('PARTIAL response', () => {
    it('parses a partially filled transfer', () => {
      const raw = {
        status: 'DONE',
        substatus: 'PARTIAL',
        receiving: {
          amount: '500000',
          token: {
            address: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
            symbol: 'USDC',
            decimals: 6,
            chainId: 42161,
          },
          chainId: 42161,
        },
        tool: 'stargate',
        substatusMessage: 'Partial fill due to liquidity',
      };

      const result = parseStatusResponse(raw);

      expect(result.status).toBe('DONE');
      expect(result.substatus).toBe('PARTIAL');
      expect(result.receiving!.amount).toBe('500000');
      expect(result.substatusMessage).toBe('Partial fill due to liquidity');
    });
  });

  describe('REFUNDED response', () => {
    it('parses a refunded transfer', () => {
      const raw = {
        status: 'DONE',
        substatus: 'REFUNDED',
        sending: {
          amount: '1000000',
          token: {
            address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
            symbol: 'USDC',
            decimals: 6,
            chainId: 1,
          },
          chainId: 1,
        },
        tool: 'hop',
        substatusMessage: 'Bridge failed, funds refunded',
      };

      const result = parseStatusResponse(raw);

      expect(result.status).toBe('DONE');
      expect(result.substatus).toBe('REFUNDED');
      expect(result.sending!.amount).toBe('1000000');
      expect(result.receiving).toBeUndefined();
      expect(result.tool).toBe('hop');
    });
  });

  describe('FAILED response', () => {
    it('parses a failed transfer', () => {
      const raw = {
        status: 'FAILED',
        substatusMessage: 'Transaction reverted',
      };

      const result = parseStatusResponse(raw);

      expect(result.status).toBe('FAILED');
      expect(result.substatus).toBeUndefined();
      expect(result.receiving).toBeUndefined();
      expect(result.substatusMessage).toBe('Transaction reverted');
    });
  });

  describe('NOT_FOUND response', () => {
    it('parses a NOT_FOUND response', () => {
      const raw = {
        status: 'NOT_FOUND',
      };

      const result = parseStatusResponse(raw);

      expect(result.status).toBe('NOT_FOUND');
      expect(result.substatus).toBeUndefined();
      expect(result.receiving).toBeUndefined();
      expect(result.sending).toBeUndefined();
    });
  });

  describe('PENDING response', () => {
    it('parses a PENDING response', () => {
      const raw = {
        status: 'PENDING',
        tool: 'across',
      };

      const result = parseStatusResponse(raw);

      expect(result.status).toBe('PENDING');
      expect(result.tool).toBe('across');
    });
  });

  describe('edge cases', () => {
    it('handles null response', () => {
      const result = parseStatusResponse(null);
      expect(result.status).toBe('NOT_FOUND');
    });

    it('handles undefined response', () => {
      const result = parseStatusResponse(undefined);
      expect(result.status).toBe('NOT_FOUND');
    });

    it('handles empty object', () => {
      const result = parseStatusResponse({});
      expect(result.status).toBe('NOT_FOUND');
    });

    it('handles unknown status string', () => {
      const result = parseStatusResponse({ status: 'INVALID_STATUS' });
      expect(result.status).toBe('NOT_FOUND');
    });

    it('handles unknown substatus string', () => {
      const result = parseStatusResponse({ status: 'DONE', substatus: 'UNKNOWN' });
      expect(result.status).toBe('DONE');
      expect(result.substatus).toBeUndefined();
    });

    it('handles array input', () => {
      const result = parseStatusResponse([1, 2, 3]);
      expect(result.status).toBe('NOT_FOUND');
    });

    it('handles numeric status', () => {
      const result = parseStatusResponse({ status: 42 });
      expect(result.status).toBe('NOT_FOUND');
    });

    it('falls back to bridge field when tool is missing', () => {
      const raw = {
        status: 'PENDING',
        bridge: 'stargate',
      };

      const result = parseStatusResponse(raw);
      expect(result.tool).toBe('stargate');
    });

    it('prefers tool over bridge when both present', () => {
      const raw = {
        status: 'PENDING',
        tool: 'across',
        bridge: 'stargate',
      };

      const result = parseStatusResponse(raw);
      expect(result.tool).toBe('across');
    });

    it('handles receiving without token info', () => {
      const raw = {
        status: 'DONE',
        substatus: 'COMPLETED',
        receiving: {
          amount: '1000',
        },
      };

      const result = parseStatusResponse(raw);
      // receiving should be undefined because token is missing
      expect(result.receiving).toBeUndefined();
    });

    it('handles receiving with amount but invalid token', () => {
      const raw = {
        status: 'DONE',
        substatus: 'COMPLETED',
        receiving: {
          amount: '1000',
          token: 'invalid',
        },
      };

      const result = parseStatusResponse(raw);
      expect(result.receiving).toBeUndefined();
    });

    it('uses token chainId when receiving chainId is missing', () => {
      const raw = {
        status: 'DONE',
        substatus: 'COMPLETED',
        receiving: {
          amount: '1000',
          token: {
            address: '0xabc',
            symbol: 'TEST',
            decimals: 18,
            chainId: 137,
          },
        },
      };

      const result = parseStatusResponse(raw);
      expect(result.receiving).toBeDefined();
      expect(result.receiving!.chainId).toBe(137);
    });
  });
});
