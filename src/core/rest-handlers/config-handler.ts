import type { IncomingMessage, ServerResponse } from 'node:http';
import { redactConfig } from '../config.js';
import { sendSuccess, sendError, ERROR_CODES } from '../rest-types.js';
import { ConfigManager, SecretsBlockedError } from '../config-manager.js';
import type { AgentWebSocketServer } from '../ws-server.js';
import { createEventEnvelope, WS_EVENT_TYPES } from '../ws-types.js';
import { ZodError } from 'zod';

export function createConfigHandler(
  configManager: ConfigManager,
  wsServer?: AgentWebSocketServer,
) {
  return async function handleConfig(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === 'GET') {
      const config = configManager.getConfig();
      const redacted = redactConfig(config);
      const envOverrides = Array.from(configManager.getEnvOverrides());
      const secretsConfigured = configManager.getSecretsConfigured();
      sendSuccess(res, { ...redacted, envOverrides, secretsConfigured });
      return;
    }

    if (req.method === 'PATCH') {
      let body: Record<string, unknown>;

      try {
        body = await parseJsonBody(req);
      } catch {
        sendError(res, ERROR_CODES.VALIDATION_ERROR, 'Invalid JSON body', 400);
        return;
      }

      try {
        const { config, requiresRestart } = configManager.updateConfig(body);
        const redacted = redactConfig(config);
        const envOverrides = Array.from(configManager.getEnvOverrides());
        const secretsConfigured = configManager.getSecretsConfigured();
        const responseData = { ...redacted, envOverrides, secretsConfigured, requiresRestart };

        sendSuccess(res, responseData);

        // Broadcast config.updated to all WS clients
        if (wsServer) {
          wsServer.broadcast(createEventEnvelope(WS_EVENT_TYPES.CONFIG_UPDATED, redacted));
        }
      } catch (err) {
        if (err instanceof SecretsBlockedError) {
          sendError(res, ERROR_CODES.FORBIDDEN, err.message, 400);
          return;
        }
        if (err instanceof ZodError) {
          const message = err.issues[0]?.message ?? 'Validation failed';
          sendError(res, ERROR_CODES.VALIDATION_ERROR, message, 400);
          return;
        }
        sendError(res, ERROR_CODES.INTERNAL_ERROR, 'Config update failed', 500);
      }
      return;
    }

    sendError(res, ERROR_CODES.METHOD_NOT_ALLOWED, `Method ${req.method} not allowed`, 405);
  };
}

function parseJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf-8');
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        resolve(parsed);
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}
