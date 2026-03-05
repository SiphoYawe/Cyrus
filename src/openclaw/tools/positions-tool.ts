// OpenClaw Positions Tool — Returns open positions summary

import type { OpenClawPlugin } from '../plugin.js';
import type { OpenClawToolDefinition, OpenClawToolResult } from '../types.js';

export function createPositionsTool(plugin: OpenClawPlugin): OpenClawToolDefinition {
  return {
    name: 'positions',
    description: 'Get all open positions with P&L information',
    parameters: [
      {
        name: 'strategy',
        type: 'string',
        description: 'Filter by strategy name (optional)',
        required: false,
      },
    ],
    handler: async (params): Promise<OpenClawToolResult> => {
      const store = plugin.getStore();
      const strategyFilter = params.strategy as string | undefined;

      let positions = store.getAllPositions();
      if (strategyFilter) {
        positions = positions.filter((p) => p.strategyId === strategyFilter);
      }

      const totalPnlUsd = positions.reduce((sum, p) => sum + p.pnlUsd, 0);
      const positionSummaries = positions.map((p) => ({
        id: p.id,
        strategy: p.strategyId,
        chainId: p.chainId as number,
        token: p.tokenAddress as string,
        entryPrice: p.entryPrice,
        currentPrice: p.currentPrice,
        pnlUsd: p.pnlUsd,
        pnlPercent: p.pnlPercent,
      }));

      // Also include stat arb positions
      const statArbPositions = store.getAllActiveStatArbPositions();
      const statArbSummaries = statArbPositions.map((p) => ({
        id: p.positionId,
        type: 'stat-arb',
        pair: p.pair.key,
        direction: p.direction,
        leverage: p.leverage,
        combinedPnl: p.combinedPnl,
        accumulatedFunding: p.accumulatedFunding,
      }));

      return {
        success: true,
        message: `${positions.length} position(s), ${statArbPositions.length} stat-arb pair(s). Total P&L: $${totalPnlUsd.toFixed(2)}`,
        data: {
          positions: positionSummaries,
          statArbPositions: statArbSummaries,
          totalPnlUsd,
          count: positions.length + statArbPositions.length,
        },
      };
    },
  };
}
