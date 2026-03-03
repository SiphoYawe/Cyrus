import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CyrusConfig } from '../config.js';
import { redactConfig } from '../config.js';
import { sendSuccess, sendError, ERROR_CODES } from '../rest-types.js';

export function createConfigHandler(config: CyrusConfig) {
  return function handleConfig(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'GET') {
      sendError(res, ERROR_CODES.METHOD_NOT_ALLOWED, `Method ${req.method} not allowed`, 405);
      return Promise.resolve();
    }

    const redacted = redactConfig(config);
    sendSuccess(res, redacted);
    return Promise.resolve();
  };
}
