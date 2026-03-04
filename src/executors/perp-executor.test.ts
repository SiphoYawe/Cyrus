import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PerpExecutor } from './perp-executor.js';
import type { PerpExecutorConfig } from './perp-executor.js';
import type { PerpAction, ExecutorAction } from '../core/action-types.js';
import type { HyperliquidConnectorInterface } from '../connectors/hyperliquid-connector.js';
import type {
  HyperliquidBalance,
  HyperliquidPosition,
  FundingRateMap,
  OpenInterestMap,
  OrderBook,
  HyperliquidOrderResult,
  HyperliquidOrder,
  HyperliquidFill,
} from '../connectors/hyperliquid-types.js';
import { Store } from '../core/store.js';

function createMockConnector(): HyperliquidConnectorInterface {
  return {
    queryBalance: vi.fn<[], Promise<HyperliquidBalance>>().mockResolvedValue({
      totalMarginUsed: 1000,
      totalNtlPos: 5000,
      totalRawUsd: 10000,
      withdrawable: 5000,
      crossMarginSummary: {
        accountValue: 10000,
        totalMarginUsed: 1000,
        totalNtlPos: 5000,
      },
    }),
    queryPositions: vi
      .fn<[], Promise<HyperliquidPosition[]>>()
      .mockResolvedValue([]),
    queryFundingRates: vi
      .fn<[], Promise<FundingRateMap>>()
      .mockResolvedValue(new Map()),
    queryOpenInterest: vi
      .fn<[], Promise<OpenInterestMap>>()
      .mockResolvedValue(new Map()),
    queryOrderBook: vi
      .fn<[string, number?], Promise<OrderBook>>()
      .mockResolvedValue({
        coin: 'ETH',
        bids: [],
        asks: [],
        timestamp: Date.now(),
      }),
    placeMarketOrder: vi
      .fn<
        [string, 'long' | 'short', string, number],
        Promise<HyperliquidOrderResult>
      >()
      .mockResolvedValue({
        status: 'ok',
        orderId: 123,
        filledSize: '1.0',
        avgPrice: '3000.00',
      }),
    placeLimitOrder: vi
      .fn<
        [
          string,
          'long' | 'short',
          string,
          string,
          number,
          'GTC' | 'IOC' | 'FOK',
        ],
        Promise<HyperliquidOrderResult>
      >()
      .mockResolvedValue({
        status: 'ok',
        orderId: 456,
        filledSize: '0',
      }),
    cancelOrder: vi
      .fn<[string, number], Promise<boolean>>()
      .mockResolvedValue(true),
    closePosition: vi
      .fn<[string], Promise<HyperliquidOrderResult>>()
      .mockResolvedValue({
        status: 'ok',
        orderId: 789,
      }),
    queryOpenOrders: vi
      .fn<[], Promise<HyperliquidOrder[]>>()
      .mockResolvedValue([]),
    queryFills: vi
      .fn<[number?], Promise<HyperliquidFill[]>>()
      .mockResolvedValue([]),
    depositToMargin: vi
      .fn<[string], Promise<boolean>>()
      .mockResolvedValue(true),
    withdrawFromMargin: vi
      .fn<[string], Promise<boolean>>()
      .mockResolvedValue(true),
  };
}

function createDefaultConfig(): PerpExecutorConfig {
  return {
    maxLeverage: 50,
    defaultSlippage: 0.005,
    maxFundingRateThreshold: 0.01,
    positionPollIntervalMs: 100,
  };
}

function makePerpAction(overrides: Partial<PerpAction> = {}): PerpAction {
  return {
    id: 'perp-test-1',
    type: 'perp' as const,
    priority: 1,
    createdAt: Date.now(),
    strategyId: 'test-strategy',
    symbol: 'ETH',
    side: 'long' as const,
    size: 1000000000000000000n, // 1 ETH in wei
    leverage: 10,
    orderType: 'market' as const,
    metadata: {
      stoploss: -0.1,
      takeProfit: 0.05,
      timeLimitMs: 24 * 60 * 60 * 1000,
    },
    ...overrides,
  };
}

