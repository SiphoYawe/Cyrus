import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AIOrchestrator } from '../ai-orchestrator.js';
import { MCPClientManager } from '../mcp-client-manager.js';
import { Store } from '../../core/store.js';
import type { MarketDataSnapshot } from '../prompts/regime-classification.js';
import type { RegimeClassification } from '../types.js';
import type { LiFiConnectorInterface } from '../../connectors/types.js';

// Mock Anthropic client
function createMockClient(response: string) {
  return {
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: response }],
      }),
    },
  } as unknown as import('@anthropic-ai/sdk').default;
}

function createMockConnector(overrides: Partial<LiFiConnectorInterface> = {}): LiFiConnectorInterface {
  return {
    getQuote: vi.fn().mockResolvedValue({
      tool: 'stargate',
      action: { fromChainId: 1, toChainId: 42161, fromToken: {}, toToken: {} },
      estimate: {
        approvalAddress: '0xapproval',
        toAmount: '990000',
        toAmountMin: '985000',
        gasCosts: [{ amount: '100000', amountUSD: '0.50', token: { symbol: 'ETH' } }],
        executionDuration: 60,
      },
      transactionRequest: { to: '0x', data: '0x', value: '0', gasLimit: '200000', chainId: 1 },
      toolDetails: { key: 'stargate', name: 'Stargate', logoURI: '' },
    }),
    getChains: vi.fn().mockResolvedValue([
      { id: 1, key: 'eth', name: 'Ethereum', nativeToken: { symbol: 'ETH', decimals: 18, address: '0x0' } },
    ]),
    getTokens: vi.fn().mockResolvedValue([
      { address: '0xusdc', symbol: 'USDC', decimals: 6, chainId: 1, name: 'USD Coin', priceUSD: '1.00' },
    ]),
    getConnections: vi.fn().mockResolvedValue([
      { fromChainId: 1, toChainId: 42161, fromTokens: [], toTokens: [] },
    ]),
    getRoutes: vi.fn().mockResolvedValue([]),
    getStatus: vi.fn().mockResolvedValue({ status: 'DONE' }),
    getTools: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as LiFiConnectorInterface;
}

function createSnapshot(overrides: Partial<MarketDataSnapshot> = {}): MarketDataSnapshot {
  return {
    topTokenChanges: [
      { symbol: 'BTC', priceChange24h: 2.5 },
      { symbol: 'ETH', priceChange24h: 3.1 },
      { symbol: 'SOL', priceChange24h: 1.8 },
    ],
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('AIOrchestrator', () => {
  let store: Store;

  beforeEach(() => {
    Store.getInstance().reset();
    store = Store.getInstance();
  });

  describe('classifyMarketRegime', () => {
    it('returns valid classification for bull regime', async () => {
      const mockClient = createMockClient(
        '{"regime":"bull","confidence":0.85,"reasoning":"Strong positive momentum across major tokens."}',
      );
      const orchestrator = new AIOrchestrator({ client: mockClient });
      const snapshot = createSnapshot();

      const result = await orchestrator.classifyMarketRegime(snapshot);

      expect(result.regime).toBe('bull');
      expect(result.confidence).toBe(0.85);
      expect(result.reasoning).toBe('Strong positive momentum across major tokens.');
      expect(result.timestamp).toBeGreaterThan(0);
    });

    it('returns valid classification for bear regime', async () => {
      const mockClient = createMockClient(
        '{"regime":"bear","confidence":0.90,"reasoning":"Broad decline across all tokens."}',
      );
      const orchestrator = new AIOrchestrator({ client: mockClient });

      const result = await orchestrator.classifyMarketRegime(createSnapshot());

      expect(result.regime).toBe('bear');
      expect(result.confidence).toBe(0.90);
    });

    it('returns valid classification for crab regime', async () => {
      const mockClient = createMockClient(
        '{"regime":"crab","confidence":0.80,"reasoning":"Minimal price movement."}',
      );
      const orchestrator = new AIOrchestrator({ client: mockClient });

      const result = await orchestrator.classifyMarketRegime(createSnapshot());

      expect(result.regime).toBe('crab');
    });

    it('returns valid classification for volatile regime', async () => {
      const mockClient = createMockClient(
        '{"regime":"volatile","confidence":0.88,"reasoning":"Large swings both directions."}',
      );
      const orchestrator = new AIOrchestrator({ client: mockClient });

      const result = await orchestrator.classifyMarketRegime(createSnapshot());

      expect(result.regime).toBe('volatile');
    });

    it('stores classification in state store', async () => {
      const mockClient = createMockClient(
        '{"regime":"bull","confidence":0.85,"reasoning":"Positive momentum."}',
      );
      const orchestrator = new AIOrchestrator({ client: mockClient });

      await orchestrator.classifyMarketRegime(createSnapshot());

      const stored = store.getLatestRegime();
      expect(stored).not.toBeNull();
      expect(stored!.regime).toBe('bull');
      expect(stored!.confidence).toBe(0.85);
    });

    it('emits regime_changed event when regime differs from previous', async () => {
      // Set initial regime
      store.setRegimeClassification({
        regime: 'bull',
        confidence: 0.85,
        reasoning: 'Initial',
        timestamp: Date.now() - 60_000,
      });

      const listener = vi.fn();
      store.emitter.on('regime_changed', listener);

      const mockClient = createMockClient(
        '{"regime":"bear","confidence":0.90,"reasoning":"Market shifted."}',
      );
      const orchestrator = new AIOrchestrator({ client: mockClient });

      await orchestrator.classifyMarketRegime(createSnapshot());

      expect(listener).toHaveBeenCalledTimes(1);
      const emitted = listener.mock.calls[0][0] as RegimeClassification;
      expect(emitted.regime).toBe('bear');
    });

    it('does not emit regime_changed when regime is the same', async () => {
      store.setRegimeClassification({
        regime: 'bull',
        confidence: 0.85,
        reasoning: 'Initial',
        timestamp: Date.now() - 60_000,
      });

      const listener = vi.fn();
      store.emitter.on('regime_changed', listener);

      const mockClient = createMockClient(
        '{"regime":"bull","confidence":0.90,"reasoning":"Still bullish."}',
      );
      const orchestrator = new AIOrchestrator({ client: mockClient });

      await orchestrator.classifyMarketRegime(createSnapshot());

      expect(listener).not.toHaveBeenCalled();
    });

    it('returns cached result within TTL', async () => {
      const mockClient = createMockClient(
        '{"regime":"bull","confidence":0.85,"reasoning":"Positive momentum."}',
      );
      const orchestrator = new AIOrchestrator({ client: mockClient, cacheTtlMs: 60_000 });

      const first = await orchestrator.classifyMarketRegime(createSnapshot());
      const second = await orchestrator.classifyMarketRegime(createSnapshot());

      expect(first).toBe(second);
      expect(mockClient.messages.create).toHaveBeenCalledTimes(1);
    });

    it('makes fresh call after TTL expires', async () => {
      const mockClient = createMockClient(
        '{"regime":"bull","confidence":0.85,"reasoning":"Positive momentum."}',
      );
      // TTL of 0 = always fresh
      const orchestrator = new AIOrchestrator({ client: mockClient, cacheTtlMs: 0 });

      await orchestrator.classifyMarketRegime(createSnapshot());
      await orchestrator.classifyMarketRegime(createSnapshot());

      expect(mockClient.messages.create).toHaveBeenCalledTimes(2);
    });
  });

  describe('graceful degradation', () => {
    it('returns last known regime on API failure', async () => {
      store.setRegimeClassification({
        regime: 'bull',
        confidence: 0.85,
        reasoning: 'Previous classification',
        timestamp: Date.now() - 60_000,
      });

      const mockClient = {
        messages: {
          create: vi.fn().mockRejectedValue(new Error('API unreachable')),
        },
      } as unknown as import('@anthropic-ai/sdk').default;

      const orchestrator = new AIOrchestrator({ client: mockClient });

      const result = await orchestrator.classifyMarketRegime(createSnapshot());

      expect(result.regime).toBe('bull');
      expect(result.reasoning).toBe('Previous classification');
    });

    it('defaults to crab when no prior classification exists', async () => {
      const mockClient = {
        messages: {
          create: vi.fn().mockRejectedValue(new Error('API unreachable')),
        },
      } as unknown as import('@anthropic-ai/sdk').default;

      const orchestrator = new AIOrchestrator({ client: mockClient });

      const result = await orchestrator.classifyMarketRegime(createSnapshot());

      expect(result.regime).toBe('crab');
      expect(result.confidence).toBe(0);
      expect(result.reasoning).toContain('failed');
    });

    it('emits regime_detection_failed event on API failure', async () => {
      const listener = vi.fn();
      store.emitter.on('regime_detection_failed', listener);

      const mockClient = {
        messages: {
          create: vi.fn().mockRejectedValue(new Error('Network error')),
        },
      } as unknown as import('@anthropic-ai/sdk').default;

      const orchestrator = new AIOrchestrator({ client: mockClient });

      await orchestrator.classifyMarketRegime(createSnapshot());

      expect(listener).toHaveBeenCalledTimes(1);
      const emitted = listener.mock.calls[0][0] as { error: string; timestamp: number };
      expect(emitted.error).toBe('Network error');
    });

    it('never throws from classifyMarketRegime', async () => {
      const mockClient = {
        messages: {
          create: vi.fn().mockRejectedValue(new Error('Fatal error')),
        },
      } as unknown as import('@anthropic-ai/sdk').default;

      const orchestrator = new AIOrchestrator({ client: mockClient });

      // Should NOT throw
      const result = await orchestrator.classifyMarketRegime(createSnapshot());
      expect(result).toBeDefined();
      expect(result.regime).toBeDefined();
    });
  });

  describe('regime store', () => {
    it('caps history at 100 entries', () => {
      for (let i = 0; i < 110; i++) {
        store.setRegimeClassification({
          regime: 'bull',
          confidence: 0.8,
          reasoning: `Entry ${i}`,
          timestamp: Date.now() + i,
        });
      }

      const history = store.getRegimeHistory();
      expect(history.length).toBe(100);
    });

    it('getRegimeHistory returns limited entries', () => {
      for (let i = 0; i < 10; i++) {
        store.setRegimeClassification({
          regime: 'bull',
          confidence: 0.8,
          reasoning: `Entry ${i}`,
          timestamp: Date.now() + i,
        });
      }

      const limited = store.getRegimeHistory(3);
      expect(limited.length).toBe(3);
    });

    it('getLatestRegime returns null when empty', () => {
      expect(store.getLatestRegime()).toBeNull();
    });
  });

  describe('MCP integration', () => {
    it('setMCPClientManager attaches manager', async () => {
      const mockClient = createMockClient('{}');
      const orchestrator = new AIOrchestrator({ client: mockClient });

      const connector = createMockConnector();
      const mcp = new MCPClientManager({ client: mockClient, connector });
      await mcp.connect();

      orchestrator.setMCPClientManager(mcp);

      expect(orchestrator.getMCPClientManager()).toBe(mcp);
    });

    it('getMCPClientManager returns null when not set', () => {
      const mockClient = createMockClient('{}');
      const orchestrator = new AIOrchestrator({ client: mockClient });

      expect(orchestrator.getMCPClientManager()).toBeNull();
    });

    it('classifyMarketRegime does NOT include tools (stays fast)', async () => {
      const mockClient = createMockClient(
        '{"regime":"bull","confidence":0.85,"reasoning":"Strong."}',
      );
      const orchestrator = new AIOrchestrator({ client: mockClient });

      const connector = createMockConnector();
      const mcp = new MCPClientManager({ client: mockClient, connector });
      await mcp.connect();
      orchestrator.setMCPClientManager(mcp);

      await orchestrator.classifyMarketRegime(createSnapshot());

      const callArgs = (mockClient.messages.create as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
      expect(callArgs).not.toHaveProperty('tools');
    });
  });

  describe('analyzeWithTools', () => {
    it('returns text response without tools when MCP not connected', async () => {
      const mockClient = createMockClient('Analysis complete.');
      const orchestrator = new AIOrchestrator({ client: mockClient });

      const result = await orchestrator.analyzeWithTools('System prompt', 'User message');

      expect(result).toBe('Analysis complete.');
      expect(mockClient.messages.create).toHaveBeenCalledTimes(1);

      // Verify no tools passed
      const callArgs = (mockClient.messages.create as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
      expect(callArgs).not.toHaveProperty('tools');
    });

    it('includes tools when MCP is connected', async () => {
      const mockClient = createMockClient('Analysis with tools.');
      const orchestrator = new AIOrchestrator({ client: mockClient });

      const connector = createMockConnector();
      const mcp = new MCPClientManager({ client: mockClient, connector });
      await mcp.connect();
      orchestrator.setMCPClientManager(mcp);

      await orchestrator.analyzeWithTools('System prompt', 'User message');

      const callArgs = (mockClient.messages.create as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
      expect(callArgs).toHaveProperty('tools');
      const tools = callArgs.tools as Array<{ name: string }>;
      expect(tools.length).toBe(4);
      expect(tools.map((t) => t.name)).toContain('get_chains');
    });

    it('handles tool_use response and makes follow-up call', async () => {
      let callCount = 0;
      const mockClient = {
        messages: {
          create: vi.fn().mockImplementation(() => {
            callCount++;
            if (callCount === 1) {
              return Promise.resolve({
                content: [
                  {
                    type: 'tool_use',
                    id: 'tool_call_1',
                    name: 'get_chains',
                    input: {},
                  },
                ],
              });
            }
            return Promise.resolve({
              content: [{ type: 'text', text: 'Chains: Ethereum, Arbitrum' }],
            });
          }),
        },
      } as unknown as import('@anthropic-ai/sdk').default;

      const orchestrator = new AIOrchestrator({ client: mockClient });
      const connector = createMockConnector();
      const mcp = new MCPClientManager({ client: mockClient, connector });
      await mcp.connect();
      orchestrator.setMCPClientManager(mcp);

      const result = await orchestrator.analyzeWithTools('System', 'Tell me about chains');

      expect(result).toBe('Chains: Ethereum, Arbitrum');
      expect(mockClient.messages.create).toHaveBeenCalledTimes(2);
      expect(connector.getChains).toHaveBeenCalledTimes(2); // once for connect, once for tool
    });

    it('sends is_error tool_result on tool execution failure', async () => {
      let callCount = 0;
      const mockClient = {
        messages: {
          create: vi.fn().mockImplementation(() => {
            callCount++;
            if (callCount === 1) {
              return Promise.resolve({
                content: [
                  {
                    type: 'tool_use',
                    id: 'tool_fail',
                    name: 'get_tokens',
                    input: { chainId: 999 },
                  },
                ],
              });
            }
            return Promise.resolve({
              content: [{ type: 'text', text: 'Sorry, could not fetch tokens.' }],
            });
          }),
        },
      } as unknown as import('@anthropic-ai/sdk').default;

      const connector = createMockConnector({
        getTokens: vi.fn().mockRejectedValue(new Error('Chain not found')),
      });
      const orchestrator = new AIOrchestrator({ client: mockClient });
      const mcp = new MCPClientManager({ client: mockClient, connector });
      await mcp.connect();
      orchestrator.setMCPClientManager(mcp);

      const result = await orchestrator.analyzeWithTools('System', 'Get tokens');

      expect(result).toBe('Sorry, could not fetch tokens.');

      // Check second call contains is_error tool_result
      const secondCallArgs = (mockClient.messages.create as ReturnType<typeof vi.fn>).mock.calls[1][0] as {
        messages: Array<{ role: string; content: unknown }>;
      };
      const lastMessage = secondCallArgs.messages[secondCallArgs.messages.length - 1];
      expect(lastMessage.role).toBe('user');
      const toolResult = (lastMessage.content as Array<{ type: string; is_error?: boolean }>)[0];
      expect(toolResult.type).toBe('tool_result');
      expect(toolResult.is_error).toBe(true);
    });

    it('terminates after max 5 tool iterations', async () => {
      // Always return tool_use
      const mockClient = {
        messages: {
          create: vi.fn().mockResolvedValue({
            content: [
              {
                type: 'tool_use',
                id: 'infinite_loop',
                name: 'get_chains',
                input: {},
              },
            ],
          }),
        },
      } as unknown as import('@anthropic-ai/sdk').default;

      const orchestrator = new AIOrchestrator({ client: mockClient });
      const connector = createMockConnector();
      const mcp = new MCPClientManager({ client: mockClient, connector });
      await mcp.connect();
      orchestrator.setMCPClientManager(mcp);

      const result = await orchestrator.analyzeWithTools('System', 'Loop forever');

      expect(result).toBe('');
      expect(mockClient.messages.create).toHaveBeenCalledTimes(5);
    });

    it('works with multi-turn tool calls (3 sequential tool calls)', async () => {
      let callCount = 0;
      const mockClient = {
        messages: {
          create: vi.fn().mockImplementation(() => {
            callCount++;
            if (callCount <= 3) {
              return Promise.resolve({
                content: [
                  {
                    type: 'tool_use',
                    id: `tool_call_${callCount}`,
                    name: 'get_chains',
                    input: {},
                  },
                ],
              });
            }
            return Promise.resolve({
              content: [{ type: 'text', text: 'Done after 3 tool calls.' }],
            });
          }),
        },
      } as unknown as import('@anthropic-ai/sdk').default;

      const orchestrator = new AIOrchestrator({ client: mockClient });
      const connector = createMockConnector();
      const mcp = new MCPClientManager({ client: mockClient, connector });
      await mcp.connect();
      orchestrator.setMCPClientManager(mcp);

      const result = await orchestrator.analyzeWithTools('System', 'Multi-turn');

      expect(result).toBe('Done after 3 tool calls.');
      expect(mockClient.messages.create).toHaveBeenCalledTimes(4); // 3 tool + 1 final
    });

    it('gracefully degrades when MCP is set but not connected', async () => {
      const mockClient = createMockClient('Fallback response.');
      const orchestrator = new AIOrchestrator({ client: mockClient });

      // MCP without connector → not connected
      const mcp = new MCPClientManager({ client: mockClient });
      await mcp.connect();
      expect(mcp.isConnected()).toBe(false);
      orchestrator.setMCPClientManager(mcp);

      const result = await orchestrator.analyzeWithTools('System', 'Test');

      expect(result).toBe('Fallback response.');
      const callArgs = (mockClient.messages.create as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
      expect(callArgs).not.toHaveProperty('tools');
    });
  });
});
