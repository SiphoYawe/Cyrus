import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OpenClawPlugin } from './plugin.js';
import { Store } from '../core/store.js';
import type { OpenClawToolDefinition, PendingAction } from './types.js';
import type { CyrusConfig } from '../core/config.js';
import type { PersistenceService } from '../core/persistence.js';

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

describe('OpenClawPlugin', () => {
  let store: Store;
  let plugin: OpenClawPlugin;

  beforeEach(() => {
    store = Store.getInstance();
    store.reset();
    store = Store.getInstance();
    plugin = new OpenClawPlugin({
      store,
      config: mockConfig,
      persistence: mockPersistence,
      agent: { getTickCount: () => 42, isRunning: () => true },
    });
  });

  it('should register and retrieve tools', () => {
    const tool: OpenClawToolDefinition = {
      name: 'test-tool',
      description: 'A test tool',
      parameters: [],
      handler: async () => ({ success: true, message: 'ok' }),
    };

    plugin.registerTool(tool);
    expect(plugin.getTools()).toHaveLength(1);
    expect(plugin.getTool('test-tool')).toBeDefined();
    expect(plugin.getTool('nonexistent')).toBeUndefined();
  });

  it('should invoke a registered tool', async () => {
    const handler = vi.fn().mockResolvedValue({ success: true, message: 'done', data: { value: 123 } });
    plugin.registerTool({
      name: 'echo',
      description: 'Echo tool',
      parameters: [{ name: 'input', type: 'string', description: 'Input', required: true }],
      handler,
    });

    const result = await plugin.invokeTool('echo', { input: 'hello' });
    expect(result.success).toBe(true);
    expect(result.message).toBe('done');
    expect(handler).toHaveBeenCalledWith({ input: 'hello' });
  });

  it('should return error for unknown tool', async () => {
    const result = await plugin.invokeTool('nonexistent', {});
    expect(result.success).toBe(false);
    expect(result.message).toContain('Unknown tool');
  });

  it('should validate required parameters', async () => {
    plugin.registerTool({
      name: 'strict',
      description: 'Strict params',
      parameters: [{ name: 'required_param', type: 'string', description: 'Required', required: true }],
      handler: async () => ({ success: true, message: 'ok' }),
    });

    const result = await plugin.invokeTool('strict', {});
    expect(result.success).toBe(false);
    expect(result.message).toContain('Missing required parameter');
  });

  it('should handle tool handler errors gracefully', async () => {
    plugin.registerTool({
      name: 'failing',
      description: 'Fails',
      parameters: [],
      handler: async () => { throw new Error('boom'); },
    });

    const result = await plugin.invokeTool('failing', {});
    expect(result.success).toBe(false);
    expect(result.message).toBe('boom');
  });

  it('should manage pending actions', () => {
    const action: PendingAction = {
      id: 'action-1',
      tool: 'swap',
      params: {},
      preview: {
        action: 'swap',
        fromChain: 1,
        toChain: 42161,
        fromToken: 'USDC',
        toToken: 'USDC',
        fromAmount: '100',
        estimatedOutput: '99.5',
        estimatedGasUsd: 2,
        estimatedBridgeFeeUsd: 0.5,
        estimatedSlippage: 0.005,
        route: 'Stargate',
      },
      createdAt: Date.now(),
      expiresAt: Date.now() + 300_000,
    };

    plugin.addPendingAction(action);
    expect(plugin.getPendingAction('action-1')).toBeDefined();
    expect(plugin.getAllPendingActions()).toHaveLength(1);

    plugin.removePendingAction('action-1');
    expect(plugin.getPendingAction('action-1')).toBeUndefined();
  });

  it('should prune expired pending actions', () => {
    const action: PendingAction = {
      id: 'expired-1',
      tool: 'swap',
      params: {},
      preview: {
        action: 'swap',
        fromChain: 1,
        toChain: 42161,
        fromToken: 'USDC',
        toToken: 'USDC',
        fromAmount: '100',
        estimatedOutput: '99.5',
        estimatedGasUsd: 2,
        estimatedBridgeFeeUsd: 0.5,
        estimatedSlippage: 0.005,
        route: 'Stargate',
      },
      createdAt: Date.now() - 600_000,
      expiresAt: Date.now() - 1, // Already expired
    };

    plugin.addPendingAction(action);
    expect(plugin.getPendingAction('expired-1')).toBeUndefined();
    expect(plugin.getAllPendingActions()).toHaveLength(0);
  });

  it('should build heartbeat status', () => {
    const status = plugin.getHeartbeatStatus();
    expect(status.agentRunning).toBe(true);
    expect(status.tickCount).toBe(42);
    expect(status.activeTransfers).toBe(0);
    expect(status.openPositions).toBe(0);
    expect(status.totalPortfolioUsd).toBe(0);
    expect(typeof status.timestamp).toBe('number');
  });

  it('should reset plugin state', () => {
    plugin.registerTool({
      name: 'tool-1',
      description: 'Tool 1',
      parameters: [],
      handler: async () => ({ success: true, message: 'ok' }),
    });
    expect(plugin.getTools()).toHaveLength(1);

    plugin.reset();
    expect(plugin.getTools()).toHaveLength(0);
  });
});
