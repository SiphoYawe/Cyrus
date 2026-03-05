// OpenClaw Strategies Tool — Returns strategy status and performance

import type { OpenClawPlugin } from '../plugin.js';
import type { OpenClawToolDefinition, OpenClawToolResult } from '../types.js';

function inferTier(name: string): 'Safe' | 'Growth' | 'Degen' {
  const lower = name.toLowerCase();
  if (lower.includes('yield') || lower.includes('reserve') || lower.includes('safe') || lower.includes('liquid-staking')) return 'Safe';
  if (lower.includes('degen') || lower.includes('leverage') || lower.includes('stat') || lower.includes('meme')) return 'Degen';
  return 'Growth';
}

export function createStrategiesTool(plugin: OpenClawPlugin): OpenClawToolDefinition {
  return {
    name: 'strategies',
    description: 'Get enabled strategies, their performance metrics, and current status',
    parameters: [
      {
        name: 'name',
        type: 'string',
        description: 'Filter by strategy name (optional)',
        required: false,
      },
    ],
    handler: async (params): Promise<OpenClawToolResult> => {
      const store = plugin.getStore();
      const config = plugin.getConfig();
      const nameFilter = params.name as string | undefined;

      let enabledStrategies = config.strategies.enabled;
      if (nameFilter) {
        enabledStrategies = enabledStrategies.filter((n) =>
          n.toLowerCase().includes(nameFilter.toLowerCase()),
        );
      }

      const reports = store.getReports();
      const trades = store.getAllTrades();
      const positions = store.getAllPositions();

      const strategies = enabledStrategies.map((name) => {
        const strategyReports = reports.filter((r) => r.strategyName === name);
        const successReports = strategyReports.filter((r) => r.outcome === 'positive');
        const totalTrades = strategyReports.length;
        const winRate = totalTrades > 0 ? successReports.length / totalTrades : 0;

        const strategyTrades = trades.filter((t) => t.strategyId === name);
        const totalPnl = strategyTrades.reduce((sum, t) => sum + t.pnlUsd, 0);
        const openPositions = positions.filter((p) => p.strategyId === name).length;
        const lastReport = strategyReports[0];

        return {
          name,
          enabled: true,
          tier: inferTier(name),
          totalPnl,
          winRate,
          totalTrades,
          openPositions,
          lastSignalAt: lastReport?.timestamp ?? null,
        };
      });

      const totalPnl = strategies.reduce((sum, s) => sum + s.totalPnl, 0);

      return {
        success: true,
        message: `${strategies.length} strategy(ies) enabled. Combined P&L: $${totalPnl.toFixed(2)}`,
        data: { strategies, combinedPnl: totalPnl },
      };
    },
  };
}
