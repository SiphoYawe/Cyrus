import Anthropic from '@anthropic-ai/sdk';
import { createLogger } from '../utils/logger.js';
import { Store } from '../core/store.js';
import type { MarketRegime, RegimeClassification } from './types.js';
import type { MCPClientManager } from './mcp-client-manager.js';
import {
  REGIME_CLASSIFICATION_SYSTEM_PROMPT,
  formatMarketDataForPrompt,
} from './prompts/regime-classification.js';
import type { MarketDataSnapshot } from './prompts/regime-classification.js';

const logger = createLogger('ai-orchestrator');

const VALID_REGIMES: readonly MarketRegime[] = ['bull', 'bear', 'crab', 'volatile'];
const DEFAULT_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const DEFAULT_MODEL = 'claude-sonnet-4-20250514';
const MAX_TOOL_ITERATIONS = 5;

export interface AIOrchestatorOptions {
  readonly apiKey?: string;
  readonly model?: string;
  readonly cacheTtlMs?: number;
  readonly client?: Anthropic;
}

export class AIOrchestrator {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly cacheTtlMs: number;
  private readonly store: Store;
  private cachedClassification: RegimeClassification | null = null;
  private cachedAt = 0;
  private _mcpClientManager: MCPClientManager | null = null;

  constructor(options: AIOrchestatorOptions = {}) {
    this.client = options.client ?? new Anthropic({ apiKey: options.apiKey });
    this.model = options.model ?? DEFAULT_MODEL;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.store = Store.getInstance();
  }

  setMCPClientManager(manager: MCPClientManager): void {
    this._mcpClientManager = manager;
    logger.info(
      { connected: manager.isConnected() },
      'MCP client manager attached to AI orchestrator',
    );
  }

  getMCPClientManager(): MCPClientManager | null {
    return this._mcpClientManager;
  }

  async classifyMarketRegime(snapshot: MarketDataSnapshot): Promise<RegimeClassification> {
    // Check cache first
    if (this.cachedClassification && (Date.now() - this.cachedAt) < this.cacheTtlMs) {
      logger.debug({ regime: this.cachedClassification.regime }, 'Returning cached regime classification');
      return this.cachedClassification;
    }

    try {
      const userMessage = formatMarketDataForPrompt(snapshot);

      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 256,
        system: REGIME_CLASSIFICATION_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMessage }],
      });

      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('');

      const parsed = this.parseClassificationResponse(text);

      // Store in state
      const previousRegime = this.store.getLatestRegime();
      this.store.setRegimeClassification(parsed);

      // Emit regime_changed if different
      if (previousRegime && previousRegime.regime !== parsed.regime) {
        this.store.emitter.emit('regime_changed', parsed);
        logger.info(
          { previous: previousRegime.regime, current: parsed.regime, confidence: parsed.confidence },
          'Market regime changed',
        );
      }

      // Cache
      this.cachedClassification = parsed;
      this.cachedAt = Date.now();

      logger.info(
        { regime: parsed.regime, confidence: parsed.confidence, reasoning: parsed.reasoning },
        'Market regime classified',
      );

      return parsed;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn({ error: message }, 'Regime detection failed, using fallback');

      this.store.emitter.emit('regime_detection_failed', { error: message, timestamp: Date.now() });

      // Fallback: use last known or default to crab
      const lastKnown = this.store.getLatestRegime();
      if (lastKnown) {
        logger.info({ regime: lastKnown.regime }, 'Using last known regime classification');
        return lastKnown;
      }

      const fallback: RegimeClassification = {
        regime: 'crab',
        confidence: 0,
        reasoning: 'AI classification failed, defaulting to conservative crab regime',
        timestamp: Date.now(),
      };

      this.store.setRegimeClassification(fallback);
      return fallback;
    }
  }

  private parseClassificationResponse(text: string): RegimeClassification {
    // Extract JSON from response — handle markdown code blocks
    const jsonMatch = text.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) {
      throw new Error('No JSON object found in classification response');
    }

    const parsed = JSON.parse(jsonMatch[0]) as {
      regime?: string;
      confidence?: number;
      reasoning?: string;
    };

    if (!parsed.regime || !VALID_REGIMES.includes(parsed.regime as MarketRegime)) {
      throw new Error(`Invalid regime: ${parsed.regime}. Expected one of: ${VALID_REGIMES.join(', ')}`);
    }

    const confidence = typeof parsed.confidence === 'number'
      ? Math.max(0, Math.min(1, parsed.confidence))
      : 0.5;

    return {
      regime: parsed.regime as MarketRegime,
      confidence,
      reasoning: parsed.reasoning ?? 'No reasoning provided',
      timestamp: Date.now(),
    };
  }

  clearCache(): void {
    this.cachedClassification = null;
    this.cachedAt = 0;
  }

  /**
   * General-purpose tool-augmented Claude analysis.
   * Includes MCP tools if available, handles multi-turn tool_use loop.
   * Returns the final text response.
   */
  async analyzeWithTools(systemPrompt: string, userMessage: string): Promise<string> {
    const tools =
      this._mcpClientManager?.isConnected() ? this._mcpClientManager.getTools() : undefined;

    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: userMessage }];

    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      const requestParams: Anthropic.MessageCreateParams = {
        model: this.model,
        max_tokens: 2048,
        system: systemPrompt,
        messages,
        ...(tools && tools.length > 0 ? { tools } : {}),
      };

      const response = await this.client.messages.create(requestParams);

      // Check for tool_use blocks in the response
      const toolUseBlock = response.content.find(
        (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
      );

      if (!toolUseBlock || !this._mcpClientManager) {
        // No tool use or no MCP manager — extract text and return
        return response.content
          .filter((block): block is Anthropic.TextBlock => block.type === 'text')
          .map((block) => block.text)
          .join('');
      }

      // Execute the tool
      messages.push({ role: 'assistant', content: response.content });
      try {
        const toolResult = await this._mcpClientManager.executeTool(
          toolUseBlock.name,
          toolUseBlock.input as Record<string, unknown>,
        );
        messages.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: toolUseBlock.id,
              content: JSON.stringify(toolResult),
            },
          ],
        });
      } catch (toolError) {
        const errMsg = toolError instanceof Error ? toolError.message : String(toolError);
        logger.warn({ tool: toolUseBlock.name, error: errMsg }, 'Tool execution failed');
        messages.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: toolUseBlock.id,
              content: `Error: ${errMsg}`,
              is_error: true,
            },
          ],
        });
      }
    }

    // Exhausted iterations — make one final call without tools to get a text response
    logger.warn('analyzeWithTools hit max iterations, returning last text');
    return '';
  }
}
