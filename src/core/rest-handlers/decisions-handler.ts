// REST handler: GET /api/activity/decisions

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store } from '../store.js';
import { sendSuccess, sendError, ERROR_CODES } from '../rest-types.js';
import type { OutcomeClassification } from '../../ai/types.js';

export function createDecisionsHandler(store: Store) {
  return function handleDecisions(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'GET') {
      sendError(res, ERROR_CODES.METHOD_NOT_ALLOWED, `Method ${req.method} not allowed`, 405);
      return Promise.resolve();
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const strategyFilter = url.searchParams.get('strategy') ?? undefined;
    const outcomeFilter = url.searchParams.get('outcome') as OutcomeClassification | undefined;
    const rawLimit = url.searchParams.get('limit');
    const limit = rawLimit ? Math.min(parseInt(rawLimit, 10) || 50, 200) : 50;

    const reports = store.getReports({
      strategyName: strategyFilter,
      outcome: outcomeFilter,
      limit,
    });

    const decisions = reports.map((r) => ({
      id: r.id,
      timestamp: r.timestamp,
      strategy: r.strategyName,
      outcome: r.outcome,
      narrative: r.narrative,
      action: r.context.actionType,
      fromChain: r.context.fromChain,
      toChain: r.context.toChain,
      token: r.context.tokenSymbol,
      amountUsd: r.context.amountUsd,
      gasCostUsd: r.context.gasCostUsd,
    }));

    sendSuccess(res, { decisions, count: decisions.length });
    return Promise.resolve();
  };
}
