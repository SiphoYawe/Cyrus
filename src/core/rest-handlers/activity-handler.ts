import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PersistenceService } from '../persistence.js';
import { sendSuccess, sendError, ERROR_CODES } from '../rest-types.js';

export interface ActivityPagination {
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

export interface ActivityResponse {
  activities: Array<{
    id: string;
    timestamp: string;
    chainId: number;
    fromToken: string;
    toToken: string;
    fromAmount: string;
    toAmount: string;
    txHash: string;
    decisionReportId: string | null;
    actionType: string;
    createdAt: string;
  }>;
  pagination: ActivityPagination;
}

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;
const DEFAULT_OFFSET = 0;

export function createActivityHandler(persistence: PersistenceService) {
  return function handleActivity(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'GET') {
      sendError(res, ERROR_CODES.METHOD_NOT_ALLOWED, `Method ${req.method} not allowed`, 405);
      return Promise.resolve();
    }

    // Parse query params
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const rawLimit = url.searchParams.get('limit');
    const rawOffset = url.searchParams.get('offset');

    let limit = DEFAULT_LIMIT;
    let offset = DEFAULT_OFFSET;

    if (rawLimit !== null) {
      const parsed = parseInt(rawLimit, 10);
      if (isNaN(parsed) || parsed < 1) {
        sendError(res, ERROR_CODES.VALIDATION_ERROR, 'limit must be a positive integer', 400);
        return Promise.resolve();
      }
      limit = Math.min(parsed, MAX_LIMIT);
    }

    if (rawOffset !== null) {
      const parsed = parseInt(rawOffset, 10);
      if (isNaN(parsed) || parsed < 0) {
        sendError(res, ERROR_CODES.VALIDATION_ERROR, 'offset must be a non-negative integer', 400);
        return Promise.resolve();
      }
      offset = parsed;
    }

    const { entries, total } = persistence.getActivityLog(limit, offset);

    const activities = entries.map((e) => ({
      id: e.id,
      timestamp: e.timestamp,
      chainId: e.chainId as number,
      fromToken: e.fromToken as string,
      toToken: e.toToken as string,
      fromAmount: e.fromAmount,
      toAmount: e.toAmount,
      txHash: e.txHash,
      decisionReportId: e.decisionReportId,
      actionType: e.actionType,
      createdAt: e.createdAt,
    }));

    const data: ActivityResponse = {
      activities,
      pagination: {
        total,
        limit,
        offset,
        hasMore: offset + limit < total,
      },
    };

    sendSuccess(res, data);
    return Promise.resolve();
  };
}
