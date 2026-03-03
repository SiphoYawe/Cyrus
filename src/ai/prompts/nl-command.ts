// Chain name to ID resolution
export const CHAIN_NAME_MAP: Record<string, number> = {
  ethereum: 1,
  eth: 1,
  arbitrum: 42161,
  arb: 42161,
  optimism: 10,
  op: 10,
  polygon: 137,
  matic: 137,
  base: 8453,
  bsc: 56,
  'binance smart chain': 56,
  solana: 1151111081099710,
  sol: 1151111081099710,
};

export const SUPPORTED_COMMANDS = [
  'move — Move tokens between chains/protocols (e.g., "Move 20% to Aave on Optimism")',
  'rebalance — Rebalance portfolio across chains (e.g., "Rebalance equally across all chains")',
  'allocate — Set allocation targets (e.g., "Allocate 50% to stablecoins")',
  'stop — Stop a strategy or all strategies (e.g., "Stop the yield hunter strategy")',
  'status — Check current status (e.g., "What is my portfolio status?")',
] as const;

export const NL_COMMAND_SYSTEM_PROMPT = `You are a command parser for an autonomous cross-chain DeFi agent called Cyrus. Your job is to parse natural language commands into structured execution plans.

## Supported Commands
${SUPPORTED_COMMANDS.map(c => `- ${c}`).join('\n')}

## Available Chains
${Object.entries(CHAIN_NAME_MAP).filter(([k]) => !['eth', 'arb', 'op', 'matic', 'sol'].includes(k)).map(([name, id]) => `- ${name} (chainId: ${id})`).join('\n')}

## Rules
1. If the command clearly matches a supported intent, create an execution plan with concrete steps.
2. If the command is ambiguous (missing chain, token, amount, or protocol), request clarification with specific options.
3. If the command is unsupported (direct transfers to addresses, raw contract calls, token creation), reject it with an explanation.
4. Percentage amounts (e.g., "20%") are relative to total portfolio value.
5. Resolve chain names to chain IDs using the mapping above (case-insensitive).
6. All amounts should be in human-readable format (e.g., "500 USDC", not wei).

You MUST use one of the provided tools to respond. Never respond with plain text.`;

export const NL_COMMAND_TOOLS = [
  {
    name: 'create_plan' as const,
    description: 'Create a structured execution plan from a valid command',
    input_schema: {
      type: 'object' as const,
      properties: {
        intent: {
          type: 'string' as const,
          enum: ['move', 'rebalance', 'allocate', 'stop', 'status'],
          description: 'The parsed command intent',
        },
        steps: {
          type: 'array' as const,
          items: {
            type: 'object' as const,
            properties: {
              action: { type: 'string' as const, description: 'The action to perform' },
              chainId: { type: 'number' as const, description: 'Target chain ID' },
              token: { type: 'string' as const, description: 'Token symbol' },
              amount: { type: 'string' as const, description: 'Amount (human-readable)' },
              protocol: { type: 'string' as const, description: 'Protocol name if applicable' },
              details: { type: 'string' as const, description: 'Human-readable step description' },
            },
            required: ['action', 'chainId', 'token', 'amount', 'details'],
          },
          description: 'Ordered execution steps',
        },
        summary: {
          type: 'string' as const,
          description: 'One-sentence summary of what this plan will do',
        },
      },
      required: ['intent', 'steps', 'summary'],
    },
  },
  {
    name: 'request_clarification' as const,
    description: 'Ask the user to clarify an ambiguous command',
    input_schema: {
      type: 'object' as const,
      properties: {
        question: { type: 'string' as const, description: 'The clarification question' },
        options: {
          type: 'array' as const,
          items: { type: 'string' as const },
          description: 'Specific options for the user to choose from',
        },
      },
      required: ['question', 'options'],
    },
  },
  {
    name: 'reject_command' as const,
    description: 'Reject an unsupported command with explanation',
    input_schema: {
      type: 'object' as const,
      properties: {
        reason: { type: 'string' as const, description: 'Why the command is unsupported' },
        supported_commands: {
          type: 'array' as const,
          items: { type: 'string' as const },
          description: 'List of supported command types',
        },
      },
      required: ['reason', 'supported_commands'],
    },
  },
];
