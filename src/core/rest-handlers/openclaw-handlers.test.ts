import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { Store } from '../store.js';
import { OpenClawPlugin } from '../../openclaw/plugin.js';
import { createYieldOpportunitiesHandler } from './yield-handler.js';
import { createRiskStatusHandler } from './risk-status-handler.js';
import { createPerformanceHandler } from './performance-handler.js';
import { createDecisionsHandler } from './decisions-handler.js';
import { createDetailedHealthHandler } from './detailed-health-handler.js';
import {
  createActionsPreviewHandler,
  createActionsApproveHandler,
  createActionsDenyHandler,
} from './actions-handler.js';
import type { CyrusConfig } from '../config.js';
import type { PersistenceService } from '../persistence.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RiskDialLevel } from '../../risk/types.js';

const mockConfig = {
  mode: 'dry-run',
  tickIntervalMs: 30000,
  integrator: 'cyrus-agent',
  logLevel: 'info',
  risk: { defaultSlippage: 0.005, maxGasCostUsd: 50, maxPositionSizeUsd: 10000, maxConcurrentTransfers: 20, drawdownThreshold: 0.15 },
  chains: { enabled: [1, 42161], rpcUrls: {} },
  strategies: { enabled: ['yield-hunter'], directory: 'strategies' },
  composer: { enabled: true, supportedProtocols: [], defaultSlippage: 0.005 },
  ws: { port: 8080, enabled: true },
  rest: { port: 3001, enabled: true, corsOrigin: '*' },
  dbPath: ':memory:',
} as CyrusConfig;

const mockPersistence = {
  getActivityLog: vi.fn().mockReturnValue({ entries: [], total: 0 }),
} as unknown as PersistenceService;

// Helper to create mock request/response
function createMockReqRes(method: string, url: string, body?: string): { req: IncomingMessage; res: ServerResponse; getResponse: () => { statusCode: number; body: string } } {
  const chunks: Buffer[] = [];
  let statusCode = 200;
  let responseBody = '';

  const req = {
    method,
    url,
    headers: { host: 'localhost:3001' },
    on: vi.fn((event: string, cb: (data?: Buffer) => void) => {
      if (event === 'data' && body) {
        cb(Buffer.from(body));
      }
      if (event === 'end') {
        cb();
      }
    }),
  } as unknown as IncomingMessage;

  const res = {
    writeHead: vi.fn((code: number) => { statusCode = code; }),
    setHeader: vi.fn(),
    end: vi.fn((data: string) => { responseBody = data ?? ''; }),
  } as unknown as ServerResponse;

  return { req, res, getResponse: () => ({ statusCode, body: responseBody }) };
}

describe('Yield Opportunities Handler', () => {
  it('should return yield opportunities', async () => {
    const handler = createYieldOpportunitiesHandler();
    const { req, res, getResponse } = createMockReqRes('GET', '/api/strategies/yield/opportunities');
    await handler(req, res);
    const response = getResponse();
    const parsed = JSON.parse(response.body);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.opportunities.length).toBeGreaterThan(0);
  });

  it('should filter by token', async () => {
    const handler = createYieldOpportunitiesHandler();
    const { req, res, getResponse } = createMockReqRes('GET', '/api/strategies/yield/opportunities?token=ETH');
    await handler(req, res);
    const parsed = JSON.parse(getResponse().body);
    for (const opp of parsed.data.opportunities) {
      expect(opp.token).toBe('ETH');
    }
  });
});

describe('Risk Status Handler', () => {
  let store: Store;

  beforeEach(() => {
    store = Store.getInstance();
    store.reset();
    store = Store.getInstance();
  });

  it('should return risk status', async () => {
    const handler = createRiskStatusHandler(store);
    const { req, res, getResponse } = createMockReqRes('GET', '/api/risk/status');
    await handler(req, res);
    const parsed = JSON.parse(getResponse().body);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.currentDial).toBe(5);
    expect(parsed.data.allocation).toBeDefined();
  });

  it('should use custom dial provider', async () => {
    const handler = createRiskStatusHandler(store, () => 8 as RiskDialLevel);
    const { req, res, getResponse } = createMockReqRes('GET', '/api/risk/status');
    await handler(req, res);
    const parsed = JSON.parse(getResponse().body);
    expect(parsed.data.currentDial).toBe(8);
  });
});

describe('Performance Handler', () => {
  let store: Store;

  beforeEach(() => {
    store = Store.getInstance();
    store.reset();
    store = Store.getInstance();
  });

  it('should return strategy performance', async () => {
    const handler = createPerformanceHandler(store, mockConfig);
    const { req, res, getResponse } = createMockReqRes('GET', '/api/strategies/performance');
    await handler(req, res);
    const parsed = JSON.parse(getResponse().body);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.strategies).toHaveLength(1);
    expect(parsed.data.strategies[0].name).toBe('yield-hunter');
  });
});

