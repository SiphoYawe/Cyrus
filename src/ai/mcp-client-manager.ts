// MCP Client Manager — maps LI.FI tools for Claude tool_use with REST API fallback

import Anthropic from '@anthropic-ai/sdk';
import { createLogger } from '../utils/logger.js';
import { Store } from '../core/store.js';
import { chainId as toChainId, tokenAddress as toTokenAddress } from '../core/types.js';
import type { RankedOpportunity, EvaluationContext } from './types.js';
import type { LiFiConnectorInterface } from '../connectors/types.js';

const logger = createLogger('mcp-client');

const DEFAULT_MODEL = 'claude-sonnet-4-20250514';

// Tool definitions for Claude — maps LI.FI capabilities as tools
const LIFI_TOOLS: Anthropic.Tool[] = [
  {
    name: 'get_quote',
    description:
      'Get a quote for a cross-chain token transfer. Returns estimated gas costs, bridge fees, exchange rate, and route details.',
    input_schema: {
      type: 'object' as const,
      properties: {
        fromChain: {
          type: 'number',
          description: 'Source chain ID (e.g., 1 for Ethereum, 42161 for Arbitrum)',
        },
        toChain: { type: 'number', description: 'Destination chain ID' },
        fromToken: { type: 'string', description: 'Source token address' },
        toToken: { type: 'string', description: 'Destination token address' },
        fromAmount: { type: 'string', description: 'Amount in smallest units (wei)' },
      },
      required: ['fromChain', 'toChain', 'fromToken', 'toToken', 'fromAmount'],
    },
  },
  {
    name: 'get_chains',
    description:
      'List all supported blockchain chains with their chain IDs, names, and native tokens.',
    input_schema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'get_tokens',
    description: 'Get available tokens on a specific chain, including prices and metadata.',
    input_schema: {
      type: 'object' as const,
      properties: {
        chainId: { type: 'number', description: 'Chain ID to get tokens for' },
      },
      required: ['chainId'],
    },
  },
  {
    name: 'get_connections',
    description: 'Get possible routes/connections between two chains.',
    input_schema: {
      type: 'object' as const,
      properties: {
        fromChain: { type: 'number', description: 'Source chain ID' },
        toChain: { type: 'number', description: 'Destination chain ID' },
      },
      required: ['fromChain', 'toChain'],
    },
  },
];

export interface MCPClientManagerOptions {
  readonly apiKey?: string;
  readonly model?: string;
  readonly client?: Anthropic;
  readonly connector?: LiFiConnectorInterface;
}

export class MCPClientManager {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly connector: LiFiConnectorInterface | null;
  private readonly store: Store;
  private _connected = false;

  constructor(options: MCPClientManagerOptions = {}) {
    this.client = options.client ?? new Anthropic({ apiKey: options.apiKey });
    this.model = options.model ?? DEFAULT_MODEL;
    this.connector = options.connector ?? null;
    this.store = Store.getInstance();
  }

  async connect(): Promise<void> {
    if (!this.connector) {
      logger.warn('No LiFi connector provided, MCP tools will use fallback mode');
      this._connected = false;
      this.store.emitter.emit('mcp_fallback_activated' as keyof import('../core/store.js').StoreEventMap, {
        timestamp: Date.now(),
      });
      return;
    }
    try {
      // Verify connector works by fetching chains
      await this.connector.getChains();
      this._connected = true;
      logger.info('MCP client connected to LI.FI via connector');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn({ error: message }, 'MCP connection failed, falling back to REST API');
      this._connected = false;
      this.store.emitter.emit('mcp_fallback_activated' as keyof import('../core/store.js').StoreEventMap, {
        timestamp: Date.now(),
      });
    }
  }

  disconnect(): void {
    this._connected = false;
    logger.info('MCP client disconnected');
  }

  isConnected(): boolean {
    return this._connected;
  }

  getTools(): Anthropic.Tool[] {
    return [...LIFI_TOOLS];
  }

