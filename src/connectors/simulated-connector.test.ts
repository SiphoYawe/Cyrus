import { describe, it, expect } from 'vitest';
import { SimulatedConnector } from './simulated-connector.js';
import { chainId, tokenAddress } from '../core/types.js';
import type { QuoteParams } from './types.js';

describe('SimulatedConnector', () => {
  describe('getQuote', () => {
    it('returns default mock quote', async () => {
      const connector = new SimulatedConnector();

      const params: QuoteParams = {
        fromChain: chainId(1),
        toChain: chainId(42161),
        fromToken: tokenAddress('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'),
        toToken: tokenAddress('0xaf88d065e77c8cc2239327c5edb3a432268e5831'),
        fromAmount: '1000000',
      };

      const quote = await connector.getQuote(params);

      expect(quote.tool).toBe('stargate');
      expect(quote.estimate.toAmount).toBe('999000000');
      expect(quote.action.fromChainId).toBe(1);
      expect(quote.action.toChainId).toBe(42161);
    });

    it('returns custom quote when configured', async () => {
      const connector = new SimulatedConnector({
        defaultQuote: {
          tool: 'hop',
          estimate: {
            approvalAddress: '0xcustom',
            toAmount: '500000',
            toAmountMin: '498000',
            executionDuration: 60,
            gasCosts: [],
          },
        },
      });

      const quote = await connector.getQuote({
        fromChain: chainId(1),
        toChain: chainId(10),
        fromToken: tokenAddress('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'),
        toToken: tokenAddress('0x0b2c639c533813f4aa9d7837caf62653d097ff85'),
        fromAmount: '500000',
      });

      expect(quote.tool).toBe('hop');
      expect(quote.estimate.toAmount).toBe('500000');
    });
  });

  describe('getRoutes', () => {
    it('returns default mock route', async () => {
      const connector = new SimulatedConnector();

      const routes = await connector.getRoutes({
        fromChainId: 1,
        toChainId: 42161,
        fromTokenAddress: '0xusdc',
        toTokenAddress: '0xusdc_arb',
        fromAmount: '1000000',
      });

      expect(routes).toHaveLength(1);
      expect(routes[0].id).toBe('route-mock-001');
    });

    it('returns custom routes when configured', async () => {
      const connector = new SimulatedConnector({
        defaultRoutes: [
          { id: 'custom-1', gasCostUSD: '1.00' },
          { id: 'custom-2', gasCostUSD: '2.00' },
        ],
      });

      const routes = await connector.getRoutes({
        fromChainId: 1,
        toChainId: 42161,
        fromTokenAddress: '0xusdc',
        toTokenAddress: '0xusdc_arb',
        fromAmount: '1000000',
      });

      expect(routes).toHaveLength(2);
      expect(routes[0].id).toBe('custom-1');
      expect(routes[1].id).toBe('custom-2');
    });
  });

  describe('getChains', () => {
    it('returns default chains', async () => {
      const connector = new SimulatedConnector();
      const chains = await connector.getChains();

      expect(chains.length).toBeGreaterThan(0);
      expect(chains[0].id).toBe(1);
      expect(chains[0].name).toBe('Ethereum');
    });

    it('returns custom chains', async () => {
      const connector = new SimulatedConnector({
        chains: [{ id: 999, key: 'test', name: 'TestChain', nativeToken: { symbol: 'T', decimals: 18, address: '0x0' } }],
      });

      const chains = await connector.getChains();
      expect(chains).toHaveLength(1);
      expect(chains[0].id).toBe(999);
    });
  });

  describe('getTokens', () => {
    it('returns default tokens', async () => {
      const connector = new SimulatedConnector();
      const tokens = await connector.getTokens();

      expect(tokens.length).toBeGreaterThan(0);
      expect(tokens[0].symbol).toBe('USDC');
    });

    it('filters by chainId', async () => {
      const connector = new SimulatedConnector({
        tokens: [
          { address: '0x1', symbol: 'A', decimals: 18, chainId: 1, name: 'A' },
          { address: '0x2', symbol: 'B', decimals: 18, chainId: 42161, name: 'B' },
        ],
      });

      const tokens = await connector.getTokens(42161);
      expect(tokens).toHaveLength(1);
      expect(tokens[0].symbol).toBe('B');
    });
  });

  describe('getStatus', () => {
    it('returns default DONE status', async () => {
      const connector = new SimulatedConnector();
      const status = await connector.getStatus('0xhash', 'stargate', 1, 42161);

      expect(status.status).toBe('DONE');
      expect(status.substatus).toBe('COMPLETED');
    });

    it('returns custom status when configured', async () => {
      const connector = new SimulatedConnector({
        status: { status: 'PENDING' },
      });

      const status = await connector.getStatus('0xhash', 'stargate', 1, 42161);
      expect(status.status).toBe('PENDING');
    });
  });

  describe('getConnections', () => {
    it('returns default connections', async () => {
      const connector = new SimulatedConnector();
      const connections = await connector.getConnections(1, 42161);

      expect(connections).toHaveLength(1);
      expect(connections[0].fromChainId).toBe(1);
      expect(connections[0].toChainId).toBe(42161);
    });
  });

  describe('getTools', () => {
    it('returns default tools', async () => {
      const connector = new SimulatedConnector();
      const tools = await connector.getTools();

      expect(tools).toHaveLength(2);
      expect(tools[0].key).toBe('stargate');
      expect(tools[1].key).toBe('uniswap');
    });
  });

  describe('error injection', () => {
    it('throws configured error', async () => {
      const connector = new SimulatedConnector({
        errorToThrow: new Error('simulated failure'),
      });

      await expect(connector.getQuote({
        fromChain: chainId(1),
        toChain: chainId(42161),
        fromToken: tokenAddress('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'),
        toToken: tokenAddress('0xaf88d065e77c8cc2239327c5edb3a432268e5831'),
        fromAmount: '1000000',
      })).rejects.toThrow('simulated failure');

      await expect(connector.getChains()).rejects.toThrow('simulated failure');
      await expect(connector.getTokens()).rejects.toThrow('simulated failure');
    });

    it('allows runtime reconfiguration', async () => {
      const connector = new SimulatedConnector();

      // Initially succeeds
      const chains = await connector.getChains();
      expect(chains.length).toBeGreaterThan(0);

      // Inject error
      connector.configure({ errorToThrow: new Error('now failing') });
      await expect(connector.getChains()).rejects.toThrow('now failing');

      // Remove error
      connector.configure({ errorToThrow: undefined });
      const chains2 = await connector.getChains();
      expect(chains2.length).toBeGreaterThan(0);
    });
  });

  describe('simulated delay', () => {
    it('does not throw with delay configured', async () => {
      const connector = new SimulatedConnector({ delayMs: 1 });
      const chains = await connector.getChains();
      expect(chains.length).toBeGreaterThan(0);
    });
  });
});
