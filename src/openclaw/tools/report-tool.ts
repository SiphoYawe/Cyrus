// OpenClaw Report Tool — Retrieves recent decision reports and activity summaries

import type { OpenClawPlugin } from '../plugin.js';
import type { OpenClawToolDefinition, OpenClawToolResult } from '../types.js';

export function createReportTool(plugin: OpenClawPlugin): OpenClawToolDefinition {
  return {
    name: 'report',
    description: 'Get recent decision reports, trade history, and activity summaries',
    parameters: [
      { name: 'strategy', type: 'string', description: 'Filter by strategy name', required: false },
      { name: 'limit', type: 'number', description: 'Number of reports to return (default: 10)', required: false, default: 10 },
      { name: 'outcome', type: 'string', description: 'Filter by outcome: positive, negative, neutral, pending, failed', required: false },
    ],
    handler: async (params): Promise<OpenClawToolResult> => {
      const store = plugin.getStore();
      const strategyFilter = params.strategy as string | undefined;
      const limit = (params.limit as number | undefined) ?? 10;
      const outcomeFilter = params.outcome as string | undefined;

      const reports = store.getReports({
        strategyName: strategyFilter,
        outcome: outcomeFilter as import('../../ai/types.js').OutcomeClassification | undefined,
        limit,
      });

      const summaries = reports.map((r) => ({
        id: r.id,
        timestamp: new Date(r.timestamp).toISOString(),
        strategy: r.strategyName,
        outcome: r.outcome,
        narrative: r.narrative.slice(0, 200),
        action: r.context.actionType,
        amountUsd: r.context.amountUsd,
        gasCostUsd: r.context.gasCostUsd,
      }));

      // Aggregate stats
      const positive = reports.filter((r) => r.outcome === 'positive').length;
      const negative = reports.filter((r) => r.outcome === 'negative').length;
      const pending = reports.filter((r) => r.outcome === 'pending').length;

      return {
        success: true,
        message: `${reports.length} report(s): ${positive} positive, ${negative} negative, ${pending} pending`,
        data: {
          reports: summaries,
          stats: { total: reports.length, positive, negative, pending },
        },
      };
    },
  };
}
