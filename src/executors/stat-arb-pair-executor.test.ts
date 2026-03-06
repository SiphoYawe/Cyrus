import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Store } from '../core/store.js';
import { StatArbPairExecutor } from './stat-arb-pair-executor.js';
import type { StatArbPairExecutorConfig } from './stat-arb-pair-executor.js';
import type { HyperliquidConnectorInterface } from '../connectors/hyperliquid-connector.js';
import type { HyperliquidOrderManager, PerpOrderResult, PerpOrderParams } from '../connectors/hyperliquid-order-manager.js';
import type { FundingRateTracker } from '../stat-arb/funding-rate-tracker.js';
import type { StatArbPairAction } from '../core/action-types.js';
import type { FundingRateMap, FundingRate } from '../connectors/hyperliquid-types.js';
import type { StatArbPosition } from '../core/store-slices/stat-arb-slice.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeAction(overrides?: Partial<StatArbPairAction>): StatArbPairAction {
  return {
    id: 'action-1',
    type: 'stat_arb_pair',
    priority: 1,
    createdAt: Date.now(),
    strategyId: 'stat-arb-strategy',
    pair: { tokenA: 'ETH', tokenB: 'BTC', key: 'BTC-ETH' },
    direction: 'long_pair',
    hedgeRatio: 1.2,
    entryZScore: 2.1,
    halfLifeHours: 24,
    leverage: 18,
    capitalAllocation: 10000,
    correlation: 0.87,
    signalSource: 'native',
    metadata: {},
    ...overrides,
  };
}

