import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OpenClawPlugin } from '../plugin.js';
import { Store } from '../../core/store.js';
import { createRiskDialTool } from './risk-dial-tool.js';
import { createHeartbeatTool } from './heartbeat-tool.js';
import { createReportTool } from './report-tool.js';
import type { CyrusConfig } from '../../core/config.js';
import type { PersistenceService } from '../../core/persistence.js';
import type { DecisionReport } from '../../ai/types.js';

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

describe('Risk Dial Tool', () => {
  let store: Store;
  let plugin: OpenClawPlugin;

  beforeEach(() => {
    store = Store.getInstance();
    store.reset();
    store = Store.getInstance();
    plugin = new OpenClawPlugin({ store, config: mockConfig, persistence: mockPersistence });
  });

  it('should view current risk dial', async () => {
    const tool = createRiskDialTool(plugin);
    const result = await tool.handler({});
    expect(result.success).toBe(true);
    expect(result.message).toContain('5/10');
    const data = result.data as { currentDial: number };
    expect(data.currentDial).toBe(5);
  });

  it('should change risk dial level', async () => {
    const tool = createRiskDialTool(plugin);
    const result = await tool.handler({ level: 8 });
    expect(result.success).toBe(true);
    expect(result.message).toContain('5 → 8');
    const data = result.data as { oldDial: number; newDial: number };
    expect(data.oldDial).toBe(5);
    expect(data.newDial).toBe(8);
  });

  it('should reject invalid dial level', async () => {
    const tool = createRiskDialTool(plugin);
    const result = await tool.handler({ level: 15 });
    expect(result.success).toBe(false);
    expect(result.message).toContain('between 1 and 10');
  });

  it('should reject non-integer dial level', async () => {
    const tool = createRiskDialTool(plugin);
    const result = await tool.handler({ level: 3.5 });
    expect(result.success).toBe(false);
  });
});

describe('Heartbeat Tool', () => {
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
      agent: { getTickCount: () => 100, isRunning: () => true },
    });
  });

  it('should return heartbeat status', async () => {
    const tool = createHeartbeatTool(plugin);
    const result = await tool.handler({});
    expect(result.success).toBe(true);
    expect(result.message).toContain('running');
    expect(result.message).toContain('Ticks: 100');
    const data = result.data as { agentRunning: boolean; tickCount: number };
    expect(data.agentRunning).toBe(true);
    expect(data.tickCount).toBe(100);
  });
});

describe('Report Tool', () => {
  let store: Store;
  let plugin: OpenClawPlugin;

  beforeEach(() => {
    store = Store.getInstance();
    store.reset();
    store = Store.getInstance();
    plugin = new OpenClawPlugin({ store, config: mockConfig, persistence: mockPersistence });
  });

  it('should return empty reports', async () => {
    const tool = createReportTool(plugin);
    const result = await tool.handler({});
    expect(result.success).toBe(true);
    expect(result.message).toContain('0 report(s)');
  });

  it('should return reports with stats', async () => {
    const report: DecisionReport = {
      id: 'report-1',
      timestamp: Date.now(),
      strategyName: 'yield-hunter',
      narrative: 'Moved 100 USDC from Ethereum to Arbitrum for higher yield',
      transferIds: ['tx-1'],
      outcome: 'positive',
      context: {
        regime: 'bull',
        actionType: 'bridge',
        fromChain: 1,
        toChain: 42161,
        tokenSymbol: 'USDC',
        amountUsd: 100,
        gasCostUsd: 5,
        bridgeFeeUsd: 2,
        slippage: 0.005,
      },
    };
    store.addReport(report);

    const tool = createReportTool(plugin);
    const result = await tool.handler({});
    expect(result.success).toBe(true);
    expect(result.message).toContain('1 report(s)');
    expect(result.message).toContain('1 positive');
    const data = result.data as { stats: { positive: number } };
    expect(data.stats.positive).toBe(1);
  });

  it('should filter by strategy', async () => {
    store.addReport({
      id: 'r-1',
      timestamp: Date.now(),
      strategyName: 'yield-hunter',
      narrative: 'Yield move',
      transferIds: [],
      outcome: 'positive',
      context: { regime: 'bull', actionType: 'swap', fromChain: 1, toChain: 1, tokenSymbol: 'USDC', amountUsd: 50, gasCostUsd: 2, bridgeFeeUsd: 0, slippage: 0.005 },
    });
    store.addReport({
      id: 'r-2',
      timestamp: Date.now(),
      strategyName: 'arb',
      narrative: 'Arb trade',
      transferIds: [],
      outcome: 'negative',
      context: { regime: 'crab', actionType: 'swap', fromChain: 1, toChain: 1, tokenSymbol: 'ETH', amountUsd: 200, gasCostUsd: 10, bridgeFeeUsd: 0, slippage: 0.005 },
    });

    const tool = createReportTool(plugin);
    const result = await tool.handler({ strategy: 'yield-hunter' });
    expect(result.success).toBe(true);
    const data = result.data as { reports: Array<{ strategy: string }> };
    expect(data.reports).toHaveLength(1);
    expect(data.reports[0].strategy).toBe('yield-hunter');
  });
});
