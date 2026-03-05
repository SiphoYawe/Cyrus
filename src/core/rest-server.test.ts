import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AgentRestServer } from './rest-server.js';
import { Store } from './store.js';
import { PersistenceService } from './persistence.js';
import { CyrusConfigSchema } from './config.js';
import { chainId, tokenAddress } from './types.js';

function makeTestDeps() {
  const store = Store.getInstance();
  const persistence = new PersistenceService(':memory:', store);
  const config = CyrusConfigSchema.parse({});

  return { store, persistence, config };
}

async function fetchJson(port: number, path: string, method: string = 'GET') {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method });
  const body = await res.json();
  return { status: res.status, headers: res.headers, body };
}

describe('AgentRestServer', () => {
  let server: AgentRestServer;
  let store: Store;
  let persistence: PersistenceService;

  beforeEach(async () => {
    const deps = makeTestDeps();
    store = deps.store;
    persistence = deps.persistence;

    server = new AgentRestServer({
      port: 0,
      corsOrigin: '*',
      store: deps.store,
      persistence: deps.persistence,
      config: deps.config,
      agent: { getTickCount: () => 0, isRunning: () => true },
    });

    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    persistence.close();
    store.reset();
  });

  // --- Health ---

  it('GET /api/health returns correct format', async () => {
    const { status, body } = await fetchJson(server.boundPort, '/api/health');

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe('healthy');
    expect(typeof body.data.uptime).toBe('number');
    expect(body.data.version).toBe('1.0.0');
    expect(body.data.tickCount).toBe(0);
  });

  // --- Portfolio ---

  it('GET /api/portfolio returns empty balances when store is empty', async () => {
    const { status, body } = await fetchJson(server.boundPort, '/api/portfolio');

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data.balances).toEqual([]);
    expect(body.data.totalUsdValue).toBe(0);
    expect(body.data.chainAllocation).toEqual([]);
    expect(body.data.inFlightTransfers.count).toBe(0);
    expect(body.data.inFlightTransfers.transfers).toEqual([]);
  });

  it('GET /api/portfolio returns balances with chain allocation', async () => {
    store.setBalance(chainId(1), tokenAddress('0x0000000000000000000000000000000000000001'), 1000n, 100.5, 'USDC', 6);
    store.setBalance(chainId(42161), tokenAddress('0x0000000000000000000000000000000000000002'), 2000n, 200.0, 'WETH', 18);

    const { status, body } = await fetchJson(server.boundPort, '/api/portfolio');

    expect(status).toBe(200);
    expect(body.data.balances).toHaveLength(2);
    expect(body.data.totalUsdValue).toBeCloseTo(300.5);
    expect(body.data.chainAllocation).toHaveLength(2);

    // Check chain allocation percentages sum to ~1
    const totalPct = body.data.chainAllocation.reduce(
      (sum: number, a: { percentage: number }) => sum + a.percentage,
      0,
    );
    expect(totalPct).toBeCloseTo(1.0);
  });

  it('GET /api/portfolio includes in-flight transfers', async () => {
    store.createTransfer({
      txHash: '0xabc',
      fromChain: chainId(1),
      toChain: chainId(42161),
      fromToken: tokenAddress('0x0000000000000000000000000000000000000001'),
      toToken: tokenAddress('0x0000000000000000000000000000000000000002'),
      amount: 5000n,
      bridge: 'stargate',
      quoteData: {},
    });

    const { body } = await fetchJson(server.boundPort, '/api/portfolio');

    expect(body.data.inFlightTransfers.count).toBe(1);
    expect(body.data.inFlightTransfers.transfers[0].bridge).toBe('stargate');
    expect(body.data.inFlightTransfers.transfers[0].fromChain).toBe(1);
    expect(body.data.inFlightTransfers.transfers[0].toChain).toBe(42161);
  });

  // --- Activity ---

  it('GET /api/activity returns empty activities with pagination', async () => {
    const { status, body } = await fetchJson(server.boundPort, '/api/activity');

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data.activities).toEqual([]);
    expect(body.data.pagination).toEqual({
      total: 0,
      limit: 50,
      offset: 0,
      hasMore: false,
    });
  });

  it('GET /api/activity respects limit and offset query params', async () => {
    // Insert some activity records directly
    for (let i = 0; i < 5; i++) {
      persistence.logActivity({
        id: `act-${i}`,
        timestamp: new Date().toISOString(),
        chainId: chainId(1),
        fromToken: tokenAddress('0x0000000000000000000000000000000000000001'),
        toToken: tokenAddress('0x0000000000000000000000000000000000000002'),
        fromAmount: '100',
        toAmount: '99',
        txHash: `0x${i.toString(16).padStart(64, '0')}`,
        decisionReportId: null,
        actionType: 'transfer',
        createdAt: new Date().toISOString(),
      });
    }

    const { body } = await fetchJson(server.boundPort, '/api/activity?limit=2&offset=1');

    expect(body.data.activities).toHaveLength(2);
    expect(body.data.pagination.limit).toBe(2);
    expect(body.data.pagination.offset).toBe(1);
    expect(body.data.pagination.total).toBe(5);
    expect(body.data.pagination.hasMore).toBe(true);
  });

  it('GET /api/activity returns 400 for invalid limit', async () => {
    const { status, body } = await fetchJson(server.boundPort, '/api/activity?limit=-1');

    expect(status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('GET /api/activity returns 400 for invalid offset', async () => {
    const { status, body } = await fetchJson(server.boundPort, '/api/activity?offset=abc');

    expect(status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  // --- Strategies ---

  it('GET /api/strategies returns empty array', async () => {
    const { status, body } = await fetchJson(server.boundPort, '/api/strategies');

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data).toEqual([]);
  });

  // --- Config ---

  it('GET /api/config returns config with secrets redacted', async () => {
    const { status, body } = await fetchJson(server.boundPort, '/api/config');

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data.privateKey).toBe('[REDACTED]');
    expect(body.data.lifiApiKey).toBe('[REDACTED]');
    expect(body.data.anthropicApiKey).toBe('[REDACTED]');
    // Non-secret fields should be present
    expect(body.data.mode).toBe('dry-run');
    expect(typeof body.data.tickIntervalMs).toBe('number');
  });

  // --- Error handling ---

  it('returns 404 for unknown route', async () => {
    const { status, body } = await fetchJson(server.boundPort, '/api/unknown');

    expect(status).toBe(404);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.message).toBe('Endpoint not found');
  });

  it('returns 405 for wrong method (POST to GET-only endpoint)', async () => {
    const { status, body } = await fetchJson(server.boundPort, '/api/health', 'POST');

    expect(status).toBe(405);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('METHOD_NOT_ALLOWED');
  });

  // --- CORS ---

  it('includes CORS headers on responses', async () => {
    const res = await fetch(`http://127.0.0.1:${server.boundPort}/api/health`);

    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-methods')).toBe('GET, POST, OPTIONS');
    expect(res.headers.get('access-control-allow-headers')).toBe('Content-Type');
  });

  it('handles OPTIONS preflight with 204', async () => {
    const res = await fetch(`http://127.0.0.1:${server.boundPort}/api/health`, {
      method: 'OPTIONS',
    });

    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  // --- Server lifecycle ---

  it('server starts and responds', async () => {
    // The server is already started in beforeEach, so just verify it works
    const res = await fetch(`http://127.0.0.1:${server.boundPort}/api/health`);
    expect(res.ok).toBe(true);
  });

  it('boundPort returns a valid port number', () => {
    expect(server.boundPort).toBeGreaterThan(0);
    expect(server.boundPort).toBeLessThanOrEqual(65535);
  });
});