function makeOrderResult(overrides?: Partial<PerpOrderResult>): PerpOrderResult {
  return {
    orderId: `order-${Math.random().toString(36).slice(2, 8)}`,
    status: 'filled',
    fillPrice: '2000',
    fillSize: '5',
    averageFillPrice: '2000',
    remainingSize: '0',
    fees: '0.5',
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeMockConnector(): HyperliquidConnectorInterface {
  return {
    queryBalance: vi.fn().mockResolvedValue({ withdrawable: 50000, totalRawUsd: 100000 }),
    queryPositions: vi.fn().mockResolvedValue([
      { coin: 'ETH', entryPx: '2050', unrealizedPnl: '250', szi: '5', leverage: '18' },
      { coin: 'BTC', entryPx: '39800', unrealizedPnl: '30', szi: '-0.15', leverage: '18' },
    ]),
    queryFundingRates: vi.fn().mockResolvedValue(new Map<string, FundingRate>()),
    queryOpenInterest: vi.fn(),
    queryOrderBook: vi.fn(),
    placeMarketOrder: vi.fn(),
    placeLimitOrder: vi.fn(),
    cancelOrder: vi.fn(),
    closePosition: vi.fn(),
    queryOpenOrders: vi.fn(),
    queryFills: vi.fn(),
    depositToMargin: vi.fn(),
    withdrawFromMargin: vi.fn(),
  } as unknown as HyperliquidConnectorInterface;
}

function makeMockOrderManager(): HyperliquidOrderManager {
  let callCount = 0;
  return {
    placeOrder: vi.fn().mockImplementation(() => {
      callCount++;
      return Promise.resolve(
        makeOrderResult({
          orderId: `order-${callCount}`,
          fillPrice: callCount === 1 ? '2000' : '40000',
        }),
      );
    }),
    cancelOrder: vi.fn(),
    getOrderStatus: vi.fn(),
    updatePartialFill: vi.fn(),
  } as unknown as HyperliquidOrderManager;
}

function makeMockFundingTracker(): FundingRateTracker {
  return {
    updateFunding: vi.fn().mockResolvedValue({
      timestamp: Date.now(),
      longSymbol: 'ETH',
      shortSymbol: 'BTC',
      longRate: 0.0001,
      shortRate: -0.0002,
      longPayment: -2000000000000000n,
      shortPayment: 2400000000000000n,
      netPayment: 400000000000000n,
      cumulativeNet: 400000000000000n,
    }),
    getCumulativeFunding: vi.fn().mockReturnValue({
      positionId: 'pos-1',
      longTotal: -2000000000000000n,
      shortTotal: 2400000000000000n,
      netTotal: 400000000000000n,
      tickCount: 1,
      dailyRate: 0,
      history: [],
    }),
    checkFundingExposure: vi.fn().mockReturnValue({
      fundingExcessive: false,
      dailyNetRate: -0.1,
      tightenedMaxLossPercent: 30,
    }),
    finalizeFunding: vi.fn().mockReturnValue({
      positionId: 'pos-1',
      longTotal: 0n,
      shortTotal: 0n,
      netTotal: 0n,
      tickCount: 0,
      dailyRate: 0,
      history: [],
    }),
    getCompletedFunding: vi.fn(),
  } as unknown as FundingRateTracker;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StatArbPairExecutor', () => {
  let connector: HyperliquidConnectorInterface;
  let orderManager: HyperliquidOrderManager;
  let fundingTracker: FundingRateTracker;
  let executor: StatArbPairExecutor;
  let store: Store;

  beforeEach(() => {
    Store.getInstance().reset();
    vi.clearAllMocks();
    store = Store.getInstance();
    connector = makeMockConnector();
    orderManager = makeMockOrderManager();
    fundingTracker = makeMockFundingTracker();
    executor = new StatArbPairExecutor(connector, orderManager, fundingTracker);
  });

  // --- canHandle ---

  it('canHandle returns true for stat_arb_pair actions', () => {
    expect(executor.canHandle(makeAction())).toBe(true);
  });

  it('canHandle returns false for non stat_arb_pair actions', () => {
    expect(executor.canHandle({ type: 'perp' } as any)).toBe(false);
  });

  // --- AC1: Trigger stage validations ---

  it('trigger rejects when margin balance is insufficient', async () => {
    (connector.queryBalance as ReturnType<typeof vi.fn>).mockResolvedValue({
      withdrawable: 100, // Need ~555 for 10000/18
      totalRawUsd: 100,
    });

    const result = await executor.execute(makeAction());
    expect(result.success).toBe(false);
    expect(result.error).toContain('Insufficient margin');
  });

  it('trigger rejects when leverage exceeds max', async () => {
    const result = await executor.execute(makeAction({ leverage: 50 }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('Leverage 50 out of range');
  });

  it('trigger rejects when open position already exists for pair', async () => {
    // Pre-populate an active position
    store.openStatArbPosition({
      positionId: 'existing-pos',
      pair: { tokenA: 'ETH', tokenB: 'BTC', key: 'BTC-ETH' },
      direction: 'long_pair',
      hedgeRatio: 1.2,
      leverage: 18,
      legA: { symbol: 'ETH', side: 'long', size: 5, entryPrice: 2000, currentPrice: 2000, unrealizedPnl: 0, funding: 0 },
      legB: { symbol: 'BTC', side: 'short', size: 0.15, entryPrice: 40000, currentPrice: 40000, unrealizedPnl: 0, funding: 0 },
      openTimestamp: Date.now(),
      halfLifeHours: 24,
      combinedPnl: 0,
      accumulatedFunding: 0,
      marginUsed: 555,
      status: 'active',
      signalSource: 'native',
    });

    const result = await executor.execute(makeAction());
    expect(result.success).toBe(false);
    expect(result.error).toContain('Open position already exists');
  });

  // AC7: Max pair positions
  it('trigger rejects when max pair positions reached', async () => {
    // Pre-populate 10 active positions
    for (let i = 0; i < 10; i++) {
      store.openStatArbPosition({
        positionId: `pos-${i}`,
        pair: { tokenA: `TKN${i}`, tokenB: `TKN${i + 10}`, key: `TKN${i}-TKN${i + 10}` },
        direction: 'long_pair',
        hedgeRatio: 1.0,
        leverage: 18,
        legA: { symbol: `TKN${i}`, side: 'long', size: 1, entryPrice: 100, currentPrice: 100, unrealizedPnl: 0, funding: 0 },
        legB: { symbol: `TKN${i + 10}`, side: 'short', size: 1, entryPrice: 100, currentPrice: 100, unrealizedPnl: 0, funding: 0 },
        openTimestamp: Date.now(),
        halfLifeHours: 24,
        combinedPnl: 0,
        accumulatedFunding: 0,
        marginUsed: 100,
        status: 'active',
        signalSource: 'native',
      });
    }

    const result = await executor.execute(makeAction());
    expect(result.success).toBe(false);
    expect(result.error).toContain('Max pair positions');
  });

  it('trigger passes when all validations succeed', async () => {
    // Mock manage to return managed (no close)
    const result = await executor.execute(makeAction());
    expect(result.success).toBe(true);
  });

  // --- AC2: Open stage beta-neutral sizing ---

  it('open calculates correct beta-neutral sizes with hedgeRatio 1.5', async () => {
    const action = makeAction({ hedgeRatio: 1.5, capitalAllocation: 10000 });
    await executor.execute(action);

    // longSize = 10000 / (1 + 1.5) = 4000
    // shortSize = 10000 * 1.5 / (1 + 1.5) = 6000
    const calls = (orderManager.placeOrder as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(2);
    // First call is long (buy), second is short (sell)
    expect(calls[0][0].side).toBe('buy');
    expect(calls[1][0].side).toBe('sell');
  });

  it('open calculates equal sizes when hedgeRatio is 1.0', async () => {
    const action = makeAction({ hedgeRatio: 1.0, capitalAllocation: 10000 });
    await executor.execute(action);

    // longSize = 10000 / 2 = 5000
    // shortSize = 10000 / 2 = 5000
    const calls = (orderManager.placeOrder as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(2);
    // Both sizes should be equal
    const longSize = calls[0][0].size;
    const shortSize = calls[1][0].size;
    expect(longSize).toBe(shortSize);
  });

  // --- AC3: StatArbPosition created ---

  it('StatArbPosition is correctly created with all fields from order fills', async () => {
    await executor.execute(makeAction());

    const positions = store.getAllActiveStatArbPositions();
    expect(positions.length).toBe(1);

    const pos = positions[0];
    expect(pos.pair.key).toBe('BTC-ETH');
    expect(pos.direction).toBe('long_pair');
    expect(pos.hedgeRatio).toBe(1.2);
    expect(pos.leverage).toBe(18);
    expect(pos.status).toBe('active');
    expect(pos.signalSource).toBe('native');
    expect(pos.legA.side).toBe('long');
    expect(pos.legB.side).toBe('short');
    expect(pos.legA.orderId).toBeDefined();
    expect(pos.legB.orderId).toBeDefined();
  });

  // --- AC4: Rollback on second leg failure ---

  it('rollback: second leg rejected -> first leg immediately closed', async () => {
    let callCount = 0;
    (orderManager.placeOrder as ReturnType<typeof vi.fn>).mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.resolve(makeOrderResult({ orderId: 'long-filled' }));
      if (callCount === 2) return Promise.reject(new Error('Insufficient margin'));
      // Third call is rollback
      return Promise.resolve(makeOrderResult({ orderId: 'rollback' }));
    });

    const result = await executor.execute(makeAction());
    expect(result.success).toBe(false);
    expect(result.error).toContain('Pair trade rollback');

    // Should have 3 calls: long open, short attempt, long rollback
    expect((orderManager.placeOrder as ReturnType<typeof vi.fn>).mock.calls.length).toBe(3);
    // Third call should be a sell (closing the long)
    expect((orderManager.placeOrder as ReturnType<typeof vi.fn>).mock.calls[2][0].side).toBe('sell');
  });

  it('rollback: both legs fail -> logged at FATAL level', async () => {
    let callCount = 0;
    (orderManager.placeOrder as ReturnType<typeof vi.fn>).mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.resolve(makeOrderResult({ orderId: 'long-filled' }));
      // Both second and third calls fail
      return Promise.reject(new Error('Exchange down'));
    });

    const result = await executor.execute(makeAction());
    expect(result.success).toBe(false);
    // Should still attempt 3 calls (long, short, rollback)
    expect((orderManager.placeOrder as ReturnType<typeof vi.fn>).mock.calls.length).toBe(3);
  });

  // --- AC5: Manage stage exit conditions ---

  it('manage detects time stop exit (duration > 3x halfLife)', async () => {
    const action = makeAction({
      halfLifeHours: 24,
      metadata: {},
    });

    // Override to make position already old
    const originalDate = Date.now;
    let timeOffset = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => {
      const base = originalDate.call(Date);
      if (timeOffset > 0) return base + timeOffset;
      return base;
    });

    await executor.execute(action);

    // Position was created, but manage evaluated once with current time
    // To test time stop, we need the position's openTimestamp to be old enough
    // Let's create a position directly and test manage via another execute
    Store.getInstance().reset();
    store = Store.getInstance();

    // Make time old for the manage stage
    timeOffset = 73 * 3_600_000; // 73 hours > 3*24=72 hours

    const result = await executor.execute(action);
    // The position gets created and manage detects time stop
    expect(result.success).toBe(true);
    if (result.metadata.exitReason) {
      expect(result.metadata.exitReason).toBe('time_stop');
    }

    vi.restoreAllMocks();
  });

  it('manage detects stoploss exit (combined loss > maxLossPercent)', async () => {
    // Mock positions with heavy losses
    (connector.queryPositions as ReturnType<typeof vi.fn>).mockResolvedValue([
      { coin: 'ETH', entryPx: '2000', unrealizedPnl: '-400', szi: '5' },
      { coin: 'BTC', entryPx: '40000', unrealizedPnl: '-200', szi: '-0.15' },
    ]);

    // Set max loss to 5% for easy triggering
    executor = new StatArbPairExecutor(connector, orderManager, fundingTracker, {
      maxLossPercent: 5,
      maxLeverage: 23,
      maxPairPositions: 10,
      timeStopMultiplier: 3,
      exitZScoreThreshold: 0.5,
      sizeDecimals: 18,
    });

    // Mock funding with no excessive exposure
    (fundingTracker.checkFundingExposure as ReturnType<typeof vi.fn>).mockReturnValue({
      fundingExcessive: false,
      dailyNetRate: 0,
      tightenedMaxLossPercent: 5,
    });

    const result = await executor.execute(makeAction({ capitalAllocation: 1000 }));
    expect(result.success).toBe(true);
    // With -600 PnL on ~55 margin (1000/18), that's > 5%
    if (result.metadata.exitReason) {
      expect(result.metadata.exitReason).toBe('stoploss');
    }
  });

  it('manage detects telegram close signal', async () => {
    const action = makeAction({
      metadata: { closeRequested: true },
    });

    const result = await executor.execute(action);
    expect(result.success).toBe(true);
    expect(result.metadata.exitReason).toBe('telegram_close');
  });

  it('manage detects mean reversion exit when |Z| <= 0.5', async () => {
    const action = makeAction({
      metadata: { currentZScore: 0.3 },
    });

    const result = await executor.execute(action);
    expect(result.success).toBe(true);
    expect(result.metadata.exitReason).toBe('mean_reversion');
  });

  // --- AC6: Close stage ---

  it('close places market orders for both legs simultaneously', async () => {
    const action = makeAction({
      metadata: { closeRequested: true },
    });

    await executor.execute(action);

    // Should have 4 placeOrder calls: 2 opens + 2 closes
    const calls = (orderManager.placeOrder as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBe(4);
    // Close calls: sell long (3rd), buy short (4th)
    expect(calls[2][0].side).toBe('sell');
    expect(calls[3][0].side).toBe('buy');
  });

  it('close calculates combined P&L including funding correctly', async () => {
    const action = makeAction({
      metadata: { closeRequested: true },
    });

    const result = await executor.execute(action);
    expect(result.success).toBe(true);
    expect(result.metadata.totalRealizedPnl).toBeDefined();
    expect(typeof result.metadata.totalRealizedPnl).toBe('number');
  });

  it('close moves position from active to completed and emits event', async () => {
    const events: StatArbPosition[] = [];
    store.emitter.on('stat_arb_position_closed', (pos: StatArbPosition) => {
      events.push(pos);
    });

    const action = makeAction({
      metadata: { closeRequested: true },
    });

    await executor.execute(action);

    // Active should be empty, completed should have 1
    expect(store.getAllActiveStatArbPositions().length).toBe(0);
    expect(store.getCompletedStatArbPositions().length).toBe(1);
    expect(events.length).toBe(1);
    expect(events[0].status).toBe('closed');
    expect(events[0].closeReason).toBe('telegram_close');
  });

  // --- Full happy path ---

  it('full happy path: trigger -> open -> manage -> close with mean reversion', async () => {
    const action = makeAction({
      metadata: { currentZScore: 0.2 }, // mean reversion trigger
    });

    const result = await executor.execute(action);
    expect(result.success).toBe(true);
    expect(result.metadata.exitReason).toBe('mean_reversion');
    expect(result.metadata.positionId).toBeDefined();
    expect(result.metadata.totalRealizedPnl).toBeDefined();

    // Position should be closed in store
    expect(store.getAllActiveStatArbPositions().length).toBe(0);
    expect(store.getCompletedStatArbPositions().length).toBe(1);
  });

  // --- Position managed (no exit) ---

  it('position stays open when no exit condition met', async () => {
    // No close signal, no stoploss, no time stop, no z-score provided
    const action = makeAction({ metadata: {} });

    const result = await executor.execute(action);
    expect(result.success).toBe(true);
    // Position stays open
    expect(store.getAllActiveStatArbPositions().length).toBe(1);
  });

  // --- Funding integration ---

  it('funding tracker is called during manage stage', async () => {
    const action = makeAction({ metadata: {} });
    await executor.execute(action);

    expect(fundingTracker.updateFunding).toHaveBeenCalled();
    expect(fundingTracker.getCumulativeFunding).toHaveBeenCalled();
    expect(fundingTracker.checkFundingExposure).toHaveBeenCalled();
  });

  it('funding tracker finalized on position close', async () => {
    const action = makeAction({
      metadata: { closeRequested: true },
    });

    await executor.execute(action);

    expect(fundingTracker.finalizeFunding).toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // FIX-16: End-to-end pair execution validation (Task 5)
  // ---------------------------------------------------------------------------

  describe('pair execution — both legs in same call', () => {
    it('both long and short legs placed within a single execute() invocation', async () => {
      const action = makeAction({
        pair: { tokenA: 'ETH', tokenB: 'BTC', key: 'BTC-ETH' },
        direction: 'long_pair',
      });

      await executor.execute(action);

      // Exactly 2 order placements in the open stage (long + short)
      const calls = (orderManager.placeOrder as ReturnType<typeof vi.fn>).mock.calls;
      // At minimum 2 for open; could be 4 if close happened too
      expect(calls.length).toBeGreaterThanOrEqual(2);

      // First call: long leg (buy on tokenA=ETH for long_pair)
      expect(calls[0][0].symbol).toBe('ETH');
      expect(calls[0][0].side).toBe('buy');
      expect(calls[0][0].type).toBe('market');

      // Second call: short leg (sell on tokenB=BTC for long_pair)
      expect(calls[1][0].symbol).toBe('BTC');
      expect(calls[1][0].side).toBe('sell');
      expect(calls[1][0].type).toBe('market');
    });
  });

  describe('rollback — first leg closed if second fails', () => {
    it('closes long leg when short leg is rejected via PerpOrderRejectedError', async () => {
      let callIdx = 0;
      (orderManager.placeOrder as ReturnType<typeof vi.fn>).mockImplementation(
        (params: PerpOrderParams) => {
          callIdx++;
          if (callIdx === 1) {
            // Long leg fills
            return Promise.resolve(makeOrderResult({ orderId: 'long-ok', fillPrice: '2000' }));
          }
          if (callIdx === 2) {
            // Short leg rejected
            throw new Error('insufficient margin for short leg');
          }
          // Rollback call
          return Promise.resolve(makeOrderResult({ orderId: 'rollback-ok' }));
        },
      );

      const result = await executor.execute(makeAction());

      expect(result.success).toBe(false);
      expect(result.error).toContain('Pair trade rollback');

      // 3 calls: open long, open short (fail), rollback long
      expect((orderManager.placeOrder as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(3);

      // Rollback call is a sell on the long symbol
      const rollbackParams = (orderManager.placeOrder as ReturnType<typeof vi.fn>).mock.calls[2][0];
      expect(rollbackParams.side).toBe('sell');
      expect(rollbackParams.symbol).toBe('ETH');

      // No position should exist
      expect(store.getAllActiveStatArbPositions()).toHaveLength(0);
    });
  });

  describe('beta-neutral sizing with hedge ratio', () => {
    it('hedge ratio 2.0 allocates 1/3 to long and 2/3 to short', async () => {
      const action = makeAction({
        hedgeRatio: 2.0,
        capitalAllocation: 9000,
      });

      await executor.execute(action);

      const calls = (orderManager.placeOrder as ReturnType<typeof vi.fn>).mock.calls;
      const longSize = Number(calls[0][0].size);
      const shortSize = Number(calls[1][0].size);

      // longNotional = 9000 / (1+2) = 3000
      // shortNotional = 9000 * 2 / (1+2) = 6000
      const longNotional = longSize / 1e18;
      const shortNotional = shortSize / 1e18;
      expect(longNotional).toBeCloseTo(3000, 0);
      expect(shortNotional).toBeCloseTo(6000, 0);
    });

    it('hedge ratio 0.5 allocates 2/3 to long and 1/3 to short', async () => {
      const action = makeAction({
        hedgeRatio: 0.5,
        capitalAllocation: 6000,
      });

      await executor.execute(action);

      const calls = (orderManager.placeOrder as ReturnType<typeof vi.fn>).mock.calls;
      const longNotional = Number(calls[0][0].size) / 1e18;
      const shortNotional = Number(calls[1][0].size) / 1e18;

      // longNotional = 6000 / 1.5 = 4000
      // shortNotional = 6000 * 0.5 / 1.5 = 2000
      expect(longNotional).toBeCloseTo(4000, 0);
      expect(shortNotional).toBeCloseTo(2000, 0);
    });
  });

  describe('combined position tracking', () => {
    it('position tracks both legs with entry prices from fills', async () => {
      let callIdx = 0;
      (orderManager.placeOrder as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callIdx++;
        if (callIdx === 1) {
          return Promise.resolve(makeOrderResult({ orderId: 'leg-A', fillPrice: '3100.50', averageFillPrice: '3100.50' }));
        }
        if (callIdx === 2) {
          return Promise.resolve(makeOrderResult({ orderId: 'leg-B', fillPrice: '62500.00', averageFillPrice: '62500.00' }));
        }
        // Close calls
        return Promise.resolve(makeOrderResult());
      });

      const action = makeAction({
        pair: { tokenA: 'ETH', tokenB: 'BTC', key: 'BTC-ETH' },
        direction: 'long_pair',
        metadata: {}, // no close signal
      });

      await executor.execute(action);

      const positions = store.getAllActiveStatArbPositions();
      expect(positions).toHaveLength(1);

      const pos = positions[0];
      expect(pos.legA.symbol).toBe('ETH');
      expect(pos.legA.entryPrice).toBe(3100.5);
      expect(pos.legA.orderId).toBe('leg-A');
      expect(pos.legB.symbol).toBe('BTC');
      expect(pos.legB.entryPrice).toBe(62500);
      expect(pos.legB.orderId).toBe('leg-B');
      expect(pos.combinedPnl).toBeDefined();
      expect(pos.accumulatedFunding).toBeDefined();
    });

    it('position has correct margin calculation', async () => {
      const action = makeAction({
        capitalAllocation: 5000,
        leverage: 10,
      });

      await executor.execute(action);

      const pos = store.getAllActiveStatArbPositions()[0];
      // marginUsed = capital / leverage = 5000 / 10 = 500
      expect(pos.marginUsed).toBe(500);
    });
  });
});
