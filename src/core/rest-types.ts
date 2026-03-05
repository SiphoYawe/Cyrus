import type { ServerResponse } from 'node:http';

// --- Response envelopes ---

export interface SuccessResponse<T> {
  ok: true;
  data: T;
}

export interface ErrorResponse {
  ok: false;
  error: {
    code: string;
    message: string;
  };
}

export const ERROR_CODES = {
  NOT_FOUND: 'NOT_FOUND',
  INVALID_REQUEST: 'INVALID_REQUEST',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  METHOD_NOT_ALLOWED: 'METHOD_NOT_ALLOWED',
  FORBIDDEN: 'FORBIDDEN',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

// --- Response helpers ---

export function sendSuccess<T>(res: ServerResponse, data: T, statusCode: number = 200): void {
  const body: SuccessResponse<T> = { ok: true, data };
  const json = JSON.stringify(body, bigIntReplacer);
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(json);
}

export function sendError(res: ServerResponse, code: string, message: string, statusCode: number): void {
  const body: ErrorResponse = { ok: false, error: { code, message } };
  const json = JSON.stringify(body);
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(json);
}

// BigInt cannot be serialized by JSON.stringify by default
function bigIntReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  return value;
}
