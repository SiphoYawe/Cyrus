import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PersistenceService } from '../persistence.js';
import { sendSuccess, sendError, ERROR_CODES } from '../rest-types.js';

export function createBacktestingResultsHandler(
  persistence: PersistenceService,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== 'GET') {
      sendError(res, ERROR_CODES.METHOD_NOT_ALLOWED, `Method ${req.method} not allowed`, 405);
      return;
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const limit = Math.min(Number(url.searchParams.get('limit') ?? '50'), 200);
    const offset = Number(url.searchParams.get('offset') ?? '0');
    const strategy = url.searchParams.get('strategy') ?? undefined;

    const results = persistence.getBacktestResults(limit, offset, strategy);
    sendSuccess(res, results);
  };
}
