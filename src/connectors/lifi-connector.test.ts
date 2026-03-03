import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LiFiConnector } from './lifi-connector.js';
import { LiFiHttpClient } from './http-client.js';
import type { QuoteParams, RouteParams } from './types.js';
import { chainId, tokenAddress } from '../core/types.js';

// Create a mock HTTP client
function createMockHttpClient() {
  return {
    get: vi.fn(),
    post: vi.fn(),
  } as unknown as LiFiHttpClient;
}

describe('LiFiConnector', () => {
  let mockHttp: ReturnType<typeof createMockHttpClient>;
  let connector: LiFiConnector;

  beforeEach(() => {
    mockHttp = createMockHttpClient();
    connector = new LiFiConnector({ httpClient: mockHttp });
  });

  describe('getQuote', () => {
    it('calls GET /quote with correct parameters', async () => {
      const mockQuote = {
        transactionRequest: { to: '0x123', data: '0x', value: '0', gasLimit: '100000', chainId: 1 },
        estimate: {
          approvalAddress: '0x123',
          toAmount: '1000000',
          toAmountMin: '995000',
          executionDuration: 180,
          gasCosts: [],
        },
        tool: 'stargate',
        toolDetails: { key: 'stargate', name: 'Stargate', logoURI: '' },
        action: { fromChainId: 1, toChainId: 42161, fromToken: {}, toToken: {} },
      };

      (mockHttp.get as ReturnType<typeof vi.fn>).mockResolvedValue(mockQuote);

      const params: QuoteParams = {
        fromChain: chainId(1),
        toChain: chainId(42161),
        fromToken: tokenAddress('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'),
        toToken: tokenAddress('0xaf88d065e77c8cc2239327c5edb3a432268e5831'),
        fromAmount: '1000000',
        slippage: 0.005,
      };

      const result = await connector.getQuote(params);

      expect(mockHttp.get).toHaveBeenCalledWith('/quote', {
        fromChain: 1,
        toChain: 42161,
        fromToken: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        toToken: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
        fromAmount: '1000000',
        slippage: 0.005,
        integrator: 'cyrus-agent',
      });

      expect(result.tool).toBe('stargate');
      expect(result.estimate.toAmount).toBe('1000000');
    });

    it('uses DEFAULT_SLIPPAGE when slippage not provided', async () => {
      const mockQuote = {
        transactionRequest: { to: '0x123', data: '0x', value: '0', gasLimit: '100000', chainId: 1 },
        estimate: {
          approvalAddress: '0x123',
          toAmount: '1000000',
          toAmountMin: '995000',
          executionDuration: 180,
          gasCosts: [],
        },
        tool: 'stargate',
        toolDetails: { key: 'stargate', name: 'Stargate', logoURI: '' },
        action: { fromChainId: 1, toChainId: 42161, fromToken: {}, toToken: {} },
      };

      (mockHttp.get as ReturnType<typeof vi.fn>).mockResolvedValue(mockQuote);

      await connector.getQuote({
        fromChain: chainId(1),
        toChain: chainId(42161),
        fromToken: tokenAddress('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'),
        toToken: tokenAddress('0xaf88d065e77c8cc2239327c5edb3a432268e5831'),
        fromAmount: '1000000',
      });

      const callArgs = (mockHttp.get as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(callArgs[1].slippage).toBe(0.005);
    });
  });

  describe('getRoutes', () => {
    it('calls POST /advanced/routes with correct body', async () => {
      const mockRoutes = {
        routes: [
          {
            id: 'route-1',
            steps: [],
            toAmountMin: '995000',
            toAmount: '1000000',
            gasCostUSD: '5.00',
            tags: ['RECOMMENDED'],
          },
        ],
      };

      (mockHttp.post as ReturnType<typeof vi.fn>).mockResolvedValue(mockRoutes);

      const params: RouteParams = {
        fromChainId: 1,
        toChainId: 42161,
        fromTokenAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        toTokenAddress: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
        fromAmount: '1000000',
        slippage: 0.01,
        order: 'CHEAPEST',
      };

      const routes = await connector.getRoutes(params);

      expect(mockHttp.post).toHaveBeenCalledWith('/advanced/routes', {
        fromChainId: 1,
        toChainId: 42161,
        fromTokenAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        toTokenAddress: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
        fromAmount: '1000000',
        options: {
          slippage: 0.01,
          order: 'CHEAPEST',
          integrator: 'cyrus-agent',
        },
      });

      expect(routes).toHaveLength(1);
      expect(routes[0].id).toBe('route-1');
    });

    it('defaults order to RECOMMENDED', async () => {
      (mockHttp.post as ReturnType<typeof vi.fn>).mockResolvedValue({ routes: [] });

      await connector.getRoutes({
        fromChainId: 1,
        toChainId: 42161,
        fromTokenAddress: '0xabc',
        toTokenAddress: '0xdef',
        fromAmount: '1000000',
      });

      const callArgs = (mockHttp.post as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(callArgs[1].options.order).toBe('RECOMMENDED');
    });
  });

  describe('getChains', () => {
    it('fetches chains from API on first call', async () => {
      const mockChains = {
        chains: [
          { id: 1, key: 'eth', name: 'Ethereum', nativeToken: { symbol: 'ETH', decimals: 18, address: '0x0' } },
        ],
      };

      (mockHttp.get as ReturnType<typeof vi.fn>).mockResolvedValue(mockChains);

      const chains = await connector.getChains();

      expect(mockHttp.get).toHaveBeenCalledWith('/chains');
      expect(chains).toHaveLength(1);
      expect(chains[0].id).toBe(1);
    });

    it('returns cached chains on subsequent calls', async () => {
      const mockChains = {
        chains: [
          { id: 1, key: 'eth', name: 'Ethereum', nativeToken: { symbol: 'ETH', decimals: 18, address: '0x0' } },
        ],
      };

      (mockHttp.get as ReturnType<typeof vi.fn>).mockResolvedValue(mockChains);

      await connector.getChains();
      await connector.getChains();
      await connector.getChains();

      expect(mockHttp.get).toHaveBeenCalledTimes(1);
    });
  });

  describe('getTokens', () => {
    it('fetches tokens and flattens the result', async () => {
      const mockTokens = {
        tokens: {
          '1': [
            { address: '0xusdc', symbol: 'USDC', decimals: 6, chainId: 1, name: 'USD Coin' },
          ],
          '42161': [
            { address: '0xusdc_arb', symbol: 'USDC', decimals: 6, chainId: 42161, name: 'USD Coin' },
          ],
        },
      };

      (mockHttp.get as ReturnType<typeof vi.fn>).mockResolvedValue(mockTokens);

      const tokens = await connector.getTokens();

      expect(tokens).toHaveLength(2);
      expect(tokens[0].symbol).toBe('USDC');
    });

    it('passes chainId filter to API', async () => {
      (mockHttp.get as ReturnType<typeof vi.fn>).mockResolvedValue({ tokens: {} });

      await connector.getTokens(1);

      expect(mockHttp.get).toHaveBeenCalledWith('/tokens', { chains: 1 });
    });

    it('caches tokens by chainId', async () => {
      (mockHttp.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        tokens: { '1': [{ address: '0x1', symbol: 'X', decimals: 18, chainId: 1, name: 'X' }] },
      });

      await connector.getTokens(1);
      await connector.getTokens(1);

      expect(mockHttp.get).toHaveBeenCalledTimes(1);
    });

    it('fetches separately for different chainIds', async () => {
      (mockHttp.get as ReturnType<typeof vi.fn>).mockResolvedValue({ tokens: {} });

      await connector.getTokens(1);
      await connector.getTokens(42161);

      expect(mockHttp.get).toHaveBeenCalledTimes(2);
    });
  });

  describe('getStatus', () => {
    it('calls GET /status with correct parameters', async () => {
      const mockStatus = {
        status: 'DONE',
        substatus: 'COMPLETED',
        tool: 'stargate',
      };

      (mockHttp.get as ReturnType<typeof vi.fn>).mockResolvedValue(mockStatus);

      const status = await connector.getStatus('0xhash', 'stargate', 1, 42161);

      expect(mockHttp.get).toHaveBeenCalledWith('/status', {
        txHash: '0xhash',
        bridge: 'stargate',
        fromChain: 1,
        toChain: 42161,
      });

      expect(status.status).toBe('DONE');
      expect(status.substatus).toBe('COMPLETED');
    });
  });

  describe('getConnections', () => {
    it('fetches connections from API', async () => {
      const mockConnections = {
        connections: [
          { fromChainId: 1, toChainId: 42161, fromTokens: [], toTokens: [] },
        ],
      };

      (mockHttp.get as ReturnType<typeof vi.fn>).mockResolvedValue(mockConnections);

      const connections = await connector.getConnections(1, 42161);

      expect(mockHttp.get).toHaveBeenCalledWith('/connections', {
        fromChain: 1,
        toChain: 42161,
      });
      expect(connections).toHaveLength(1);
    });

    it('caches connections', async () => {
      (mockHttp.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        connections: [],
      });

      await connector.getConnections(1, 42161);
      await connector.getConnections(1, 42161);

      expect(mockHttp.get).toHaveBeenCalledTimes(1);
    });

    it('caches connections per chain pair', async () => {
      (mockHttp.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        connections: [],
      });

      await connector.getConnections(1, 42161);
      await connector.getConnections(1, 10);

      expect(mockHttp.get).toHaveBeenCalledTimes(2);
    });
  });

  describe('getTools', () => {
    it('fetches and merges bridges and exchanges', async () => {
      const mockTools = {
        bridges: [{ key: 'stargate', name: 'Stargate', type: 'bridge' }],
        exchanges: [{ key: 'uniswap', name: 'Uniswap', type: 'exchange' }],
      };

      (mockHttp.get as ReturnType<typeof vi.fn>).mockResolvedValue(mockTools);

      const tools = await connector.getTools();

      expect(tools).toHaveLength(2);
      expect(tools[0].key).toBe('stargate');
      expect(tools[1].key).toBe('uniswap');
    });

    it('caches tools', async () => {
      (mockHttp.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        bridges: [],
        exchanges: [],
      });

      await connector.getTools();
      await connector.getTools();

      expect(mockHttp.get).toHaveBeenCalledTimes(1);
    });
  });

  describe('clearCaches', () => {
    it('clears all caches forcing re-fetch', async () => {
      (mockHttp.get as ReturnType<typeof vi.fn>).mockResolvedValue({ chains: [] });

      await connector.getChains();
      connector.clearCaches();
      await connector.getChains();

      expect(mockHttp.get).toHaveBeenCalledTimes(2);
    });
  });
});
