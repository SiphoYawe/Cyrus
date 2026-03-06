import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendSuccess, sendError, ERROR_CODES } from '../rest-types.js';
import type { NLCommandProcessor } from '../../ai/nl-command-processor.js';
import type { ExecutionPreview } from '../../ai/execution-preview.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('commands-handler');

export function createCommandsHandler(
  nlProcessor: NLCommandProcessor,
  executionPreview?: ExecutionPreview,
) {
  return async function handleCommands(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      sendError(res, ERROR_CODES.METHOD_NOT_ALLOWED, `Method ${req.method} not allowed`, 405);
      return;
    }

    // Parse request body
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    const body = Buffer.concat(chunks).toString('utf-8');

    let parsed: { command?: string };
    try {
      parsed = JSON.parse(body) as { command?: string };
    } catch {
      sendError(res, ERROR_CODES.INVALID_REQUEST, 'Invalid JSON body', 400);
      return;
    }

    if (!parsed.command || typeof parsed.command !== 'string') {
      sendError(res, ERROR_CODES.INVALID_REQUEST, 'Missing "command" field (string)', 400);
      return;
    }

    try {
      const result = await nlProcessor.processCommand(parsed.command);

      // If we got a plan and have an execution preview, attach cost estimates
      if (result.type === 'plan' && executionPreview) {
        try {
          const preview = await executionPreview.generatePreview(result.plan);
          sendSuccess(res, { ...result, preview });
          return;
        } catch (err) {
          logger.debug({ error: err }, 'Preview generation failed, returning plan without preview');
        }
      }

      sendSuccess(res, result);
    } catch (err) {
      logger.error({ error: err, command: parsed.command }, 'NL command processing failed');
      sendError(res, ERROR_CODES.INTERNAL_ERROR, 'Command processing failed', 500);
    }
  };
}
