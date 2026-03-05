import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OpenClawPlugin } from '../plugin.js';
import { Store } from '../../core/store.js';
import { createPortfolioTool } from './portfolio-tool.js';
import { createPositionsTool } from './positions-tool.js';
import { createStrategiesTool } from './strategies-tool.js';
import { chainId, tokenAddress } from '../../core/types.js';
import type { CyrusConfig } from '../../core/config.js';
import type { PersistenceService } from '../../core/persistence.js';

const mockConfig = {
  mode: 'dry-run',
  tickIntervalMs: 30000,
  integrator: 'cyrus-agent',
  logLevel: 'info',
  risk: { defaultSlippage: 0.005, maxGasCostUsd: 50, maxPositionSizeUsd: 10000, maxConcurrentTransfers: 20, drawdownThreshold: 0.15 },
  chains: { enabled: [1, 42161], rpcUrls: {} },
  strategies: { enabled: ['yield-hunter', 'cross-chain-arb'], directory: 'strategies' },
  composer: { enabled: true, supportedProtocols: [], defaultSlippage: 0.005 },
  ws: { port: 8080, enabled: true },
  rest: { port: 3001, enabled: true, corsOrigin: '*' },
  dbPath: ':memory:',
} as CyrusConfig;

const mockPersistence = {
  getActivityLog: vi.fn().mockReturnValue({ entries: [], total: 0 }),
} as unknown as PersistenceService;

describe('Portfolio Tool', () => {
  let store: Store;
  let plugin: OpenClawPlugin;

  beforeEach(() => {
    store = Store.getInstance();
    store.reset();
    store = Store.getInstance();
    plugin = new OpenClawPlugin({ store, config: mockConfig, persistence: mockPersistence });
  });

  it('should return empty portfolio', async () => {
    const tool = createPortfolioTool(plugin);
    const result = await tool.handler({});
    expect(result.success).toBe(true);
    expect(result.message).toContain('$0.00');
  });

  it('should return portfolio with balances', async () => {
    store.setBalance(chainId(1), tokenAddress('0x' + 'a'.repeat(40)), 1000000n, 1000, 'USDC', 6);
    store.setBalance(chainId(42161), tokenAddress('0x' + 'b'.repeat(40)), 500000n, 500, 'USDC', 6);

    const tool = createPortfolioTool(plugin);
    const result = await tool.handler({});
    expect(result.success).toBe(true);
    expect(result.message).toContain('$1500.00');
    const data = result.data as { chains: unknown[]; totalUsdValue: number };
    expect(data.chains).toHaveLength(2);
    expect(data.totalUsdValue).toBe(1500);
  });

  it('should filter by chain', async () => {
    store.setBalance(chainId(1), tokenAddress('0x' + 'a'.repeat(40)), 1000000n, 1000, 'USDC', 6);
    store.setBalance(chainId(42161), tokenAddress('0x' + 'b'.repeat(40)), 500000n, 500, 'USDC', 6);

    const tool = createPortfolioTool(plugin);
    const result = await tool.handler({ chain: 1 });
    expect(result.success).toBe(true);
    const data = result.data as { chains: unknown[]; totalUsdValue: number };
    expect(data.totalUsdValue).toBe(1000);
  });
});

describe('Positions Tool', () => {
  let store: Store;
  let plugin: OpenClawPlugin;

  beforeEach(() => {
    store = Store.getInstance();
    store.reset();
    store = Store.getInstance();
    plugin = new OpenClawPlugin({ store, config: mockConfig, persistence: mockPersistence });
  });

  it('should return empty positions', async () => {
    const tool = createPositionsTool(plugin);
    const result = await tool.handler({});
    expect(result.success).toBe(true);
    expect(result.message).toContain('0 position(s)');
  });

  it('should return positions with P&L', async () => {
    store.setPosition({
      id: 'pos-1',
      strategyId: 'yield-hunter',
      chainId: chainId(1),
      tokenAddress: tokenAddress('0x' + 'a'.repeat(40)),
      entryPrice: 100,
      currentPrice: 110,
      amount: 1000000n,
      enteredAt: Date.now(),
      pnlUsd: 10,
      pnlPercent: 0.1,
    });

    const tool = createPositionsTool(plugin);
    const result = await tool.handler({});
    expect(result.success).toBe(true);
    expect(result.message).toContain('1 position(s)');
    const data = result.data as { totalPnlUsd: number };
    expect(data.totalPnlUsd).toBe(10);
  });

  it('should filter by strategy', async () => {
    store.setPosition({
      id: 'pos-1',
      strategyId: 'yield-hunter',
      chainId: chainId(1),
      tokenAddress: tokenAddress('0x' + 'a'.repeat(40)),
      entryPrice: 100,
      currentPrice: 110,
      amount: 1000000n,
      enteredAt: Date.now(),
      pnlUsd: 10,
      pnlPercent: 0.1,
    });
    store.setPosition({
      id: 'pos-2',
      strategyId: 'cross-chain-arb',
      chainId: chainId(42161),
      tokenAddress: tokenAddress('0x' + 'b'.repeat(40)),
      entryPrice: 50,
      currentPrice: 48,
      amount: 2000000n,
      enteredAt: Date.now(),
      pnlUsd: -4,
      pnlPercent: -0.04,
    });

    const tool = createPositionsTool(plugin);
    const result = await tool.handler({ strategy: 'yield-hunter' });
    expect(result.success).toBe(true);
    const data = result.data as { positions: unknown[]; totalPnlUsd: number };
    expect(data.positions).toHaveLength(1);
    expect(data.totalPnlUsd).toBe(10);
  });
});

describe('Strategies Tool', () => {
  let store: Store;
  let plugin: OpenClawPlugin;

  beforeEach(() => {
    store = Store.getInstance();
    store.reset();
    store = Store.getInstance();
    plugin = new OpenClawPlugin({ store, config: mockConfig, persistence: mockPersistence });
  });

  it('should return enabled strategies', async () => {
    const tool = createStrategiesTool(plugin);
    const result = await tool.handler({});
    expect(result.success).toBe(true);
    expect(result.message).toContain('2 strategy(ies)');
    const data = result.data as { strategies: Array<{ name: string; tier: string }> };
    expect(data.strategies).toHaveLength(2);
    expect(data.strategies[0].name).toBe('yield-hunter');
    expect(data.strategies[0].tier).toBe('Safe');
    expect(data.strategies[1].name).toBe('cross-chain-arb');
    expect(data.strategies[1].tier).toBe('Growth');
  });

  it('should filter by name', async () => {
    const tool = createStrategiesTool(plugin);
    const result = await tool.handler({ name: 'yield' });
    expect(result.success).toBe(true);
    const data = result.data as { strategies: unknown[] };
    expect(data.strategies).toHaveLength(1);
  });
});
