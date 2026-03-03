import Anthropic from '@anthropic-ai/sdk';
import { createLogger } from '../utils/logger.js';
import type { CommandParseResult, NLExecutionPlan, NLExecutionStep, CommandIntent } from './types.js';
import { NL_COMMAND_SYSTEM_PROMPT, NL_COMMAND_TOOLS, CHAIN_NAME_MAP } from './prompts/nl-command.js';

const logger = createLogger('nl-command-processor');

const DEFAULT_MODEL = 'claude-sonnet-4-20250514';
const MAX_CONVERSATION_TURNS = 5;

export interface NLCommandProcessorOptions {
  readonly apiKey?: string;
  readonly model?: string;
  readonly client?: Anthropic;
}

export class NLCommandProcessor {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }> = [];

  constructor(options: NLCommandProcessorOptions = {}) {
    this.client = options.client ?? new Anthropic({ apiKey: options.apiKey });
    this.model = options.model ?? DEFAULT_MODEL;
  }

  async processCommand(command: string): Promise<CommandParseResult> {
    if (this.conversationHistory.length >= MAX_CONVERSATION_TURNS * 2) {
      this.conversationHistory.length = 0;
      return {
        type: 'rejection',
        reason: 'Too many clarification turns. Please provide a complete, explicit command.',
        supportedCommands: ['move', 'rebalance', 'allocate', 'stop', 'status'],
      };
    }

    try {
      this.conversationHistory.push({ role: 'user', content: command });

      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 1024,
        system: NL_COMMAND_SYSTEM_PROMPT,
        tools: NL_COMMAND_TOOLS,
        messages: this.conversationHistory.map(m => ({ role: m.role, content: m.content })),
      });

      // Handle tool_use response
      const toolUse = response.content.find(
        (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
      );

      if (!toolUse) {
        // If no tool use, treat as text response (shouldn't happen with forced tools)
        const text = response.content
          .filter((b): b is Anthropic.TextBlock => b.type === 'text')
          .map(b => b.text)
          .join('');
        this.conversationHistory.push({ role: 'assistant', content: text });
        return {
          type: 'clarification',
          question: text || 'Could you please rephrase your command?',
          options: ['move tokens', 'rebalance portfolio', 'check status'],
        };
      }

      const input = toolUse.input as Record<string, unknown>;

      switch (toolUse.name) {
        case 'create_plan': {
          const steps = (input.steps as Array<Record<string, unknown>>).map((s): NLExecutionStep => ({
            action: String(s.action),
            chainId: Number(s.chainId),
            token: String(s.token),
            amount: String(s.amount),
            protocol: s.protocol ? String(s.protocol) : undefined,
            details: String(s.details),
          }));

          const plan: NLExecutionPlan = {
            intent: String(input.intent) as CommandIntent,
            steps,
            summary: String(input.summary),
            estimatedCost: null, // Populated by ExecutionPreview (Story 4.5)
          };

          logger.info(
            { intent: plan.intent, stepCount: plan.steps.length, summary: plan.summary },
            'NL command parsed into execution plan',
          );

          this.conversationHistory.length = 0; // Reset on success
          return { type: 'plan', plan };
        }

        case 'request_clarification': {
          const question = String(input.question);
          const options = (input.options as string[]) || [];
          this.conversationHistory.push({ role: 'assistant', content: question });

          logger.info({ question, options }, 'Clarification requested for NL command');
          return { type: 'clarification', question, options };
        }

        case 'reject_command': {
          const reason = String(input.reason);
          const supported = (input.supported_commands as string[]) || ['move', 'rebalance', 'allocate', 'stop', 'status'];

          logger.info({ reason }, 'NL command rejected');
          this.conversationHistory.length = 0; // Reset on rejection
          return { type: 'rejection', reason, supportedCommands: supported };
        }

        default:
          return {
            type: 'rejection',
            reason: 'Unexpected response from AI',
            supportedCommands: ['move', 'rebalance', 'allocate', 'stop', 'status'],
          };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn({ error: message }, 'NL command processing failed');
      return {
        type: 'rejection',
        reason: `Command processing failed: ${message}`,
        supportedCommands: ['move', 'rebalance', 'allocate', 'stop', 'status'],
      };
    }
  }

  resolveChainName(name: string): number | null {
    return CHAIN_NAME_MAP[name.toLowerCase()] ?? null;
  }

  resetConversation(): void {
    this.conversationHistory.length = 0;
  }
}
