import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendSuccess, sendError, ERROR_CODES } from '../rest-types.js';

export interface StrategiesResponse {
  strategies: unknown[];
}

export function handleStrategies(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'GET') {
    sendError(res, ERROR_CODES.METHOD_NOT_ALLOWED, `Method ${req.method} not allowed`, 405);
    return Promise.resolve();
  }

  const data: StrategiesResponse = {
    strategies: [],
  };

  sendSuccess(res, data);
  return Promise.resolve();
}
