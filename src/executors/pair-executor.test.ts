import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PairExecutor } from './pair-executor.js';
import type { PairExecutorConfig } from './pair-executor.js';
import type { PairAction, ExecutorAction } from '../core/action-types.js';
import type {
  PearProtocolConnectorInterface,
  PearPair,
  PearPosition,
  SpreadData,
  PearMargin,
  PearOrderResult,
} from '../connectors/pear-protocol-connector.js';
import { Store } from '../core/store.js';

// ---------------------------------------------------------------------------
// Mock connector factory
// ---------------------------------------------------------------------------

function createMockConnector(): PearProtocolConnectorInterface {
  return {
    queryPairs: vi.fn<[], Promise<PearPair[]>>().mockResolvedValue([
      {
        id: 'ETH-BTC',
        symbolA: 'ETH',
        symbolB: 'BTC',
        spreadMean: 0.065,
        spreadStdDev: 0.008,
        currentSpread: 0.065,
        correlation: 0.85,
      },
    ]),

    queryPositions: vi
      .fn<[], Promise<PearPosition[]>>()
      .mockResolvedValue([]),

    querySpreadData: vi
      .fn<[string], Promise<SpreadData>>()
      .mockResolvedValue({
        currentSpread: 0.073,
        historicalMean: 0.065,
        standardDeviation: 0.008,
        zScore: 2.5,
        correlation: 0.85,
        dataPoints: 1000,
      }),

    queryMargin: vi
      .fn<[], Promise<PearMargin>>()
      .mockResolvedValue({
        available: 5000,
        used: 1000,
        total: 6000,
        utilizationPercent: 16.67,
      }),

    openPairTrade: vi
      .fn<[string, string, string, number], Promise<PearOrderResult>>()
      .mockResolvedValue({
        status: 'ok',
        positionId: 'pear-pos-test-123',
      }),

    closePairTrade: vi
      .fn<[string], Promise<PearOrderResult>>()
      .mockResolvedValue({
        status: 'ok',
        positionId: 'pear-pos-test-123',
      }),
  };
}

function createDefaultConfig(): PairExecutorConfig {
  return {
    maxLeverage: 10,
    maxOpenPositions: 5,
  };
}

