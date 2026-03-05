// OpenClaw Swap Tool — Creates a swap action preview for user approval

import { randomUUID } from 'node:crypto';
import type { OpenClawPlugin } from '../plugin.js';
import type { OpenClawToolDefinition, OpenClawToolResult, PendingAction } from '../types.js';

const PENDING_ACTION_TTL_MS = 5 * 60 * 1000;

export function createSwapTool(plugin: OpenClawPlugin): OpenClawToolDefinition {
  return {
    name: 'swap',
    description: 'Preview a same-chain token swap. Returns a preview for approval before execution.',
    parameters: [
      { name: 'fromToken', type: 'string', description: 'Source token symbol (e.g. USDC)', required: true },
      { name: 'toToken', type: 'string', description: 'Destination token symbol (e.g. ETH)', required: true },
      { name: 'amount', type: 'string', description: 'Amount to swap in human-readable units', required: true },
      { name: 'chainId', type: 'number', description: 'Chain ID (default: 1 for Ethereum)', required: false, default: 1 },
      { name: 'slippage', type: 'number', description: 'Slippage tolerance (default: 0.005)', required: false, default: 0.005 },
    ],
    handler: async (params): Promise<OpenClawToolResult> => {
      const fromToken = params.fromToken as string;
      const toToken = params.toToken as string;
      const amount = params.amount as string;
      const chain = (params.chainId as number | undefined) ?? 1;
      const slippage = (params.slippage as number | undefined) ?? 0.005;

      const actionId = randomUUID();
      const now = Date.now();

      const pendingAction: PendingAction = {
        id: actionId,
        tool: 'swap',
        params: { fromToken, toToken, amount, chainId: chain, slippage },
        preview: {
          action: 'swap',
          fromChain: chain,
          toChain: chain,
          fromToken,
          toToken,
          fromAmount: amount,
          estimatedOutput: amount, // Would be replaced by real quote
          estimatedGasUsd: 5,
          estimatedBridgeFeeUsd: 0,
          estimatedSlippage: slippage,
          route: 'LI.FI DEX Aggregation',
        },
        createdAt: now,
        expiresAt: now + PENDING_ACTION_TTL_MS,
      };

      plugin.addPendingAction(pendingAction);

      return {
        success: true,
        message: `Swap preview: ${amount} ${fromToken} → ${toToken} on chain ${chain}. Approve with action ID: ${actionId}`,
        data: {
          actionId,
          preview: pendingAction.preview,
          expiresIn: '5 minutes',
        },
      };
    },
  };
}
