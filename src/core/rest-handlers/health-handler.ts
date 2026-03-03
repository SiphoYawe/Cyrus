import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendSuccess, sendError, ERROR_CODES } from '../rest-types.js';

export interface HealthResponse {
  status: 'healthy';
  uptime: number;
  version: string;
  tickCount: number;
}

export function handleHealth(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'GET') {
    sendError(res, ERROR_CODES.METHOD_NOT_ALLOWED, `Method ${req.method} not allowed`, 405);
    return Promise.resolve();
  }

  const data: HealthResponse = {
    status: 'healthy',
    uptime: process.uptime(),
    version: '1.0.0',
    tickCount: 0,
  };

  sendSuccess(res, data);
  return Promise.resolve();
}
