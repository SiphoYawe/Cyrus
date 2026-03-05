// OpenClaw Bridge Tool — Creates a cross-chain bridge action preview for user approval

import { randomUUID } from 'node:crypto';
import type { OpenClawPlugin } from '../plugin.js';
import type { OpenClawToolDefinition, OpenClawToolResult, PendingAction } from '../types.js';

const PENDING_ACTION_TTL_MS = 5 * 60 * 1000;

const CHAIN_NAMES: Record<number, string> = {
  1: 'Ethereum',
  42161: 'Arbitrum',
  10: 'Optimism',
  137: 'Polygon',
  8453: 'Base',
  56: 'BSC',
};

export function createBridgeTool(plugin: OpenClawPlugin): OpenClawToolDefinition {
  return {
    name: 'bridge',
    description: 'Preview a cross-chain bridge transfer. Returns a preview for approval before execution.',
    parameters: [
      { name: 'fromChain', type: 'number', description: 'Source chain ID', required: true },
      { name: 'toChain', type: 'number', description: 'Destination chain ID', required: true },
      { name: 'token', type: 'string', description: 'Token symbol to bridge (e.g. USDC)', required: true },
      { name: 'amount', type: 'string', description: 'Amount to bridge in human-readable units', required: true },
      { name: 'slippage', type: 'number', description: 'Slippage tolerance (default: 0.005)', required: false, default: 0.005 },
    ],
    handler: async (params): Promise<OpenClawToolResult> => {
      const fromChain = params.fromChain as number;
      const toChain = params.toChain as number;
      const token = params.token as string;
      const amount = params.amount as string;
      const slippage = (params.slippage as number | undefined) ?? 0.005;

      if (fromChain === toChain) {
        return {
          success: false,
          message: 'Source and destination chains must be different for bridging. Use swap tool for same-chain transfers.',
        };
      }

      const config = plugin.getConfig();
      const enabledChains = config.chains.enabled;
      if (!enabledChains.includes(fromChain) || !enabledChains.includes(toChain)) {
        return {
          success: false,
          message: `One or both chains not enabled. Enabled chains: ${enabledChains.join(', ')}`,
        };
      }

      const actionId = randomUUID();
      const now = Date.now();
      const fromName = CHAIN_NAMES[fromChain] ?? `Chain ${fromChain}`;
      const toName = CHAIN_NAMES[toChain] ?? `Chain ${toChain}`;

      const pendingAction: PendingAction = {
        id: actionId,
        tool: 'bridge',
        params: { fromChain, toChain, token, amount, slippage },
        preview: {
          action: 'bridge',
          fromChain,
          toChain,
          fromToken: token,
          toToken: token,
          fromAmount: amount,
          estimatedOutput: amount,
          estimatedGasUsd: 8,
          estimatedBridgeFeeUsd: 2,
          estimatedSlippage: slippage,
          route: `LI.FI Bridge (${fromName} → ${toName})`,
        },
        createdAt: now,
        expiresAt: now + PENDING_ACTION_TTL_MS,
      };

      plugin.addPendingAction(pendingAction);

      return {
        success: true,
        message: `Bridge preview: ${amount} ${token} from ${fromName} → ${toName}. Approve with action ID: ${actionId}`,
        data: {
          actionId,
          preview: pendingAction.preview,
          expiresIn: '5 minutes',
        },
      };
    },
  };
}
