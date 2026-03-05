// OpenClaw Trade Approve Tool — Approve or deny pending trade actions

import type { OpenClawPlugin } from '../plugin.js';
import type { OpenClawToolDefinition, OpenClawToolResult } from '../types.js';

export function createTradeApproveTool(plugin: OpenClawPlugin): OpenClawToolDefinition {
  return {
    name: 'trade-approve',
    description: 'Approve or deny a pending trade action by its action ID',
    parameters: [
      { name: 'actionId', type: 'string', description: 'The action ID from a trade preview', required: true },
      { name: 'decision', type: 'string', description: 'Decision: approve or deny', required: true },
    ],
    handler: async (params): Promise<OpenClawToolResult> => {
      const actionId = params.actionId as string;
      const decision = (params.decision as string).toLowerCase();

      if (decision !== 'approve' && decision !== 'deny') {
        return {
          success: false,
          message: 'Decision must be "approve" or "deny"',
        };
      }

      const action = plugin.getPendingAction(actionId);
      if (!action) {
        return {
          success: false,
          message: `No pending action found with ID: ${actionId}. It may have expired.`,
        };
      }

      plugin.removePendingAction(actionId);

      if (decision === 'deny') {
        return {
          success: true,
          message: `Action ${actionId} denied. No trade executed.`,
          data: {
            actionId,
            decision: 'denied',
            preview: action.preview,
          },
        };
      }

      // Approve — in production, this would trigger actual execution via the action queue
      return {
        success: true,
        message: `Action ${actionId} approved. Executing: ${action.preview.action} ${action.preview.fromAmount} ${action.preview.fromToken} → ${action.preview.toToken}`,
        data: {
          actionId,
          decision: 'approved',
          preview: action.preview,
          status: 'queued',
        },
      };
    },
  };
}
