// REST handlers: POST /api/actions/preview, POST /api/actions/approve/:id, POST /api/actions/deny/:id

import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { sendSuccess, sendError, ERROR_CODES } from '../rest-types.js';
import type { OpenClawPlugin } from '../../openclaw/plugin.js';
import type { PendingAction, ActionPreview } from '../../openclaw/types.js';

const PENDING_ACTION_TTL_MS = 5 * 60 * 1000;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

export function createActionsPreviewHandler(plugin: OpenClawPlugin) {
  return async function handleActionsPreview(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      sendError(res, ERROR_CODES.METHOD_NOT_ALLOWED, `Method ${req.method} not allowed`, 405);
      return;
    }

    let body: Record<string, unknown>;
    try {
      const raw = await readBody(req);
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      sendError(res, ERROR_CODES.VALIDATION_ERROR, 'Invalid JSON body', 400);
      return;
    }

    const action = body.action as string | undefined;
    const fromChain = body.fromChain as number | undefined;
    const toChain = body.toChain as number | undefined;
    const fromToken = body.fromToken as string | undefined;
    const toToken = body.toToken as string | undefined;
    const amount = body.amount as string | undefined;

    if (!action || !fromChain || !toChain || !fromToken || !toToken || !amount) {
      sendError(res, ERROR_CODES.VALIDATION_ERROR, 'Missing required fields: action, fromChain, toChain, fromToken, toToken, amount', 400);
      return;
    }

    const isCrossChain = fromChain !== toChain;
    const preview: ActionPreview = {
      action,
      fromChain,
      toChain,
      fromToken,
      toToken,
      fromAmount: amount,
      estimatedOutput: amount,
      estimatedGasUsd: isCrossChain ? 12 : 5,
      estimatedBridgeFeeUsd: isCrossChain ? 3 : 0,
      estimatedSlippage: 0.005,
      route: isCrossChain ? 'LI.FI Bridge' : 'LI.FI DEX Aggregation',
    };

    const now = Date.now();
    const pendingAction: PendingAction = {
      id: randomUUID(),
      tool: 'actions-preview',
      params: body,
      preview,
      createdAt: now,
      expiresAt: now + PENDING_ACTION_TTL_MS,
    };

    plugin.addPendingAction(pendingAction);
    sendSuccess(res, { actionId: pendingAction.id, preview }, 201);
  };
}

export function createActionsApproveHandler(plugin: OpenClawPlugin) {
  return async function handleActionsApprove(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      sendError(res, ERROR_CODES.METHOD_NOT_ALLOWED, `Method ${req.method} not allowed`, 405);
      return;
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const pathParts = url.pathname.split('/');
    const actionId = pathParts[pathParts.length - 1];

    if (!actionId) {
      sendError(res, ERROR_CODES.VALIDATION_ERROR, 'Missing action ID', 400);
      return;
    }

    const action = plugin.getPendingAction(actionId);
    if (!action) {
      sendError(res, ERROR_CODES.NOT_FOUND, `No pending action found: ${actionId}`, 404);
      return;
    }

    plugin.removePendingAction(actionId);
    sendSuccess(res, { actionId, decision: 'approved', preview: action.preview, status: 'queued' });
  };
}

export function createActionsDenyHandler(plugin: OpenClawPlugin) {
  return async function handleActionsDeny(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      sendError(res, ERROR_CODES.METHOD_NOT_ALLOWED, `Method ${req.method} not allowed`, 405);
      return;
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const pathParts = url.pathname.split('/');
    const actionId = pathParts[pathParts.length - 1];

    if (!actionId) {
      sendError(res, ERROR_CODES.VALIDATION_ERROR, 'Missing action ID', 400);
      return;
    }

    const action = plugin.getPendingAction(actionId);
    if (!action) {
      sendError(res, ERROR_CODES.NOT_FOUND, `No pending action found: ${actionId}`, 404);
      return;
    }

    plugin.removePendingAction(actionId);
    sendSuccess(res, { actionId, decision: 'denied', preview: action.preview });
  };
}
