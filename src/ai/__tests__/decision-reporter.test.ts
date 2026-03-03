import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DecisionReporter } from '../decision-reporter.js';
import { Store } from '../../core/store.js';
import type { DecisionContext, DecisionReport } from '../types.js';

// Mock Anthropic client
function createMockClient(narrativeText: string) {
  return {
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: narrativeText }],
      }),
    },
  } as unknown as import('@anthropic-ai/sdk').default;
}

function createMockContext(overrides: Partial<DecisionContext> = {}): DecisionContext {
  return {
    regime: 'bull',
    actionType: 'bridge',
    fromChain: 1,
    toChain: 42161,
    tokenSymbol: 'USDC',
    amountUsd: 2500.0,
    gasCostUsd: 1.2,
    bridgeFeeUsd: 0.85,
    slippage: 0.005,
    ...overrides,
  };
}

describe('DecisionReporter', () => {
  let store: Store;

  beforeEach(() => {
    Store.getInstance().reset();
    store = Store.getInstance();
  });

  describe('generateReport', () => {
    it('produces report with valid fields', async () => {
      const mockNarrative = 'I bridged $2,500 USDC from Ethereum to Arbitrum to capture better yield.';
      const mockClient = createMockClient(mockNarrative);
      const reporter = new DecisionReporter({ client: mockClient });
      const context = createMockContext();

      const report = await reporter.generateReport('YieldHunter', context, ['tx-123']);

      expect(report.id).toBeDefined();
      expect(typeof report.id).toBe('string');
      expect(report.id.length).toBeGreaterThan(0);
      expect(report.timestamp).toBeGreaterThan(0);
      expect(report.strategyName).toBe('YieldHunter');
      expect(report.narrative).toBe(mockNarrative);
      expect(report.transferIds).toEqual(['tx-123']);
      expect(report.outcome).toBe('pending');
      expect(report.context).toEqual(context);
    });

    it('stores AI narrative from mock client in report', async () => {
      const expectedNarrative = 'I noticed a yield opportunity and moved funds cross-chain. Cost: $1.20 gas + $0.85 bridge fee.';
      const mockClient = createMockClient(expectedNarrative);
      const reporter = new DecisionReporter({ client: mockClient });

      const report = await reporter.generateReport('CrossChainArb', createMockContext());

      expect(report.narrative).toBe(expectedNarrative);
    });

    it('uses fallback narrative when AI fails', async () => {
      const mockClient = {
        messages: {
          create: vi.fn().mockRejectedValue(new Error('API unreachable')),
        },
      } as unknown as import('@anthropic-ai/sdk').default;

      const reporter = new DecisionReporter({ client: mockClient });
      const context = createMockContext({
        amountUsd: 1500.0,
        tokenSymbol: 'ETH',
        gasCostUsd: 2.5,
        bridgeFeeUsd: 1.1,
      });

      const report = await reporter.generateReport('YieldHunter', context);

      // Fallback should contain specific numbers from context
      expect(report.narrative).toContain('$1500.00');
      expect(report.narrative).toContain('ETH');
      expect(report.narrative).toContain('$2.50');
      expect(report.narrative).toContain('$1.10');
      expect(report.narrative).toContain('YieldHunter');
    });

    it('uses fallback narrative when AI returns empty response', async () => {
      const mockClient = createMockClient('   ');
      const reporter = new DecisionReporter({ client: mockClient });
      const context = createMockContext();

      const report = await reporter.generateReport('CrossChainArb', context);

      // Should use fallback, not empty string
      expect(report.narrative.length).toBeGreaterThan(0);
      expect(report.narrative).toContain('$2500.00');
      expect(report.narrative).toContain('USDC');
    });

    it('includes estimated APY in fallback when present', async () => {
      const mockClient = {
        messages: {
          create: vi.fn().mockRejectedValue(new Error('fail')),
        },
      } as unknown as import('@anthropic-ai/sdk').default;

      const reporter = new DecisionReporter({ client: mockClient });
      const context = createMockContext({ estimatedApy: 0.048 });

      const report = await reporter.generateReport('YieldHunter', context);

      expect(report.narrative).toContain('4.80%');
    });

    it('persists report to store', async () => {
      const mockClient = createMockClient('Test narrative.');
      const reporter = new DecisionReporter({ client: mockClient });

      const report = await reporter.generateReport('TestStrategy', createMockContext());

      const stored = store.getReports();
      expect(stored.length).toBe(1);
      expect(stored[0].id).toBe(report.id);
      expect(stored[0].narrative).toBe('Test narrative.');
    });

    it('defaults outcome to pending', async () => {
      const mockClient = createMockClient('Some narrative.');
      const reporter = new DecisionReporter({ client: mockClient });

      const report = await reporter.generateReport('TestStrategy', createMockContext());

      expect(report.outcome).toBe('pending');
    });

    it('handles empty transferIds array', async () => {
      const mockClient = createMockClient('Narrative text.');
      const reporter = new DecisionReporter({ client: mockClient });

      const report = await reporter.generateReport('TestStrategy', createMockContext());

      expect(report.transferIds).toEqual([]);
    });

    it('passes multiple transferIds through', async () => {
      const mockClient = createMockClient('Narrative text.');
      const reporter = new DecisionReporter({ client: mockClient });

      const report = await reporter.generateReport(
        'TestStrategy',
        createMockContext(),
        ['tx-1', 'tx-2', 'tx-3'],
      );

      expect(report.transferIds).toEqual(['tx-1', 'tx-2', 'tx-3']);
    });
  });

  describe('updateOutcome', () => {
    it('changes outcome to positive', async () => {
      const mockClient = createMockClient('Original narrative.');
      const reporter = new DecisionReporter({ client: mockClient });
      const report = await reporter.generateReport('TestStrategy', createMockContext());

      reporter.updateOutcome(report.id, 'positive');

      const stored = store.getReports();
      expect(stored[0].outcome).toBe('positive');
    });

    it('changes outcome to negative', async () => {
      const mockClient = createMockClient('Original narrative.');
      const reporter = new DecisionReporter({ client: mockClient });
      const report = await reporter.generateReport('TestStrategy', createMockContext());

      reporter.updateOutcome(report.id, 'negative');

      const stored = store.getReports();
      expect(stored[0].outcome).toBe('negative');
    });

    it('changes outcome to failed', async () => {
      const mockClient = createMockClient('Original narrative.');
      const reporter = new DecisionReporter({ client: mockClient });
      const report = await reporter.generateReport('TestStrategy', createMockContext());

      reporter.updateOutcome(report.id, 'failed');

      const stored = store.getReports();
      expect(stored[0].outcome).toBe('failed');
    });

    it('appends reason to narrative when provided', async () => {
      const mockClient = createMockClient('Original narrative.');
      const reporter = new DecisionReporter({ client: mockClient });
      const report = await reporter.generateReport('TestStrategy', createMockContext());

      reporter.updateOutcome(report.id, 'positive', 'Yield improved by 1.7%');

      const stored = store.getReports();
      expect(stored[0].narrative).toContain('Original narrative.');
      expect(stored[0].narrative).toContain('Outcome update: Yield improved by 1.7%');
    });

    it('does not modify narrative when no reason provided', async () => {
      const mockClient = createMockClient('Original narrative.');
      const reporter = new DecisionReporter({ client: mockClient });
      const report = await reporter.generateReport('TestStrategy', createMockContext());

      reporter.updateOutcome(report.id, 'neutral');

      const stored = store.getReports();
      expect(stored[0].narrative).toBe('Original narrative.');
    });
  });

  describe('getReports with filters', () => {
    async function seedReports(reporter: DecisionReporter): Promise<DecisionReport[]> {
      const reports: DecisionReport[] = [];

      const r1 = await reporter.generateReport(
        'YieldHunter',
        createMockContext({ amountUsd: 1000 }),
      );
      r1.timestamp = 1000;
      reports.push(r1);

      const r2 = await reporter.generateReport(
        'CrossChainArb',
        createMockContext({ amountUsd: 2000 }),
      );
      r2.timestamp = 2000;
      reports.push(r2);

      const r3 = await reporter.generateReport(
        'YieldHunter',
        createMockContext({ amountUsd: 3000 }),
      );
      r3.timestamp = 3000;
      reporter.updateOutcome(r3.id, 'positive');
      reports.push(r3);

      const r4 = await reporter.generateReport(
        'CrossChainArb',
        createMockContext({ amountUsd: 4000 }),
      );
      r4.timestamp = 4000;
      reporter.updateOutcome(r4.id, 'negative');
      reports.push(r4);

      return reports;
    }

    it('filters by strategyName', async () => {
      const mockClient = createMockClient('Test narrative.');
      const reporter = new DecisionReporter({ client: mockClient });
      await seedReports(reporter);

      const results = reporter.getReports({ strategyName: 'YieldHunter' });

      expect(results.length).toBe(2);
      for (const r of results) {
        expect(r.strategyName).toBe('YieldHunter');
      }
    });

    it('filters by outcome', async () => {
      const mockClient = createMockClient('Test narrative.');
      const reporter = new DecisionReporter({ client: mockClient });
      await seedReports(reporter);

      const positiveResults = reporter.getReports({ outcome: 'positive' });
      expect(positiveResults.length).toBe(1);
      expect(positiveResults[0].outcome).toBe('positive');

      const pendingResults = reporter.getReports({ outcome: 'pending' });
      expect(pendingResults.length).toBe(2);
    });

    it('filters by date range (fromTimestamp, toTimestamp)', async () => {
      const mockClient = createMockClient('Test narrative.');
      const reporter = new DecisionReporter({ client: mockClient });
      await seedReports(reporter);

      const results = reporter.getReports({ fromTimestamp: 1500, toTimestamp: 3500 });

      expect(results.length).toBe(2);
      for (const r of results) {
        expect(r.timestamp).toBeGreaterThanOrEqual(1500);
        expect(r.timestamp).toBeLessThanOrEqual(3500);
      }
    });

    it('supports pagination with offset and limit', async () => {
      const mockClient = createMockClient('Test narrative.');
      const reporter = new DecisionReporter({ client: mockClient });
      await seedReports(reporter);

      // Reports are sorted most-recent-first: r4(4000), r3(3000), r2(2000), r1(1000)
      const firstPage = reporter.getReports({ limit: 2, offset: 0 });
      expect(firstPage.length).toBe(2);
      expect(firstPage[0].timestamp).toBe(4000);
      expect(firstPage[1].timestamp).toBe(3000);

      const secondPage = reporter.getReports({ limit: 2, offset: 2 });
      expect(secondPage.length).toBe(2);
      expect(secondPage[0].timestamp).toBe(2000);
      expect(secondPage[1].timestamp).toBe(1000);
    });

    it('returns empty array when no reports match filter', async () => {
      const mockClient = createMockClient('Test narrative.');
      const reporter = new DecisionReporter({ client: mockClient });
      await seedReports(reporter);

      const results = reporter.getReports({ strategyName: 'NonExistentStrategy' });
      expect(results).toEqual([]);
    });
  });

  describe('report cap eviction', () => {
    it('evicts oldest reports when exceeding cap', () => {
      // Directly manipulate store to test the 1000 cap with a smaller set
      // Add 1005 reports, verify only 1000 remain
      for (let i = 0; i < 1005; i++) {
        const report: DecisionReport = {
          id: `report-${i}`,
          timestamp: i,
          strategyName: 'TestStrategy',
          narrative: `Report ${i}`,
          transferIds: [],
          outcome: 'pending',
          context: createMockContext(),
        };
        store.addReport(report);
      }

      const all = store.getReports({ limit: 2000 });
      expect(all.length).toBe(1000);

      // The oldest 5 (ids 0-4) should have been evicted
      const ids = all.map(r => r.id);
      expect(ids).not.toContain('report-0');
      expect(ids).not.toContain('report-4');
      // The newest should still be present
      expect(ids).toContain('report-1004');
      expect(ids).toContain('report-1000');
    });
  });
});