describe('Decisions Handler', () => {
  let store: Store;

  beforeEach(() => {
    store = Store.getInstance();
    store.reset();
    store = Store.getInstance();
  });

  it('should return empty decisions', async () => {
    const handler = createDecisionsHandler(store);
    const { req, res, getResponse } = createMockReqRes('GET', '/api/activity/decisions');
    await handler(req, res);
    const parsed = JSON.parse(getResponse().body);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.decisions).toHaveLength(0);
  });

  it('should return decisions with reports', async () => {
    store.addReport({
      id: 'r-1',
      timestamp: Date.now(),
      strategyName: 'yield-hunter',
      narrative: 'Test decision',
      transferIds: [],
      outcome: 'positive',
      context: { regime: 'bull', actionType: 'swap', fromChain: 1, toChain: 1, tokenSymbol: 'USDC', amountUsd: 100, gasCostUsd: 5, bridgeFeeUsd: 0, slippage: 0.005 },
    });
    const handler = createDecisionsHandler(store);
    const { req, res, getResponse } = createMockReqRes('GET', '/api/activity/decisions');
    await handler(req, res);
    const parsed = JSON.parse(getResponse().body);
    expect(parsed.data.decisions).toHaveLength(1);
    expect(parsed.data.decisions[0].strategy).toBe('yield-hunter');
  });
});

describe('Detailed Health Handler', () => {
  let store: Store;

  beforeEach(() => {
    store = Store.getInstance();
    store.reset();
    store = Store.getInstance();
  });

  it('should return detailed health', async () => {
    const handler = createDetailedHealthHandler(store, {
      getTickCount: () => 50,
      isRunning: () => true,
    });
    const { req, res, getResponse } = createMockReqRes('GET', '/api/health/detailed');
    await handler(req, res);
    const parsed = JSON.parse(getResponse().body);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.status).toBe('healthy');
    expect(parsed.data.tickCount).toBe(50);
    expect(parsed.data.agentRunning).toBe(true);
  });

  it('should report critical when agent not running', async () => {
    const handler = createDetailedHealthHandler(store, {
      getTickCount: () => 0,
      isRunning: () => false,
    });
    const { req, res, getResponse } = createMockReqRes('GET', '/api/health/detailed');
    await handler(req, res);
    const parsed = JSON.parse(getResponse().body);
    expect(parsed.data.status).toBe('critical');
  });
});

describe('Actions Handlers', () => {
  let store: Store;
  let plugin: OpenClawPlugin;

  beforeEach(() => {
    store = Store.getInstance();
    store.reset();
    store = Store.getInstance();
    plugin = new OpenClawPlugin({ store, config: mockConfig, persistence: mockPersistence });
  });

  it('should create action preview via REST', async () => {
    const handler = createActionsPreviewHandler(plugin);
    const body = JSON.stringify({
      action: 'swap',
      fromChain: 1,
      toChain: 1,
      fromToken: 'USDC',
      toToken: 'ETH',
      amount: '100',
    });
    const { req, res, getResponse } = createMockReqRes('POST', '/api/actions/preview', body);
    await handler(req, res);
    const parsed = JSON.parse(getResponse().body);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.actionId).toBeDefined();
  });

  it('should approve action via REST', async () => {
    // First create a preview
    const previewHandler = createActionsPreviewHandler(plugin);
    const previewBody = JSON.stringify({
      action: 'swap',
      fromChain: 1,
      toChain: 1,
      fromToken: 'USDC',
      toToken: 'ETH',
      amount: '100',
    });
    const preview = createMockReqRes('POST', '/api/actions/preview', previewBody);
    await previewHandler(preview.req, preview.res);
    const previewParsed = JSON.parse(preview.getResponse().body);
    const actionId = previewParsed.data.actionId;

    // Then approve
    const approveHandler = createActionsApproveHandler(plugin);
    const approve = createMockReqRes('POST', `/api/actions/approve/${actionId}`);
    await approveHandler(approve.req, approve.res);
    const approveParsed = JSON.parse(approve.getResponse().body);
    expect(approveParsed.ok).toBe(true);
    expect(approveParsed.data.decision).toBe('approved');
  });

  it('should deny action via REST', async () => {
    const previewHandler = createActionsPreviewHandler(plugin);
    const previewBody = JSON.stringify({
      action: 'bridge',
      fromChain: 1,
      toChain: 42161,
      fromToken: 'USDC',
      toToken: 'USDC',
      amount: '500',
    });
    const preview = createMockReqRes('POST', '/api/actions/preview', previewBody);
    await previewHandler(preview.req, preview.res);
    const previewParsed = JSON.parse(preview.getResponse().body);
    const actionId = previewParsed.data.actionId;

    const denyHandler = createActionsDenyHandler(plugin);
    const deny = createMockReqRes('POST', `/api/actions/deny/${actionId}`);
    await denyHandler(deny.req, deny.res);
    const denyParsed = JSON.parse(deny.getResponse().body);
    expect(denyParsed.ok).toBe(true);
    expect(denyParsed.data.decision).toBe('denied');
  });

  it('should return 404 for non-existent action', async () => {
    const approveHandler = createActionsApproveHandler(plugin);
    const { req, res, getResponse } = createMockReqRes('POST', '/api/actions/approve/nonexistent');
    await approveHandler(req, res);
    const parsed = JSON.parse(getResponse().body);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe('NOT_FOUND');
  });
});
