import { describe, it, expect, vi } from 'vitest';
import type { ServerResponse } from 'node:http';
import { sendSuccess, sendError, ERROR_CODES } from './rest-types.js';

function createMockResponse(): ServerResponse & {
  _statusCode: number;
  _headers: Record<string, string>;
  _body: string;
} {
  const mock = {
    _statusCode: 0,
    _headers: {} as Record<string, string>,
    _body: '',
    writeHead: vi.fn(function (this: typeof mock, statusCode: number, headers?: Record<string, string>) {
      this._statusCode = statusCode;
      if (headers) {
        Object.assign(this._headers, headers);
      }
    }),
    end: vi.fn(function (this: typeof mock, body?: string) {
      this._body = body ?? '';
    }),
  };

  return mock as unknown as ServerResponse & {
    _statusCode: number;
    _headers: Record<string, string>;
    _body: string;
  };
}

describe('rest-types', () => {
  describe('sendSuccess', () => {
    it('creates correct envelope with default 200 status', () => {
      const res = createMockResponse();
      sendSuccess(res, { foo: 'bar' });

      expect(res._statusCode).toBe(200);
      expect(res._headers['Content-Type']).toBe('application/json');

      const parsed = JSON.parse(res._body);
      expect(parsed).toEqual({
        ok: true,
        data: { foo: 'bar' },
      });
    });

    it('allows custom status code', () => {
      const res = createMockResponse();
      sendSuccess(res, { created: true }, 201);

      expect(res._statusCode).toBe(201);

      const parsed = JSON.parse(res._body);
      expect(parsed.ok).toBe(true);
      expect(parsed.data.created).toBe(true);
    });

    it('serializes bigint values as strings', () => {
      const res = createMockResponse();
      sendSuccess(res, { amount: BigInt('1000000000000000000') });

      const parsed = JSON.parse(res._body);
      expect(parsed.data.amount).toBe('1000000000000000000');
    });
  });

  describe('sendError', () => {
    it('creates correct error envelope', () => {
      const res = createMockResponse();
      sendError(res, 'NOT_FOUND', 'Resource not found', 404);

      expect(res._statusCode).toBe(404);
      expect(res._headers['Content-Type']).toBe('application/json');

      const parsed = JSON.parse(res._body);
      expect(parsed).toEqual({
        ok: false,
        error: {
          code: 'NOT_FOUND',
          message: 'Resource not found',
        },
      });
    });

    it('works with different status codes', () => {
      const res = createMockResponse();
      sendError(res, 'INTERNAL_ERROR', 'Something went wrong', 500);

      expect(res._statusCode).toBe(500);
      const parsed = JSON.parse(res._body);
      expect(parsed.ok).toBe(false);
      expect(parsed.error.code).toBe('INTERNAL_ERROR');
    });
  });

  describe('ERROR_CODES', () => {
    it('has all expected values', () => {
      expect(ERROR_CODES.NOT_FOUND).toBe('NOT_FOUND');
      expect(ERROR_CODES.INVALID_REQUEST).toBe('INVALID_REQUEST');
      expect(ERROR_CODES.INTERNAL_ERROR).toBe('INTERNAL_ERROR');
      expect(ERROR_CODES.VALIDATION_ERROR).toBe('VALIDATION_ERROR');
      expect(ERROR_CODES.METHOD_NOT_ALLOWED).toBe('METHOD_NOT_ALLOWED');
    });

    it('is a frozen-like const object with 5 entries', () => {
      const keys = Object.keys(ERROR_CODES);
      expect(keys).toHaveLength(5);
    });
  });
});
