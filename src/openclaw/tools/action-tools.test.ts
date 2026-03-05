import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OpenClawPlugin } from '../plugin.js';
import { Store } from '../../core/store.js';
import { createSwapTool } from './swap-tool.js';
import { createBridgeTool } from './bridge-tool.js';
import { createYieldTool } from './yield-tool.js';
import type { CyrusConfig } from '../../core/config.js';
import type { PersistenceService } from '../../core/persistence.js';

const mockConfig = {
  mode: 'dry-run',
  tickIntervalMs: 30000,
  integrator: 'cyrus-agent',
  logLevel: 'info',
  risk: { defaultSlippage: 0.005, maxGasCostUsd: 50, maxPositionSizeUsd: 10000, maxConcurrentTransfers: 20, drawdownThreshold: 0.15 },
  chains: { enabled: [1, 42161, 10, 137, 8453, 56], rpcUrls: {} },
  strategies: { enabled: [], directory: 'strategies' },
  composer: { enabled: true, supportedProtocols: [], defaultSlippage: 0.005 },
  ws: { port: 8080, enabled: true },
  rest: { port: 3001, enabled: true, corsOrigin: '*' },
  dbPath: ':memory:',
} as CyrusConfig;

const mockPersistence = {
  getActivityLog: vi.fn().mockReturnValue({ entries: [], total: 0 }),
} as unknown as PersistenceService;

describe('Swap Tool', () => {
  let store: Store;
  let plugin: OpenClawPlugin;

  beforeEach(() => {
    store = Store.getInstance();
    store.reset();
    store = Store.getInstance();
    plugin = new OpenClawPlugin({ store, config: mockConfig, persistence: mockPersistence });
  });

  it('should create a swap preview', async () => {
    const tool = createSwapTool(plugin);
    const result = await tool.handler({ fromToken: 'USDC', toToken: 'ETH', amount: '100' });
    expect(result.success).toBe(true);
    expect(result.message).toContain('Swap preview');
    expect(result.message).toContain('USDC');
    expect(result.message).toContain('ETH');
    const data = result.data as { actionId: string };
    expect(data.actionId).toBeDefined();
    expect(plugin.getPendingAction(data.actionId)).toBeDefined();
  });

  it('should use custom chain and slippage', async () => {
    const tool = createSwapTool(plugin);
    const result = await tool.handler({
      fromToken: 'USDC',
      toToken: 'WETH',
      amount: '500',
      chainId: 42161,
      slippage: 0.01,
    });
    expect(result.success).toBe(true);
    const data = result.data as { preview: { fromChain: number; estimatedSlippage: number } };
    expect(data.preview.fromChain).toBe(42161);
    expect(data.preview.estimatedSlippage).toBe(0.01);
  });
});

describe('Bridge Tool', () => {
  let store: Store;
  let plugin: OpenClawPlugin;

  beforeEach(() => {
    store = Store.getInstance();
    store.reset();
    store = Store.getInstance();
    plugin = new OpenClawPlugin({ store, config: mockConfig, persistence: mockPersistence });
  });

  it('should create a bridge preview', async () => {
    const tool = createBridgeTool(plugin);
    const result = await tool.handler({
      fromChain: 1,
      toChain: 42161,
      token: 'USDC',
      amount: '1000',
    });
    expect(result.success).toBe(true);
    expect(result.message).toContain('Bridge preview');
    expect(result.message).toContain('Ethereum');
    expect(result.message).toContain('Arbitrum');
    const data = result.data as { actionId: string };
    expect(plugin.getPendingAction(data.actionId)).toBeDefined();
  });

  it('should reject same-chain bridge', async () => {
    const tool = createBridgeTool(plugin);
    const result = await tool.handler({
      fromChain: 1,
      toChain: 1,
      token: 'USDC',
      amount: '100',
    });
    expect(result.success).toBe(false);
    expect(result.message).toContain('must be different');
  });

  it('should reject unsupported chains', async () => {
    const tool = createBridgeTool(plugin);
    const result = await tool.handler({
      fromChain: 1,
      toChain: 99999,
      token: 'USDC',
      amount: '100',
    });
    expect(result.success).toBe(false);
    expect(result.message).toContain('not enabled');
  });
});

describe('Yield Tool', () => {
  let store: Store;
  let plugin: OpenClawPlugin;

  beforeEach(() => {
    store = Store.getInstance();
    store.reset();
    store = Store.getInstance();
    plugin = new OpenClawPlugin({ store, config: mockConfig, persistence: mockPersistence });
  });

  it('should return all yield opportunities', async () => {
    const tool = createYieldTool(plugin);
    const result = await tool.handler({});
    expect(result.success).toBe(true);
    const data = result.data as { count: number; opportunities: unknown[] };
    expect(data.count).toBeGreaterThan(0);
    expect(data.opportunities.length).toBe(data.count);
  });

  it('should filter by token', async () => {
    const tool = createYieldTool(plugin);
    const result = await tool.handler({ token: 'ETH' });
    expect(result.success).toBe(true);
    const data = result.data as { opportunities: Array<{ token: string }> };
    for (const o of data.opportunities) {
      expect(o.token).toBe('ETH');
    }
  });

  it('should filter by minimum APY', async () => {
    const tool = createYieldTool(plugin);
    const result = await tool.handler({ minApy: 5 });
    expect(result.success).toBe(true);
    const data = result.data as { opportunities: Array<{ apy: number }> };
    for (const o of data.opportunities) {
      expect(o.apy).toBeGreaterThanOrEqual(5);
    }
  });

  it('should filter by risk level', async () => {
    const tool = createYieldTool(plugin);
    const result = await tool.handler({ risk: 'low' });
    expect(result.success).toBe(true);
    const data = result.data as { opportunities: Array<{ risk: string }> };
    for (const o of data.opportunities) {
      expect(o.risk).toBe('low');
    }
  });

  it('should sort by APY descending', async () => {
    const tool = createYieldTool(plugin);
    const result = await tool.handler({});
    const data = result.data as { opportunities: Array<{ apy: number }> };
    for (let i = 1; i < data.opportunities.length; i++) {
      expect(data.opportunities[i - 1].apy).toBeGreaterThanOrEqual(data.opportunities[i].apy);
    }
  });
});
