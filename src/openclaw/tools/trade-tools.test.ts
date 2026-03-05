import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OpenClawPlugin } from '../plugin.js';
import { Store } from '../../core/store.js';
import { createTradePreviewTool } from './trade-preview-tool.js';
import { createTradeApproveTool } from './trade-approve-tool.js';
import type { CyrusConfig } from '../../core/config.js';
import type { PersistenceService } from '../../core/persistence.js';

const mockConfig = {
  mode: 'dry-run',
  tickIntervalMs: 30000,
  integrator: 'cyrus-agent',
  logLevel: 'info',
  risk: { defaultSlippage: 0.005, maxGasCostUsd: 50, maxPositionSizeUsd: 10000, maxConcurrentTransfers: 20, drawdownThreshold: 0.15 },
  chains: { enabled: [1, 42161], rpcUrls: {} },
  strategies: { enabled: [], directory: 'strategies' },
  composer: { enabled: true, supportedProtocols: [], defaultSlippage: 0.005 },
  ws: { port: 8080, enabled: true },
  rest: { port: 3001, enabled: true, corsOrigin: '*' },
  dbPath: ':memory:',
} as CyrusConfig;

const mockPersistence = {
  getActivityLog: vi.fn().mockReturnValue({ entries: [], total: 0 }),
} as unknown as PersistenceService;

describe('Trade Preview Tool', () => {
  let store: Store;
  let plugin: OpenClawPlugin;

  beforeEach(() => {
    store = Store.getInstance();
    store.reset();
    store = Store.getInstance();
    plugin = new OpenClawPlugin({ store, config: mockConfig, persistence: mockPersistence });
  });

  it('should create a swap preview', async () => {
    const tool = createTradePreviewTool(plugin);
    const result = await tool.handler({
      action: 'swap',
      fromChain: 1,
      toChain: 1,
      fromToken: 'USDC',
      toToken: 'ETH',
      amount: '1000',
    });
    expect(result.success).toBe(true);
    expect(result.message).toContain('Trade preview');
    const data = result.data as { actionId: string; estimatedCost: { bridgeFeeUsd: number } };
    expect(data.actionId).toBeDefined();
    expect(data.estimatedCost.bridgeFeeUsd).toBe(0);
    expect(plugin.getPendingAction(data.actionId)).toBeDefined();
  });

  it('should create a cross-chain bridge preview with bridge fee', async () => {
    const tool = createTradePreviewTool(plugin);
    const result = await tool.handler({
      action: 'bridge',
      fromChain: 1,
      toChain: 42161,
      fromToken: 'USDC',
      toToken: 'USDC',
      amount: '500',
    });
    expect(result.success).toBe(true);
    const data = result.data as { estimatedCost: { bridgeFeeUsd: number; gasUsd: number } };
    expect(data.estimatedCost.bridgeFeeUsd).toBeGreaterThan(0);
    expect(data.estimatedCost.gasUsd).toBeGreaterThan(0);
  });

  it('should create a deposit preview with Composer route', async () => {
    const tool = createTradePreviewTool(plugin);
    const result = await tool.handler({
      action: 'deposit',
      fromChain: 1,
      toChain: 42161,
      fromToken: 'USDC',
      toToken: 'aUSDC',
      amount: '1000',
    });
    expect(result.success).toBe(true);
    const data = result.data as { preview: { route: string } };
    expect(data.preview.route).toContain('Composer');
  });

  it('should reject invalid action type', async () => {
    const tool = createTradePreviewTool(plugin);
    const result = await tool.handler({
      action: 'invalid',
      fromChain: 1,
      toChain: 1,
      fromToken: 'USDC',
      toToken: 'ETH',
      amount: '100',
    });
    expect(result.success).toBe(false);
    expect(result.message).toContain('Invalid action');
  });
});

describe('Trade Approve Tool', () => {
  let store: Store;
  let plugin: OpenClawPlugin;

  beforeEach(() => {
    store = Store.getInstance();
    store.reset();
    store = Store.getInstance();
    plugin = new OpenClawPlugin({ store, config: mockConfig, persistence: mockPersistence });
  });

  it('should approve a pending action', async () => {
    // First create a preview
    const previewTool = createTradePreviewTool(plugin);
    const previewResult = await previewTool.handler({
      action: 'swap',
      fromChain: 1,
      toChain: 1,
      fromToken: 'USDC',
      toToken: 'ETH',
      amount: '100',
    });
    const actionId = (previewResult.data as { actionId: string }).actionId;

    // Then approve it
    const approveTool = createTradeApproveTool(plugin);
    const result = await approveTool.handler({ actionId, decision: 'approve' });
    expect(result.success).toBe(true);
    expect(result.message).toContain('approved');
    const data = result.data as { decision: string; status: string };
    expect(data.decision).toBe('approved');
    expect(data.status).toBe('queued');

    // Action should be removed
    expect(plugin.getPendingAction(actionId)).toBeUndefined();
  });

  it('should deny a pending action', async () => {
    const previewTool = createTradePreviewTool(plugin);
    const previewResult = await previewTool.handler({
      action: 'bridge',
      fromChain: 1,
      toChain: 42161,
      fromToken: 'USDC',
      toToken: 'USDC',
      amount: '500',
    });
    const actionId = (previewResult.data as { actionId: string }).actionId;

    const approveTool = createTradeApproveTool(plugin);
    const result = await approveTool.handler({ actionId, decision: 'deny' });
    expect(result.success).toBe(true);
    expect(result.message).toContain('denied');
  });

  it('should fail for non-existent action', async () => {
    const approveTool = createTradeApproveTool(plugin);
    const result = await approveTool.handler({ actionId: 'nonexistent', decision: 'approve' });
    expect(result.success).toBe(false);
    expect(result.message).toContain('No pending action');
  });

  it('should reject invalid decision', async () => {
    const approveTool = createTradeApproveTool(plugin);
    const result = await approveTool.handler({ actionId: 'test', decision: 'maybe' });
    expect(result.success).toBe(false);
    expect(result.message).toContain('approve" or "deny"');
  });
});
