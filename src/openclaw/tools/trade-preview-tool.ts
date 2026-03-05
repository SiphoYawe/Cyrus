// OpenClaw Trade Preview Tool — Generates detailed previews of trade actions

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

export function createTradePreviewTool(plugin: OpenClawPlugin): OpenClawToolDefinition {
  return {
    name: 'trade-preview',
    description: 'Generate a detailed preview of a cross-chain trade action with cost estimates',
    parameters: [
      { name: 'action', type: 'string', description: 'Action type: swap, bridge, or deposit', required: true },
      { name: 'fromChain', type: 'number', description: 'Source chain ID', required: true },
      { name: 'toChain', type: 'number', description: 'Destination chain ID', required: true },
      { name: 'fromToken', type: 'string', description: 'Source token symbol', required: true },
      { name: 'toToken', type: 'string', description: 'Destination token symbol', required: true },
      { name: 'amount', type: 'string', description: 'Amount in human-readable units', required: true },
      { name: 'slippage', type: 'number', description: 'Slippage tolerance (default: 0.005)', required: false, default: 0.005 },
    ],
    handler: async (params): Promise<OpenClawToolResult> => {
      const action = params.action as string;
      const fromChain = params.fromChain as number;
      const toChain = params.toChain as number;
      const fromToken = params.fromToken as string;
      const toToken = params.toToken as string;
      const amount = params.amount as string;
      const slippage = (params.slippage as number | undefined) ?? 0.005;

      const validActions = ['swap', 'bridge', 'deposit'];
      if (!validActions.includes(action)) {
        return {
          success: false,
          message: `Invalid action. Must be one of: ${validActions.join(', ')}`,
        };
      }

      // Estimate costs based on action type
      const isCrossChain = fromChain !== toChain;
      const estimatedGasUsd = isCrossChain ? 12 : 5;
      const estimatedBridgeFeeUsd = isCrossChain ? 3 : 0;
      const estimatedSlippage = slippage;
      const totalCostUsd = estimatedGasUsd + estimatedBridgeFeeUsd;

      const fromName = CHAIN_NAMES[fromChain] ?? `Chain ${fromChain}`;
      const toName = CHAIN_NAMES[toChain] ?? `Chain ${toChain}`;

      // Determine route description
      let route: string;
      if (action === 'deposit') {
        route = `LI.FI Composer (${fromName} → ${toName} + deposit)`;
      } else if (isCrossChain) {
        route = `LI.FI Bridge (${fromName} → ${toName})`;
      } else {
        route = `LI.FI DEX Aggregation (${fromName})`;
      }

      const actionId = randomUUID();
      const now = Date.now();

      const pendingAction: PendingAction = {
        id: actionId,
        tool: 'trade-preview',
        params: { action, fromChain, toChain, fromToken, toToken, amount, slippage },
        preview: {
          action,
          fromChain,
          toChain,
          fromToken,
          toToken,
          fromAmount: amount,
          estimatedOutput: amount,
          estimatedGasUsd,
          estimatedBridgeFeeUsd,
          estimatedSlippage,
          route,
        },
        createdAt: now,
        expiresAt: now + PENDING_ACTION_TTL_MS,
      };

      plugin.addPendingAction(pendingAction);

      return {
        success: true,
        message: `Trade preview: ${action} ${amount} ${fromToken} → ${toToken} (${fromName} → ${toName}). Est. cost: $${totalCostUsd.toFixed(2)}. Approve action ID: ${actionId}`,
        data: {
          actionId,
          preview: pendingAction.preview,
          estimatedCost: { gasUsd: estimatedGasUsd, bridgeFeeUsd: estimatedBridgeFeeUsd, totalUsd: totalCostUsd },
          expiresIn: '5 minutes',
        },
      };
    },
  };
}
