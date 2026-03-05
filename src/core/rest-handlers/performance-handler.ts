// REST handler: GET /api/strategies/performance

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store } from '../store.js';
import type { CyrusConfig } from '../config.js';
import { sendSuccess, sendError, ERROR_CODES } from '../rest-types.js';

interface StrategyPerformance {
  name: string;
  totalPnl: number;
  winRate: number;
  totalTrades: number;
  openPositions: number;
  lastSignalAt: number | null;
}

export function createPerformanceHandler(store: Store, config: CyrusConfig) {
  return function handlePerformance(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'GET') {
      sendError(res, ERROR_CODES.METHOD_NOT_ALLOWED, `Method ${req.method} not allowed`, 405);
      return Promise.resolve();
    }

    const enabledStrategies = config.strategies.enabled;
    const reports = store.getReports();
    const trades = store.getAllTrades();
    const positions = store.getAllPositions();

    const performance: StrategyPerformance[] = enabledStrategies.map((name) => {
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
        totalPnl,
        winRate,
        totalTrades,
        openPositions,
        lastSignalAt: lastReport?.timestamp ?? null,
      };
    });

    const combinedPnl = performance.reduce((sum, s) => sum + s.totalPnl, 0);
    sendSuccess(res, { strategies: performance, combinedPnl });
    return Promise.resolve();
  };
}