describe('PerpExecutor', () => {
  let executor: PerpExecutor;
  let connector: ReturnType<typeof createMockConnector>;
  let store: Store;

  beforeEach(() => {
    // Reset first to clear the singleton, then get the fresh instance
    Store.getInstance().reset();
    connector = createMockConnector();
    executor = new PerpExecutor(connector, createDefaultConfig());
    // Get store AFTER executor is created so both share the same singleton
    store = Store.getInstance();
  });

  describe('canHandle', () => {
    it('handles perp actions', () => {
      expect(executor.canHandle(makePerpAction())).toBe(true);
    });

    it('rejects non-perp actions', () => {
      // Intentional partial cast -- testing type guard rejects non-perp types
      expect(executor.canHandle({ type: 'swap' } as ExecutorAction)).toBe(false);
    });
  });

  describe('trigger stage', () => {
    it('passes with sufficient margin and valid leverage', async () => {
      const result = await executor.execute(makePerpAction());
      expect(result.success).toBe(true);
    });

    it('rejects leverage exceeding 50x', async () => {
      const result = await executor.execute(makePerpAction({ leverage: 51 }));
      expect(result.success).toBe(false);
      expect(result.error).toContain('Leverage');
    });

    it('rejects leverage below 1x', async () => {
      const result = await executor.execute(makePerpAction({ leverage: 0 }));
      expect(result.success).toBe(false);
      expect(result.error).toContain('Leverage');
    });

    it('rejects insufficient margin', async () => {
      (
        connector.queryBalance as ReturnType<typeof vi.fn>
      ).mockResolvedValueOnce({
        totalMarginUsed: 9900,
        totalNtlPos: 0,
        totalRawUsd: 100,
        withdrawable: 0.001, // very low
        crossMarginSummary: {
          accountValue: 100,
          totalMarginUsed: 0,
          totalNtlPos: 0,
        },
      });

      const result = await executor.execute(makePerpAction());
      expect(result.success).toBe(false);
      expect(result.error).toContain('Insufficient margin');
    });
  });

  describe('open stage', () => {
    it('places market order and creates position', async () => {
      const result = await executor.execute(makePerpAction());
      expect(result.success).toBe(true);
      expect(connector.placeMarketOrder).toHaveBeenCalledWith(
        'ETH',
        'long',
        expect.any(String),
        10,
      );
    });

    it('places limit order with price and TIF', async () => {
      const action = makePerpAction({
        orderType: 'limit',
        limitPrice: 3000,
        timeInForce: 'GTC',
      });

      const result = await executor.execute(action);
      expect(result.success).toBe(true);
      expect(connector.placeLimitOrder).toHaveBeenCalled();
    });

    it('fails when limit order has no price', async () => {
      const action = makePerpAction({
        orderType: 'limit',
        limitPrice: undefined,
      });

      const result = await executor.execute(action);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Limit price required');
    });

    it('fails when order placement fails', async () => {
      (
        connector.placeMarketOrder as ReturnType<typeof vi.fn>
      ).mockResolvedValueOnce({
        status: 'error',
        error: 'Insufficient funds',
      });

      const result = await executor.execute(makePerpAction());
      expect(result.success).toBe(false);
      expect(result.error).toContain('Insufficient funds');
    });
  });

  describe('manage stage', () => {
    it('queries positions and funding rates', async () => {
      const result = await executor.execute(makePerpAction());
      expect(result.success).toBe(true);
      expect(connector.queryPositions).toHaveBeenCalled();
      expect(connector.queryFundingRates).toHaveBeenCalled();
    });
  });

  describe('close stage', () => {
    it('closes position and records trade', async () => {
      const result = await executor.execute(makePerpAction());
      expect(result.success).toBe(true);
      expect(connector.closePosition).toHaveBeenCalledWith('ETH');

      // Verify trade was recorded
      const trades = store.getAllTrades();
      expect(trades.length).toBeGreaterThan(0);
    });

    it('fails when close order fails', async () => {
      (
        connector.closePosition as ReturnType<typeof vi.fn>
      ).mockResolvedValueOnce({
        status: 'error',
        error: 'Position not found',
      });

      const result = await executor.execute(makePerpAction());
      // The close will fail, but only after successful open and manage
      // Since our mock close fails, the overall result should fail
      expect(result.success).toBe(false);
    });
  });

  describe('full lifecycle', () => {
    it('executes Trigger -> Open -> Manage -> Close', async () => {
      // Setup position data for manage stage
      (
        connector.queryPositions as ReturnType<typeof vi.fn>
      ).mockResolvedValue([
        {
          coin: 'ETH',
          szi: '1.0',
          leverage: { type: 'cross', value: 10 },
          entryPx: '3000.00',
          positionValue: '3000.00',
          unrealizedPnl: '100.00',
          returnOnEquity: '0.033',
          liquidationPx: '2700.00',
          marginUsed: '300.00',
        },
      ]);

      const fundingMap: FundingRateMap = new Map([
        [
          'ETH',
          {
            coin: 'ETH',
            fundingRate: '0.0001',
            premium: '0.00005',
            time: Date.now(),
          },
        ],
      ]);
      (
        connector.queryFundingRates as ReturnType<typeof vi.fn>
      ).mockResolvedValue(fundingMap);

      const result = await executor.execute(makePerpAction());
      expect(result.success).toBe(true);

      // Verify full lifecycle calls
      expect(connector.queryBalance).toHaveBeenCalled();
      expect(connector.placeMarketOrder).toHaveBeenCalled();
      expect(connector.queryPositions).toHaveBeenCalled();
      expect(connector.queryFundingRates).toHaveBeenCalled();
      expect(connector.closePosition).toHaveBeenCalled();
    });
  });

  describe('decimal conversion', () => {
    it('converts bigint to decimal format for orders', async () => {
      await executor.execute(makePerpAction({ size: 1500000000000000000n })); // 1.5 ETH
      const call = (
        connector.placeMarketOrder as ReturnType<typeof vi.fn>
      ).mock.calls[0];
      expect(call[2]).toBe('1.500000000000000000'); // size as decimal string
    });
  });
});