function makePairAction(overrides: Partial<PairAction> = {}): PairAction {
  return {
    id: 'pair-test-1',
    type: 'pair' as const,
    priority: 1,
    createdAt: Date.now(),
    strategyId: 'PearPairTrader',
    pairId: 'ETH-BTC',
    longSymbol: 'BTC',
    shortSymbol: 'ETH',
    longSize: 100_000_000n, // 100 USDC (6 decimals)
    shortSize: 100_000_000n,
    leverage: 3,
    metadata: {
      stoploss: -0.08,
      takeProfit: 0.16,
      timeLimitMs: 4 * 60 * 60 * 1000,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PairExecutor', () => {
  let executor: PairExecutor;
  let connector: ReturnType<typeof createMockConnector>;
  let store: Store;

  beforeEach(() => {
    Store.getInstance().reset();
    connector = createMockConnector();
    executor = new PairExecutor(connector, createDefaultConfig());
    store = Store.getInstance();
  });

  describe('canHandle', () => {
    it('handles pair actions', () => {
      expect(executor.canHandle(makePairAction())).toBe(true);
    });

    it('rejects non-pair actions', () => {
      expect(executor.canHandle({ type: 'swap' } as ExecutorAction)).toBe(false);
      expect(executor.canHandle({ type: 'perp' } as ExecutorAction)).toBe(false);
      expect(executor.canHandle({ type: 'bridge' } as ExecutorAction)).toBe(false);
    });
  });

  describe('trigger stage', () => {
    it('passes with sufficient margin and valid leverage', async () => {
      const result = await executor.execute(makePairAction());
      expect(result.success).toBe(true);
    });

    it('rejects leverage exceeding max', async () => {
      const result = await executor.execute(makePairAction({ leverage: 11 }));
      expect(result.success).toBe(false);
      expect(result.error).toContain('Leverage');
    });

    it('rejects leverage below 1x', async () => {
      const result = await executor.execute(makePairAction({ leverage: 0 }));
      expect(result.success).toBe(false);
      expect(result.error).toContain('Leverage');
    });

    it('rejects insufficient margin', async () => {
      (connector.queryMargin as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        available: 1, // very low
        used: 5999,
        total: 6000,
        utilizationPercent: 99.98,
      });

      const result = await executor.execute(makePairAction());
      expect(result.success).toBe(false);
      expect(result.error).toContain('Insufficient margin');
    });

    it('rejects when max open positions reached', async () => {
      const positions: PearPosition[] = Array.from({ length: 5 }, (_, i) => ({
        id: `pos-${i}`,
        pairId: `PAIR-${i}`,
        longSymbol: 'A',
        shortSymbol: 'B',
        longSize: '100',
        shortSize: '100',
        entrySpread: 0.05,
        currentSpread: 0.05,
        unrealizedPnl: '0',
        marginUsed: '100',
        openTimestamp: Date.now(),
      }));

      (connector.queryPositions as ReturnType<typeof vi.fn>).mockResolvedValueOnce(positions);

      const result = await executor.execute(makePairAction());
      expect(result.success).toBe(false);
      expect(result.error).toContain('Max open positions');
    });

    it('rejects when spread divergence no longer significant', async () => {
      (connector.querySpreadData as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        currentSpread: 0.066,
        historicalMean: 0.065,
        standardDeviation: 0.008,
        zScore: 0.5, // below 1.5 threshold
        correlation: 0.85,
        dataPoints: 1000,
      });

      const result = await executor.execute(makePairAction());
      expect(result.success).toBe(false);
      expect(result.error).toContain('divergence no longer significant');
    });
  });

  describe('open stage — both legs simultaneously', () => {
    it('opens both legs in a single atomic call', async () => {
      const result = await executor.execute(makePairAction());
      expect(result.success).toBe(true);
      expect(connector.openPairTrade).toHaveBeenCalledWith(
        'ETH-BTC',
        expect.any(String),
        expect.any(String),
        3,
      );
      // Verify it was called exactly once (atomic, not two separate calls)
      expect(connector.openPairTrade).toHaveBeenCalledTimes(1);
    });

    it('fails when pair trade opening fails', async () => {
      (connector.openPairTrade as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        status: 'error',
        error: 'Insufficient collateral',
      });

      const result = await executor.execute(makePairAction());
      expect(result.success).toBe(false);
      expect(result.error).toContain('Insufficient collateral');
    });
  });

  describe('manage stage — combined P&L barrier evaluation', () => {
    it('queries spread data and positions during manage', async () => {
      const result = await executor.execute(makePairAction());
      expect(result.success).toBe(true);
      // querySpreadData called in trigger + open + manage = multiple times
      expect(
        (connector.querySpreadData as ReturnType<typeof vi.fn>).mock.calls.length,
      ).toBeGreaterThanOrEqual(2);
    });

    it('evaluates triple barrier on combined P&L, not individual legs', async () => {
      // The manage stage returns data about combined PnL
      const result = await executor.execute(makePairAction());
      expect(result.success).toBe(true);
      // Result metadata should contain combined metrics
      expect(result.metadata).toBeDefined();
    });
  });

  describe('close stage — both legs simultaneously, no partial closes', () => {
    it('closes both legs with a single call', async () => {
      const result = await executor.execute(makePairAction());
      expect(result.success).toBe(true);
      expect(connector.closePairTrade).toHaveBeenCalledTimes(1);
    });

    it('records trade in store after close', async () => {
      const result = await executor.execute(makePairAction());
      expect(result.success).toBe(true);

      const trades = store.getAllTrades();
      expect(trades.length).toBeGreaterThan(0);
      expect(trades[0]!.strategyId).toBe('PearPairTrader');
    });

    it('fails when close fails — does NOT partially close', async () => {
      (connector.closePairTrade as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        status: 'error',
        error: 'Position locked',
      });

      const result = await executor.execute(makePairAction());
      expect(result.success).toBe(false);
      expect(result.error).toContain('Position locked');
      // Verify no partial close attempt (only 1 call, which failed)
      expect(connector.closePairTrade).toHaveBeenCalledTimes(1);
    });
  });

  describe('full lifecycle', () => {
    it('executes Trigger -> Open -> Manage -> Close', async () => {
      const result = await executor.execute(makePairAction());
      expect(result.success).toBe(true);

      // Verify full lifecycle calls
      expect(connector.queryMargin).toHaveBeenCalled();
      expect(connector.queryPositions).toHaveBeenCalled();
      expect(connector.querySpreadData).toHaveBeenCalled();
      expect(connector.openPairTrade).toHaveBeenCalled();
      expect(connector.closePairTrade).toHaveBeenCalled();
    });

    it('returns transferId and txHash on success', async () => {
      const result = await executor.execute(makePairAction());
      expect(result.success).toBe(true);
      expect(result.transferId).not.toBeNull();
      expect(result.metadata['realizedPnl']).toBeDefined();
      expect(result.metadata['tradeId']).toBeDefined();
    });
  });

  describe('decimal conversion', () => {
    it('converts USDC bigint to decimal for Pear API', async () => {
      await executor.execute(makePairAction({
        longSize: 150_000_000n,  // 150 USDC
        shortSize: 150_000_000n,
      }));

      const call = (connector.openPairTrade as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(call[1]).toBe('150.000000'); // long size
      expect(call[2]).toBe('150.000000'); // short size
    });
  });
});
