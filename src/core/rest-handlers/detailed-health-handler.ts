// REST handler: GET /api/health/detailed

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store } from '../store.js';
import type { SocialSourceStatus } from '../../data/social-sentinel.js';
import { sendSuccess, sendError, ERROR_CODES } from '../rest-types.js';

export interface DetailedHealthResponse {
  status: 'healthy' | 'degraded' | 'critical';
  uptime: number;
  version: string;
  tickCount: number;
  agentRunning: boolean;
  portfolio: {
    totalUsdValue: number;
    chainCount: number;
    tokenCount: number;
  };
  transfers: {
    active: number;
    completed: number;
  };
  positions: {
    open: number;
    statArb: number;
  };
  regime: string | null;
  lastDecisionAt: number | null;
  socialSources?: SocialSourceStatus[];
}

export interface DetailedHealthDeps {
  getTickCount: () => number;
  isRunning: () => boolean;
  getSocialSourceStatus?: () => SocialSourceStatus[];
}

export function createDetailedHealthHandler(store: Store, deps?: DetailedHealthDeps) {
  return function handleDetailedHealth(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'GET') {
      sendError(res, ERROR_CODES.METHOD_NOT_ALLOWED, `Method ${req.method} not allowed`, 405);
      return Promise.resolve();
    }

    const isRunning = deps?.isRunning() ?? false;
    const balances = store.getAllBalances();
    const totalUsdValue = balances.reduce((sum, b) => sum + b.usdValue, 0);
    const chainSet = new Set(balances.map((b) => b.chainId));
    const reports = store.getReports({ limit: 1 });
    const lastDecisionAt = reports.length > 0 ? reports[0].timestamp : null;
    const regime = store.getLatestRegime();

    // Determine overall status
    let status: 'healthy' | 'degraded' | 'critical' = 'healthy';
    if (!isRunning) status = 'critical';
    else if (store.getActiveTransfers().length > 10) status = 'degraded';

    const data: DetailedHealthResponse = {
      status,
      uptime: process.uptime(),
      version: process.env.npm_package_version ?? '1.0.0',
      tickCount: deps?.getTickCount() ?? 0,
      agentRunning: isRunning,
      portfolio: {
        totalUsdValue,
        chainCount: chainSet.size,
        tokenCount: balances.length,
      },
      transfers: {
        active: store.getActiveTransfers().length,
        completed: store.getCompletedTransfers().length,
      },
      positions: {
        open: store.getAllPositions().length,
        statArb: store.getAllActiveStatArbPositions().length,
      },
      regime: regime?.regime ?? null,
      lastDecisionAt,
      socialSources: deps?.getSocialSourceStatus?.() ?? undefined,
    };

    sendSuccess(res, data);
    return Promise.resolve();
  };
}