  async executeTool(name: string, input: Record<string, unknown>): Promise<unknown> {
    if (!this.connector) {
      throw new Error('No connector available for tool execution');
    }

    switch (name) {
      case 'get_quote': {
        const result = await this.connector.getQuote({
          fromChain: toChainId(input.fromChain as number),
          toChain: toChainId(input.toChain as number),
          fromToken: toTokenAddress(input.fromToken as string),
          toToken: toTokenAddress(input.toToken as string),
          fromAmount: String(input.fromAmount),
        });
        return {
          tool: result.tool,
          toAmount: result.estimate.toAmount,
          gasCosts: result.estimate.gasCosts,
          executionDuration: result.estimate.executionDuration,
        };
      }

      case 'get_chains': {
        const chains = await this.connector.getChains();
        return chains.map((c) => ({ id: c.id, name: c.name, nativeToken: c.nativeToken }));
      }

      case 'get_tokens': {
        const tokens = await this.connector.getTokens(input.chainId as number);
        return tokens.slice(0, 20).map((t) => ({
          address: t.address,
          symbol: t.symbol,
          decimals: t.decimals,
          priceUSD: t.priceUSD,
        }));
      }

      case 'get_connections': {
        const connections = await this.connector.getConnections(
          input.fromChain as number,
          input.toChain as number,
        );
        return connections;
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  async evaluateOpportunities(context: EvaluationContext): Promise<RankedOpportunity[]> {
    try {
      const systemPrompt = `You are analyzing cross-chain DeFi opportunities for the Cyrus autonomous agent. Current market regime: ${context.regime}. Active strategies: ${context.activeStrategies.join(', ') || 'none'}. Use the provided tools to research opportunities and return a ranked list.`;

      const userMessage = `Evaluate current cross-chain yield and arbitrage opportunities. Consider the ${context.regime} market regime. Portfolio balances (USD): ${JSON.stringify(context.balancesUsd)}. Find the top 3 opportunities with the best net APY after gas and bridge costs. Return your answer as a JSON array with objects containing: rank, protocol, chain, token, grossApy, netApy, gasCostUsd, bridgeFeeUsd, reasoning.`;

      // If connector available, use tool-augmented reasoning
      if (this._connected && this.connector) {
        return await this.evaluateWithTools(systemPrompt, userMessage);
      }

      // Fallback: pre-fetch data and pass as context
      return await this.evaluateWithPreFetchedData(systemPrompt, userMessage);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn({ error: message }, 'Opportunity evaluation failed');
      return [];
    }
  }

  private async evaluateWithTools(
    systemPrompt: string,
    userMessage: string,
  ): Promise<RankedOpportunity[]> {
    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: userMessage }];
    let continueLoop = true;
    let iterations = 0;
    const maxIterations = 5;

    while (continueLoop && iterations < maxIterations) {
      iterations++;
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 2048,
        system: systemPrompt,
        tools: LIFI_TOOLS,
        messages,
      });

      // Check for tool use
      const toolUse = response.content.find(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
      );

      if (toolUse) {
        // Execute the tool and feed result back
        try {
          const toolResult = await this.executeTool(
            toolUse.name,
            toolUse.input as Record<string, unknown>,
          );
          messages.push({ role: 'assistant', content: response.content });
          messages.push({
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: toolUse.id,
                content: JSON.stringify(toolResult),
              },
            ],
          });
        } catch (toolError) {
          const errMsg = toolError instanceof Error ? toolError.message : String(toolError);
          messages.push({ role: 'assistant', content: response.content });
          messages.push({
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: toolUse.id,
                content: `Error: ${errMsg}`,
                is_error: true,
              },
            ],
          });
        }
        continue;
      }

      // No tool use — extract final response
      continueLoop = false;
      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');

      return this.parseOpportunities(text);
    }

    return [];
  }

  private async evaluateWithPreFetchedData(
    systemPrompt: string,
    userMessage: string,
  ): Promise<RankedOpportunity[]> {
    // Fallback: no tools, just ask Claude to analyze based on regime
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 1024,
      system:
        systemPrompt +
        '\n\nNote: Live data tools are unavailable. Provide analysis based on general market knowledge and the current regime.',
      messages: [{ role: 'user', content: userMessage }],
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');

    return this.parseOpportunities(text);
  }

  private parseOpportunities(text: string): RankedOpportunity[] {
    // Try to parse JSON array from response
    try {
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as Array<Record<string, unknown>>;
        return parsed.map((item, index) => ({
          rank: (item.rank as number) ?? index + 1,
          protocol: String(item.protocol ?? 'unknown'),
          chain: Number(item.chain ?? item.chainId ?? 0),
          token: String(item.token ?? 'unknown'),
          grossApy: Number(item.grossApy ?? item.apy ?? 0),
          netApy: Number(item.netApy ?? item.grossApy ?? 0),
          gasCostUsd: Number(item.gasCostUsd ?? item.gasCost ?? 0),
          bridgeFeeUsd: Number(item.bridgeFeeUsd ?? item.bridgeFee ?? 0),
          reasoning: String(item.reasoning ?? item.reason ?? ''),
        }));
      }
    } catch {
      logger.debug('Failed to parse opportunities JSON from response');
    }
    return [];
  }
}
