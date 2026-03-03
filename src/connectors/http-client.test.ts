import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LiFiQuoteError, RateLimitError, CyrusError } from '../utils/errors.js';

// Mock the sleep module to avoid real delays during retries
vi.mock('../utils/sleep.js', () => ({
  sleep: vi.fn().mockResolvedValue(undefined),
}));

// Import after mock is set up
const { LiFiHttpClient } = await import('./http-client.js');

// Mock fetch response helper
function mockResponse(status: number, body: unknown, ok?: boolean): Response {
  return {
    ok: ok ?? (status >= 200 && status < 300),
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
    headers: new Headers(),
    redirected: false,
    statusText: status === 200 ? 'OK' : 'Error',
    type: 'basic' as ResponseType,
    url: '',
    clone: () => mockResponse(status, body, ok),
    body: null,
    bodyUsed: false,
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    blob: () => Promise.resolve(new Blob()),
    formData: () => Promise.resolve(new FormData()),
    bytes: () => Promise.resolve(new Uint8Array()),
  } as Response;
}

describe('LiFiHttpClient', () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  let client: InstanceType<typeof LiFiHttpClient>;

  beforeEach(() => {
    mockFetch = vi.fn();
    client = new LiFiHttpClient({
      baseUrl: 'https://test.li.quest/v1',
      fetchFn: mockFetch as unknown as typeof globalThis.fetch,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('GET requests', () => {
    it('makes a GET request to the correct URL', async () => {
      mockFetch.mockResolvedValue(mockResponse(200, { result: 'ok' }));

      const result = await client.get<{ result: string }>('/chains');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://test.li.quest/v1/chains');
      expect(options.method).toBe('GET');
      expect(result.result).toBe('ok');
    });

    it('appends query parameters to the URL', async () => {
      mockFetch.mockResolvedValue(mockResponse(200, { result: 'ok' }));

      await client.get('/tokens', { chains: 1, limit: 100 });

      const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
      const parsed = new URL(url);
      expect(parsed.searchParams.get('chains')).toBe('1');
      expect(parsed.searchParams.get('limit')).toBe('100');
    });

    it('skips undefined query parameters', async () => {
      mockFetch.mockResolvedValue(mockResponse(200, { result: 'ok' }));

      await client.get('/tokens', { chains: 1, limit: undefined });

      const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
      const parsed = new URL(url);
      expect(parsed.searchParams.get('chains')).toBe('1');
      expect(parsed.searchParams.has('limit')).toBe(false);
    });

    it('includes API key header when configured', async () => {
      const clientWithKey = new LiFiHttpClient({
        baseUrl: 'https://test.li.quest/v1',
        apiKey: 'test-api-key',
        fetchFn: mockFetch as unknown as typeof globalThis.fetch,
      });

      mockFetch.mockResolvedValue(mockResponse(200, { result: 'ok' }));

      await clientWithKey.get('/chains');

      const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      const headers = options.headers as Record<string, string>;
      expect(headers['x-lifi-api-key']).toBe('test-api-key');
    });

    it('does not include API key header when not configured', async () => {
      mockFetch.mockResolvedValue(mockResponse(200, { result: 'ok' }));

      await client.get('/chains');

      const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      const headers = options.headers as Record<string, string>;
      expect(headers['x-lifi-api-key']).toBeUndefined();
    });
  });

  describe('POST requests', () => {
    it('makes a POST request with JSON body', async () => {
      mockFetch.mockResolvedValue(mockResponse(200, { routes: [] }));

      const body = { fromChainId: 1, toChainId: 42161 };
      const result = await client.post<{ routes: unknown[] }>('/advanced/routes', body);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://test.li.quest/v1/advanced/routes');
      expect(options.method).toBe('POST');
      expect(options.body).toBe(JSON.stringify(body));
      expect(result.routes).toEqual([]);
    });
  });

  describe('error handling', () => {
    it('throws LiFiQuoteError on 400', async () => {
      mockFetch.mockResolvedValue(mockResponse(400, { message: 'Bad request' }));

      await expect(client.get('/quote')).rejects.toThrow(LiFiQuoteError);
    });

    it('throws LiFiQuoteError on 404', async () => {
      mockFetch.mockResolvedValue(mockResponse(404, { message: 'Not found' }));

      await expect(client.get('/quote')).rejects.toThrow(LiFiQuoteError);
    });

    it('throws RateLimitError on 429 and retries', async () => {
      // All attempts return 429 — sleep is mocked so no real delay
      mockFetch.mockResolvedValue(mockResponse(429, { message: 'Rate limited' }));

      await expect(client.get('/quote')).rejects.toThrow(RateLimitError);

      // First call (1) throws RateLimitError, then withRetry does initial (1) + 5 retries = 7 total
      expect(mockFetch.mock.calls.length).toBe(7);
    });

    it('throws CyrusError on 500 and retries once', async () => {
      mockFetch.mockResolvedValue(mockResponse(500, { message: 'Internal error' }));

      await expect(client.get('/quote')).rejects.toThrow(CyrusError);

      // First call (1) throws CyrusError → withRetry initial (1) + 1 retry = 3 total
      expect(mockFetch.mock.calls.length).toBe(3);
    });

    it('does not retry on 400 (non-retryable)', async () => {
      mockFetch.mockResolvedValue(mockResponse(400, { message: 'Bad params' }));

      await expect(client.get('/quote')).rejects.toThrow(LiFiQuoteError);

      // Only 1 call, no retries
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('recovers on retry when subsequent request succeeds after 500', async () => {
      mockFetch
        .mockResolvedValueOnce(mockResponse(500, { message: 'error' }))
        .mockResolvedValueOnce(mockResponse(200, { result: 'recovered' }));

      const result = await client.get<{ result: string }>('/quote');
      expect(result.result).toBe('recovered');
    });

    it('recovers on retry when 429 then succeeds', async () => {
      mockFetch
        .mockResolvedValueOnce(mockResponse(429, { message: 'rate limited' }))
        .mockResolvedValueOnce(mockResponse(200, { result: 'ok' }));

      const result = await client.get<{ result: string }>('/quote');
      expect(result.result).toBe('ok');
    });
  });
});
