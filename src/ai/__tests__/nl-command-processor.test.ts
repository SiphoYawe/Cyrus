import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NLCommandProcessor } from '../nl-command-processor.js';
import { Store } from '../../core/store.js';
import type { CommandParseResult } from '../types.js';

// Mock Anthropic client that returns tool_use responses
function createMockClient(toolName: string, toolInput: Record<string, unknown>) {
  return {
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{
          type: 'tool_use',
          id: 'test-id',
          name: toolName,
          input: toolInput,
        }],
      }),
    },
  } as unknown as import('@anthropic-ai/sdk').default;
}

// Mock Anthropic client that returns text-only (no tool_use)
function createTextOnlyMockClient(text: string) {
  return {
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text }],
      }),
    },
  } as unknown as import('@anthropic-ai/sdk').default;
}

// Mock Anthropic client that rejects with error
function createErrorMockClient(errorMessage: string) {
  return {
    messages: {
      create: vi.fn().mockRejectedValue(new Error(errorMessage)),
    },
  } as unknown as import('@anthropic-ai/sdk').default;
}

describe('NLCommandProcessor', () => {
  beforeEach(() => {
    Store.getInstance().reset();
  });

  describe('processCommand — plan creation', () => {
    it('parses "Move 20% to Aave on Optimism" into a valid plan with intent move', async () => {
      const mockClient = createMockClient('create_plan', {
        intent: 'move',
        steps: [
          {
            action: 'bridge_and_deposit',
            chainId: 10,
            token: 'USDC',
            amount: '20%',
            protocol: 'Aave',
            details: 'Move 20% of portfolio to Aave lending pool on Optimism',
          },
        ],
        summary: 'Move 20% of portfolio value to Aave on Optimism',
      });

      const processor = new NLCommandProcessor({ client: mockClient });
      const result = await processor.processCommand('Move 20% to Aave on Optimism');

      expect(result.type).toBe('plan');
      if (result.type !== 'plan') throw new Error('Expected plan');

      expect(result.plan.intent).toBe('move');
      expect(result.plan.steps).toHaveLength(1);
      expect(result.plan.steps[0].action).toBe('bridge_and_deposit');
      expect(result.plan.steps[0].chainId).toBe(10);
      expect(result.plan.steps[0].token).toBe('USDC');
      expect(result.plan.steps[0].amount).toBe('20%');
      expect(result.plan.steps[0].protocol).toBe('Aave');
      expect(result.plan.steps[0].details).toContain('Aave');
      expect(result.plan.summary).toContain('Aave');
      expect(result.plan.estimatedCost).toBeNull();
    });

    it('parses rebalance command with multiple steps', async () => {
      const mockClient = createMockClient('create_plan', {
        intent: 'rebalance',
        steps: [
          {
            action: 'bridge',
            chainId: 42161,
            token: 'ETH',
            amount: '33%',
            details: 'Bridge ETH to Arbitrum for equal distribution',
          },
          {
            action: 'bridge',
            chainId: 8453,
            token: 'ETH',
            amount: '33%',
            details: 'Bridge ETH to Base for equal distribution',
          },
        ],
        summary: 'Rebalance portfolio equally across Arbitrum and Base',
      });

      const processor = new NLCommandProcessor({ client: mockClient });
      const result = await processor.processCommand('Rebalance equally across all chains');

      expect(result.type).toBe('plan');
      if (result.type !== 'plan') throw new Error('Expected plan');

      expect(result.plan.intent).toBe('rebalance');
      expect(result.plan.steps).toHaveLength(2);
      expect(result.plan.steps[0].chainId).toBe(42161);
      expect(result.plan.steps[1].chainId).toBe(8453);
    });

    it('sets estimatedCost to null on returned plan', async () => {
      const mockClient = createMockClient('create_plan', {
        intent: 'status',
        steps: [
          {
            action: 'query',
            chainId: 1,
            token: 'ALL',
            amount: '0',
            details: 'Check portfolio status across all chains',
          },
        ],
        summary: 'Check current portfolio status',
      });

      const processor = new NLCommandProcessor({ client: mockClient });
      const result = await processor.processCommand('What is my portfolio status?');

      expect(result.type).toBe('plan');
      if (result.type !== 'plan') throw new Error('Expected plan');
      expect(result.plan.estimatedCost).toBeNull();
    });

    it('handles steps without optional protocol field', async () => {
      const mockClient = createMockClient('create_plan', {
        intent: 'move',
        steps: [
          {
            action: 'bridge',
            chainId: 137,
            token: 'USDT',
            amount: '500',
            details: 'Bridge 500 USDT to Polygon',
          },
        ],
        summary: 'Move 500 USDT to Polygon',
      });

      const processor = new NLCommandProcessor({ client: mockClient });
      const result = await processor.processCommand('Move 500 USDT to Polygon');

      expect(result.type).toBe('plan');
      if (result.type !== 'plan') throw new Error('Expected plan');
      expect(result.plan.steps[0].protocol).toBeUndefined();
    });
  });

  describe('processCommand — clarification', () => {
    it('returns clarification for ambiguous "Put money in yield"', async () => {
      const mockClient = createMockClient('request_clarification', {
        question: 'Which chain and protocol would you like to deposit into? How much would you like to move?',
        options: [
          'Aave on Ethereum',
          'Aave on Optimism',
          'Compound on Ethereum',
          'Specify amount (e.g., 50% or 1000 USDC)',
        ],
      });

      const processor = new NLCommandProcessor({ client: mockClient });
      const result = await processor.processCommand('Put money in yield');

      expect(result.type).toBe('clarification');
      if (result.type !== 'clarification') throw new Error('Expected clarification');
      expect(result.question).toContain('chain');
      expect(result.options.length).toBeGreaterThan(0);
    });

    it('stores clarification in conversation history for follow-up', async () => {
      const mockClient = createMockClient('request_clarification', {
        question: 'Which chain?',
        options: ['Ethereum', 'Arbitrum', 'Optimism'],
      });

      const processor = new NLCommandProcessor({ client: mockClient });
      await processor.processCommand('Move some tokens');

      // Second call should include conversation history
      await processor.processCommand('Arbitrum');

      expect(mockClient.messages.create).toHaveBeenCalledTimes(2);
      const secondCall = (mockClient.messages.create as ReturnType<typeof vi.fn>).mock.calls[1][0];
      // Should have 3 messages: user, assistant clarification, user follow-up
      expect(secondCall.messages).toHaveLength(3);
    });
  });

  describe('processCommand — rejection', () => {
    it('rejects unsupported "Send ETH to 0xabc"', async () => {
      const mockClient = createMockClient('reject_command', {
        reason: 'Direct transfers to wallet addresses are not supported. Cyrus manages cross-chain strategies, not individual transfers.',
        supported_commands: ['move', 'rebalance', 'allocate', 'stop', 'status'],
      });

      const processor = new NLCommandProcessor({ client: mockClient });
      const result = await processor.processCommand('Send ETH to 0xabc');

      expect(result.type).toBe('rejection');
      if (result.type !== 'rejection') throw new Error('Expected rejection');
      expect(result.reason).toContain('not supported');
      expect(result.supportedCommands).toContain('move');
      expect(result.supportedCommands).toContain('rebalance');
    });
  });

  describe('processCommand — text-only fallback', () => {
    it('returns clarification when AI responds with text only (no tool_use)', async () => {
      const mockClient = createTextOnlyMockClient('I need more information to help you.');

      const processor = new NLCommandProcessor({ client: mockClient });
      const result = await processor.processCommand('Do something');

      expect(result.type).toBe('clarification');
      if (result.type !== 'clarification') throw new Error('Expected clarification');
      expect(result.question).toBe('I need more information to help you.');
      expect(result.options).toEqual(['move tokens', 'rebalance portfolio', 'check status']);
    });

    it('returns default question when text is empty', async () => {
      const mockClient = createTextOnlyMockClient('');

      const processor = new NLCommandProcessor({ client: mockClient });
      const result = await processor.processCommand('...');

      expect(result.type).toBe('clarification');
      if (result.type !== 'clarification') throw new Error('Expected clarification');
      expect(result.question).toBe('Could you please rephrase your command?');
    });
  });

  describe('processCommand — error handling', () => {
    it('returns rejection on API failure (never throws)', async () => {
      const mockClient = createErrorMockClient('API unreachable');

      const processor = new NLCommandProcessor({ client: mockClient });
      const result = await processor.processCommand('Move tokens to Arbitrum');

      expect(result.type).toBe('rejection');
      if (result.type !== 'rejection') throw new Error('Expected rejection');
      expect(result.reason).toContain('API unreachable');
      expect(result.supportedCommands).toContain('move');
    });

    it('returns rejection on non-Error thrown value', async () => {
      const mockClient = {
        messages: {
          create: vi.fn().mockRejectedValue('string error'),
        },
      } as unknown as import('@anthropic-ai/sdk').default;

      const processor = new NLCommandProcessor({ client: mockClient });
      const result = await processor.processCommand('Move tokens');

      expect(result.type).toBe('rejection');
      if (result.type !== 'rejection') throw new Error('Expected rejection');
      expect(result.reason).toContain('string error');
    });

    it('handles unknown tool name gracefully', async () => {
      const mockClient = createMockClient('unknown_tool', { foo: 'bar' });

      const processor = new NLCommandProcessor({ client: mockClient });
      const result = await processor.processCommand('Something');

      expect(result.type).toBe('rejection');
      if (result.type !== 'rejection') throw new Error('Expected rejection');
      expect(result.reason).toContain('Unexpected response');
    });
  });

  describe('conversation turn limit', () => {
    it('rejects after exceeding MAX_CONVERSATION_TURNS (5 turns = 10 messages)', async () => {
      const mockClient = createMockClient('request_clarification', {
        question: 'Please clarify',
        options: ['option1'],
      });

      const processor = new NLCommandProcessor({ client: mockClient });

      // Exhaust 5 turns (each turn = 1 user + 1 assistant = 2 messages in history)
      for (let i = 0; i < 5; i++) {
        await processor.processCommand(`Clarification attempt ${i}`);
      }

      // The 6th call should hit the limit (history has 10 messages = 5 * 2)
      const result = await processor.processCommand('One more attempt');

      expect(result.type).toBe('rejection');
      if (result.type !== 'rejection') throw new Error('Expected rejection');
      expect(result.reason).toContain('Too many clarification turns');
    });

    it('resets conversation history after successful plan', async () => {
      const clarifyClient = createMockClient('request_clarification', {
        question: 'Which chain?',
        options: ['Ethereum'],
      });

      const processor = new NLCommandProcessor({ client: clarifyClient });
      await processor.processCommand('Do something');

      // Now swap the mock to return a plan
      (clarifyClient.messages.create as ReturnType<typeof vi.fn>).mockResolvedValue({
        content: [{
          type: 'tool_use',
          id: 'test-id-2',
          name: 'create_plan',
          input: {
            intent: 'move',
            steps: [{
              action: 'bridge',
              chainId: 1,
              token: 'ETH',
              amount: '100',
              details: 'Bridge ETH to Ethereum',
            }],
            summary: 'Move ETH',
          },
        }],
      });

      const result = await processor.processCommand('Move 100 ETH to Ethereum');
      expect(result.type).toBe('plan');

      // After plan, next call should have fresh history (only 1 message)
      await processor.processCommand('Another command');
      const lastCall = (clarifyClient.messages.create as ReturnType<typeof vi.fn>).mock.calls[2][0];
      expect(lastCall.messages).toHaveLength(1);
    });
  });

  describe('resolveChainName', () => {
    it('resolves Optimism to chain ID 10', () => {
      const processor = new NLCommandProcessor({
        client: createMockClient('create_plan', { intent: 'status', steps: [], summary: '' }),
      });
      expect(processor.resolveChainName('Optimism')).toBe(10);
    });

    it('resolves Arbitrum to chain ID 42161', () => {
      const processor = new NLCommandProcessor({
        client: createMockClient('create_plan', { intent: 'status', steps: [], summary: '' }),
      });
      expect(processor.resolveChainName('Arbitrum')).toBe(42161);
    });

    it('resolves Base to chain ID 8453', () => {
      const processor = new NLCommandProcessor({
        client: createMockClient('create_plan', { intent: 'status', steps: [], summary: '' }),
      });
      expect(processor.resolveChainName('Base')).toBe(8453);
    });

    it('resolves aliases case-insensitively (ETH -> 1, arb -> 42161)', () => {
      const processor = new NLCommandProcessor({
        client: createMockClient('create_plan', { intent: 'status', steps: [], summary: '' }),
      });
      expect(processor.resolveChainName('ETH')).toBe(1);
      expect(processor.resolveChainName('arb')).toBe(42161);
      expect(processor.resolveChainName('OP')).toBe(10);
      expect(processor.resolveChainName('MATIC')).toBe(137);
    });

    it('returns null for unknown chain names', () => {
      const processor = new NLCommandProcessor({
        client: createMockClient('create_plan', { intent: 'status', steps: [], summary: '' }),
      });
      expect(processor.resolveChainName('avalanche')).toBeNull();
      expect(processor.resolveChainName('unknown')).toBeNull();
    });

    it('resolves Solana to chain ID 1151111081099710', () => {
      const processor = new NLCommandProcessor({
        client: createMockClient('create_plan', { intent: 'status', steps: [], summary: '' }),
      });
      expect(processor.resolveChainName('solana')).toBe(1151111081099710);
      expect(processor.resolveChainName('SOL')).toBe(1151111081099710);
    });
  });

  describe('resetConversation', () => {
    it('clears conversation history', async () => {
      const mockClient = createMockClient('request_clarification', {
        question: 'Which chain?',
        options: ['Ethereum'],
      });

      const processor = new NLCommandProcessor({ client: mockClient });
      await processor.processCommand('Do something');
      await processor.processCommand('Something else');

      processor.resetConversation();

      // After reset, next call should only have 1 message
      await processor.processCommand('Fresh command');
      const lastCall = (mockClient.messages.create as ReturnType<typeof vi.fn>).mock.calls[2][0];
      expect(lastCall.messages).toHaveLength(1);
      expect(lastCall.messages[0].content).toBe('Fresh command');
    });
  });

  describe('Anthropic API call format', () => {
    it('passes system prompt, tools, and messages to Anthropic', async () => {
      const mockClient = createMockClient('create_plan', {
        intent: 'status',
        steps: [],
        summary: 'Check status',
      });

      const processor = new NLCommandProcessor({ client: mockClient });
      await processor.processCommand('Show me status');

      const call = (mockClient.messages.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.model).toBe('claude-sonnet-4-20250514');
      expect(call.max_tokens).toBe(1024);
      expect(call.system).toContain('Cyrus');
      expect(call.tools).toHaveLength(3);
      expect(call.messages).toHaveLength(1);
      expect(call.messages[0]).toEqual({ role: 'user', content: 'Show me status' });
    });

    it('uses custom model when provided', async () => {
      const mockClient = createMockClient('create_plan', {
        intent: 'status',
        steps: [],
        summary: 'Check status',
      });

      const processor = new NLCommandProcessor({ client: mockClient, model: 'claude-3-haiku-20240307' });
      await processor.processCommand('Status');

      const call = (mockClient.messages.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.model).toBe('claude-3-haiku-20240307');
    });
  });
});
