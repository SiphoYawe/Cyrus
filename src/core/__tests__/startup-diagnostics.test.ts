import { describe, it, expect, beforeEach, vi } from 'vitest';
import { collectDiagnostics, logStartupBanner, type DiagnosticReport } from '../startup-diagnostics.js';
import { Store } from '../store.js';
import type { CyrusConfig } from '../config.js';

function makeConfig(overrides?: Partial<CyrusConfig>): CyrusConfig {
  return {
    mode: 'paper',
    tickIntervalMs: 30_000,
    dbPath: ':memory:',
    walletAddress: '0x1234',
    chains: { enabled: [1, 42161, 137] },
    risk: { maxDrawdownPercent: 20, maxPositionSize: 0.1, riskDial: 5 },
    ws: { port: 0 },
    rest: { port: 0 },
    ...overrides,
  } as unknown as CyrusConfig;
}

describe('startup-diagnostics', () => {
  beforeEach(() => {
    Store.getInstance().reset();
  });

  it('collectDiagnostics returns a valid report with all sections', () => {
    const report = collectDiagnostics({
      config: makeConfig(),
      walletAddress: '0xABC',
      strategies: [],
      hasLifiConnector: true,
      hasAiOrchestrator: true,
      hasCircuitBreaker: true,
      hasMcpClient: false,
      hasTelegram: false,
      hasSolana: false,
      wsPort: 8080,
      restPort: 3000,
    });

    expect(report.mode).toBe('paper');
    expect(report.walletAddress).toBe('0xABC');
    expect(report.chains).toEqual([1, 42161, 137]);
    expect(report.features.length).toBeGreaterThanOrEqual(5);
    expect(report.dataSources.length).toBeGreaterThanOrEqual(4);
    expect(report.strategies).toEqual([]);
    expect(report.timestamp).toBeGreaterThan(0);
  });

  it('collects feature statuses correctly', () => {
    const report = collectDiagnostics({
      config: makeConfig(),
      strategies: [],
      hasLifiConnector: false,
      hasAiOrchestrator: false,
      hasCircuitBreaker: false,
      hasMcpClient: false,
      hasTelegram: false,
      hasSolana: false,
      wsPort: 8080,
      restPort: 3000,
    });

    const lifi = report.features.find((f) => f.name === 'LI.FI Connector');
    expect(lifi?.status).toBe('DISABLED');

    const ai = report.features.find((f) => f.name === 'AI Orchestrator');
    expect(ai?.status).toBe('DISABLED');

    const risk = report.features.find((f) => f.name === 'Risk Engine');
    expect(risk?.status).toBe('DISABLED');
  });

  it('includes strategies in report', () => {
    const mockStrategies = [
      { name: 'YieldHunter' },
      { name: 'CrossChainArb' },
    ] as any;

    const report = collectDiagnostics({
      config: makeConfig(),
      strategies: mockStrategies,
      hasLifiConnector: true,
      hasAiOrchestrator: true,
      hasCircuitBreaker: true,
      hasMcpClient: false,
      hasTelegram: false,
      hasSolana: false,
      wsPort: 8080,
      restPort: 3000,
    });

    expect(report.strategies).toHaveLength(2);
    expect(report.strategies[0].name).toBe('YieldHunter');
    expect(report.strategies[0].status).toBe('ACTIVE');
  });

  it('generates warnings for missing env vars', () => {
    const originalEnv = { ...process.env };
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.TWITTER_BEARER_TOKEN;
    delete process.env.TELEGRAM_SESSION_STRING;
    delete process.env.SOLANA_PRIVATE_KEY;
    delete process.env.LIFI_API_KEY;

    const report = collectDiagnostics({
      config: makeConfig(),
      strategies: [],
      hasLifiConnector: true,
      hasAiOrchestrator: true,
      hasCircuitBreaker: true,
      hasMcpClient: false,
      hasTelegram: false,
      hasSolana: false,
      wsPort: 8080,
      restPort: 3000,
    });

    expect(report.warnings.length).toBeGreaterThanOrEqual(3);
    expect(report.warnings.some((w) => w.includes('ANTHROPIC_API_KEY'))).toBe(true);
    expect(report.warnings.some((w) => w.includes('LIFI_API_KEY'))).toBe(true);

    Object.assign(process.env, originalEnv);
  });

  it('logStartupBanner does not throw', () => {
    const report: DiagnosticReport = {
      mode: 'paper',
      walletAddress: '0xABC',
      chains: [1, 42161],
      balanceUsd: 1234.56,
      features: [{ name: 'LI.FI', status: 'ACTIVE', detail: 'ok' }],
      dataSources: [{ name: 'Market Data', status: 'ACTIVE', detail: 'ok' }],
      strategies: [{ name: 'YieldHunter', status: 'ACTIVE', reason: '' }],
      warnings: ['Test warning'],
      timestamp: Date.now(),
    };

    expect(() => logStartupBanner(report)).not.toThrow();
  });
});
