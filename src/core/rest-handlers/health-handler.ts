import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendSuccess, sendError, ERROR_CODES } from '../rest-types.js';

export interface HealthResponse {
  status: 'healthy' | 'degraded';
  uptime: number;
  version: string;
  tickCount: number;
}

export interface HealthDeps {
  getTickCount: () => number;
  isRunning: () => boolean;
}

export function createHealthHandler(deps?: HealthDeps) {
  return function handleHealth(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'GET') {
      sendError(res, ERROR_CODES.METHOD_NOT_ALLOWED, `Method ${req.method} not allowed`, 405);
      return Promise.resolve();
    }

    const data: HealthResponse = {
      status: deps?.isRunning() ? 'healthy' : 'degraded',
      uptime: process.uptime(),
      version: process.env.npm_package_version ?? '1.0.0',
      tickCount: deps?.getTickCount() ?? 0,
    };

    sendSuccess(res, data);
    return Promise.resolve();
  };
}

// Keep backward-compatible standalone function
export function handleHealth(req: IncomingMessage, res: ServerResponse): Promise<void> {
  return createHealthHandler()(req, res);
}
