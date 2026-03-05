import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store } from '../store.js';
import type { CyrusConfig } from '../config.js';
import { sendSuccess, sendError, ERROR_CODES } from '../rest-types.js';

export interface StrategyMetrics {
  totalPnl: number;
  winRate: number;
  totalTrades: number;
  openPositions: number;
  lastSignalAt: number | null;
  performanceHistory: Array<{ timestamp: number; pnl: number }>;
}

export interface StrategyParam {
  key: string;
  value: string | number | boolean;
  description?: string;
}

export interface StrategyResponse {
  name: string;
  enabled: boolean;
  tier: 'Safe' | 'Growth' | 'Degen';
  metrics: StrategyMetrics;
  params: StrategyParam[];
}

// Map strategy names to tiers based on risk profile
function inferTier(name: string): 'Safe' | 'Growth' | 'Degen' {
  const lower = name.toLowerCase();
  if (lower.includes('yield') || lower.includes('reserve') || lower.includes('safe')) return 'Safe';
  if (lower.includes('degen') || lower.includes('leverage') || lower.includes('stat')) return 'Degen';
  return 'Growth';
}

export function createStrategiesHandler(store: Store, config: CyrusConfig) {
  return function handleStrategies(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'GET') {
      sendError(res, ERROR_CODES.METHOD_NOT_ALLOWED, `Method ${req.method} not allowed`, 405);
      return Promise.resolve();
    }

    // Build strategy list from config + store data
    const enabledStrategies = config.strategies.enabled;
    const reports = store.getReports();
    const positions = store.getAllPositions();

    const strategies: StrategyResponse[] = enabledStrategies.map((name) => {
      // Get decision reports for this strategy
      const strategyReports = reports.filter((r) => r.strategyName === name);
      const successReports = strategyReports.filter((r) => r.outcome === 'positive');
      const totalTrades = strategyReports.length;
      const winRate = totalTrades > 0 ? successReports.length / totalTrades : 0;

      // Calculate total PnL from completed trades
      const trades = store.getAllTrades().filter((t) => t.strategyId === name);
      const totalPnl = trades.reduce((sum, t) => sum + t.pnlUsd, 0);

      // Count open positions for this strategy
      const openPositions = positions.filter(
        (p) => p.strategyId === name,
      ).length;

      // Last signal timestamp
      const lastReport = strategyReports[0]; // Reports are sorted desc
      const lastSignalAt = lastReport ? lastReport.timestamp : null;

      // Build performance history from trades (cumulative PnL)
      let cumPnl = 0;
      const performanceHistory = trades
        .slice(-50)
        .map((t) => {
          cumPnl += t.pnlUsd;
          return { timestamp: t.executedAt, pnl: cumPnl };
        });

      return {
        name,
        enabled: true,
        tier: inferTier(name),
        metrics: {
          totalPnl,
          winRate,
          totalTrades,
          openPositions,
          lastSignalAt,
          performanceHistory,
        },
        params: [],
      };
    });

    sendSuccess(res, strategies);
    return Promise.resolve();
  };
}
