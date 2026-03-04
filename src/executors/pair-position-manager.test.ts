import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PairPositionManager } from './pair-position-manager.js';
import { Store } from '../core/store.js';
import type { StatArbPosition, StatArbLeg, StatArbSignal } from '../core/store-slices/stat-arb-slice.js';
import type { HyperliquidOrderManager, PerpOrderResult, PerpOrderParams } from '../connectors/hyperliquid-order-manager.js';
import type { FundingRateTracker } from '../stat-arb/funding-rate-tracker.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOrderResult(overrides: Partial<PerpOrderResult> = {}): PerpOrderResult {
  return {
    orderId: `order-${Date.now()}`,
    status: 'filled',
    fillPrice: '40000',
    fillSize: '1.0',
    averageFillPrice: '40000',
    remainingSize: '0',
    fees: '2.50',
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeLeg(overrides: Partial<StatArbLeg> = {}): StatArbLeg {
  return {
    symbol: 'ETH',
    side: 'long',
    size: 5,
    entryPrice: 3000,
    currentPrice: 3100,
    unrealizedPnl: 500,
    funding: 0,
    orderId: 'open-order-1',
    ...overrides,
  };
}

function makePosition(overrides: Partial<StatArbPosition> = {}): StatArbPosition {
  return {
    positionId: 'pos-1',
    pair: { tokenA: 'BTC', tokenB: 'ETH', key: 'BTC-ETH' },
    direction: 'long_pair',
    hedgeRatio: 1.5,
    leverage: 18,
    legA: makeLeg({ symbol: 'BTC', side: 'long', size: 4, entryPrice: 40000, currentPrice: 41000, unrealizedPnl: 72000 }),
    legB: makeLeg({ symbol: 'ETH', side: 'short', size: 6, entryPrice: 3000, currentPrice: 2900, unrealizedPnl: 10800 }),
    openTimestamp: Date.now() - 3_600_000, // 1 hour ago
    halfLifeHours: 24,
    combinedPnl: 82800,
    accumulatedFunding: 0,
    marginUsed: 555.56,
    status: 'active',
    signalSource: 'native',
    ...overrides,
  };
}

function makeMockOrderManager(): HyperliquidOrderManager {
  return {
    placeOrder: vi.fn().mockResolvedValue(makeOrderResult()),
    cancelOrder: vi.fn(),
    getOrderStatus: vi.fn(),
    updatePartialFill: vi.fn(),
  } as unknown as HyperliquidOrderManager;
}

function makeMockFundingTracker(): FundingRateTracker {
  return {
    updateFunding: vi.fn().mockResolvedValue(null),
    getCumulativeFunding: vi.fn().mockReturnValue({
      longTotal: 0n,
      shortTotal: 0n,
      netTotal: 5000000000000000n, // 0.005 in 18-decimal
      dailyRate: 0.001,
      history: [],
    }),
    checkFundingExposure: vi.fn().mockReturnValue({
      fundingExcessive: false,
      dailyNetRate: 0.001,
      tightenedMaxLossPercent: 30,
    }),
    finalizeFunding: vi.fn(),
  } as unknown as FundingRateTracker;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PairPositionManager', () => {
  let store: Store;
  let orderManager: ReturnType<typeof makeMockOrderManager>;
  let fundingTracker: ReturnType<typeof makeMockFundingTracker>;
  let manager: PairPositionManager;

  beforeEach(() => {
    store = Store.getInstance();
    store.reset();
    vi.clearAllMocks();

    orderManager = makeMockOrderManager();
    fundingTracker = makeMockFundingTracker();
    manager = new PairPositionManager(orderManager, fundingTracker, undefined, store);
  });

  // ── AC1: Simultaneous close ──────────────────────────────────────────

  describe('closePosition (AC1)', () => {
    it('places market sell for long leg and market buy for short leg', async () => {
      const pos = makePosition();
      store.openStatArbPosition(pos);

      await manager.closePosition('pos-1', 'mean_reversion');

      const calls = (orderManager.placeOrder as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls).toHaveLength(2);

      // Long close = sell
      expect(calls[0][0]).toMatchObject({
        symbol: 'BTC',
        side: 'sell',
        type: 'market',
      });

      // Short close = buy
      expect(calls[1][0]).toMatchObject({
        symbol: 'ETH',
        side: 'buy',
        type: 'market',
      });
    });

    it('throws when position not found', async () => {
      await expect(manager.closePosition('nonexistent', 'manual')).rejects.toThrow(
        'Position not found or already closed',
      );
    });
  });

  // ── AC2: Realized P&L calculation ─────────────────────────────────────

  describe('realized P&L calculation (AC2)', () => {
    it('calculates correct P&L for profitable pair', async () => {
      const pos = makePosition();
      store.openStatArbPosition(pos);

      // Long exit at 42000, short exit at 2800
      (orderManager.placeOrder as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(makeOrderResult({ fillPrice: '42000', fees: '3.00' }))
        .mockResolvedValueOnce(makeOrderResult({ fillPrice: '2800', fees: '2.00' }));

      const result = await manager.closePosition('pos-1', 'mean_reversion');

      // Long P&L: (42000 - 40000) * 4 * 18 = 144000
      expect(result.longRealizedPnl).toBe(144000);

      // Short P&L: (3000 - 2800) * 6 * 18 = 21600
      expect(result.shortRealizedPnl).toBe(21600);

      // Funding: 0.005
      expect(result.fundingPnl).toBeCloseTo(0.005, 4);

      // Fees: 3.00 + 2.00 = 5.00
      expect(result.totalFees).toBe(5);

      // Net = 144000 + 21600 + 0.005 - 5 ≈ 165595.005
      expect(result.netPnl).toBeCloseTo(165595.005, 2);
    });

    it('calculates P&L correctly when one leg is negative but combined is positive', async () => {
      const pos = makePosition();
      store.openStatArbPosition(pos);

      // Long loses (exit below entry), short wins more
      (orderManager.placeOrder as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(makeOrderResult({ fillPrice: '39000', fees: '1.00' })) // long down
        .mockResolvedValueOnce(makeOrderResult({ fillPrice: '2500', fees: '1.00' })); // short up big

      const result = await manager.closePosition('pos-1', 'stoploss');

      // Long P&L: (39000 - 40000) * 4 * 18 = -72000
      expect(result.longRealizedPnl).toBe(-72000);

      // Short P&L: (3000 - 2500) * 6 * 18 = 54000
      expect(result.shortRealizedPnl).toBe(54000);

      // Net: -72000 + 54000 + 0.005 - 2 = -18001.995
      expect(result.netPnl).toBeCloseTo(-18001.995, 2);
    });

    it('includes accumulated funding payments', async () => {
      const pos = makePosition();
      store.openStatArbPosition(pos);

      // Large negative funding
      (fundingTracker.getCumulativeFunding as ReturnType<typeof vi.fn>).mockReturnValue({
        longTotal: 0n,
        shortTotal: 0n,
        netTotal: -1000000000000000000n, // -1.0
        dailyRate: -0.5,
        history: [],
      });

      (orderManager.placeOrder as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(makeOrderResult({ fillPrice: '40000', fees: '0' }))
        .mockResolvedValueOnce(makeOrderResult({ fillPrice: '3000', fees: '0' }));

      const result = await manager.closePosition('pos-1', 'manual');

      // Long: (40000-40000)*4*18 = 0, Short: (3000-3000)*6*18 = 0
      // Net = 0 + 0 + (-1.0) - 0 = -1.0
      expect(result.fundingPnl).toBe(-1);
      expect(result.netPnl).toBe(-1);
    });

    it('deducts trading fees from close orders', async () => {
      const pos = makePosition();
      store.openStatArbPosition(pos);

      (orderManager.placeOrder as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(makeOrderResult({ fillPrice: '40000', fees: '10.50' }))
        .mockResolvedValueOnce(makeOrderResult({ fillPrice: '3000', fees: '8.25' }));

      (fundingTracker.getCumulativeFunding as ReturnType<typeof vi.fn>).mockReturnValue({
        longTotal: 0n, shortTotal: 0n, netTotal: 0n, dailyRate: 0, history: [],
      });

      const result = await manager.closePosition('pos-1', 'time_stop');

      expect(result.totalFees).toBe(18.75);
      // P&L = 0 + 0 + 0 - 18.75 = -18.75
      expect(result.netPnl).toBe(-18.75);
    });

    it('return percentage calculated correctly (Task 3.6)', async () => {
      const pos = makePosition({ marginUsed: 10000 });
      store.openStatArbPosition(pos);

      // Both legs flat — only fees affect P&L
      (orderManager.placeOrder as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(makeOrderResult({ fillPrice: '40000', fees: '0' }))
        .mockResolvedValueOnce(makeOrderResult({ fillPrice: '3000', fees: '0' }));

      (fundingTracker.getCumulativeFunding as ReturnType<typeof vi.fn>).mockReturnValue({
        longTotal: 0n, shortTotal: 0n, netTotal: 0n, dailyRate: 0, history: [],
      });

      const result = await manager.closePosition('pos-1', 'mean_reversion');

      // Net P&L = 0, so return % = 0/10000 * 100 = 0%
      const returnPercent = pos.marginUsed > 0 ? (result.netPnl / pos.marginUsed) * 100 : 0;
      expect(returnPercent).toBe(0);
    });
  });

  // ── AC3: Mean reversion exit ──────────────────────────────────────────

  describe('evaluateMeanReversionExit (AC3)', () => {
    it('triggers at |Z| = 0.5', () => {
      const pos = makePosition();
      const result = manager.evaluateMeanReversionExit(pos, 0.5);
      expect(result.shouldExit).toBe(true);
      expect(result.exitReason).toBe('mean_reversion');
    });

    it('triggers at |Z| = 0.3', () => {
      const pos = makePosition();
      const result = manager.evaluateMeanReversionExit(pos, -0.3);
      expect(result.shouldExit).toBe(true);
      expect(result.exitReason).toBe('mean_reversion');
    });

    it('does NOT trigger at |Z| = 0.8', () => {
      const pos = makePosition();
      const result = manager.evaluateMeanReversionExit(pos, 0.8);
      expect(result.shouldExit).toBe(false);
      expect(result.exitReason).toBeNull();
    });
  });

  // ── AC4: Time stop exit ───────────────────────────────────────────────

  describe('evaluateTimeStopExit (AC4)', () => {
    it('triggers at exactly 3x half-life + 1ms', () => {
      const pos = makePosition({
        openTimestamp: 1000,
        halfLifeHours: 10,
      });
      // 3x half-life = 30h = 108_000_000ms, so trigger at 1000 + 108_000_001
      const result = manager.evaluateTimeStopExit(pos, 1000 + 108_000_001);
      expect(result.shouldExit).toBe(true);
      expect(result.exitReason).toBe('time_stop');
    });

    it('does NOT trigger before 3x half-life', () => {
      const pos = makePosition({
        openTimestamp: 1000,
        halfLifeHours: 10,
      });
      // 3x half-life = 108_000_000ms, check at exactly that point (not exceeded)
      const result = manager.evaluateTimeStopExit(pos, 1000 + 108_000_000);
      expect(result.shouldExit).toBe(false);
      expect(result.exitReason).toBeNull();
    });
  });

  // ── AC5: Stoploss exit ────────────────────────────────────────────────

  describe('evaluateStoplossExit (AC5)', () => {
    it('triggers when combined loss exceeds maxLossPercent', () => {
      const pos = makePosition({ marginUsed: 1000 });
      // -30% of 1000 = -300, so -301 should trigger (default maxLossPercent=30)
      const result = manager.evaluateStoplossExit(pos, -301);
      expect(result.shouldExit).toBe(true);
      expect(result.exitReason).toBe('stoploss');
    });

    it('does NOT trigger on individual leg loss when combined is fine', () => {
      // legA.unrealizedPnl = -500, legB.unrealizedPnl = +400
      const pos = makePosition({
        marginUsed: 1000,
        legA: makeLeg({ unrealizedPnl: -500 }),
        legB: makeLeg({ unrealizedPnl: 400 }),
      });
      // Combined = -100, which is -10% of margin=1000 (below 30% threshold)
      const result = manager.evaluateStoplossExit(pos, -100);
      expect(result.shouldExit).toBe(false);
    });

    it('does NOT trigger at exactly maxLossPercent boundary', () => {
      const pos = makePosition({ marginUsed: 1000 });
      // Exactly -30% of 1000 = -300, calculateStoplossBreached checks < -stoplossPercent
      const result = manager.evaluateStoplossExit(pos, -300);
      expect(result.shouldExit).toBe(false);
    });
  });

  // ── AC6: Telegram close signal ────────────────────────────────────────

  describe('evaluateTelegramCloseExit (AC6)', () => {
    it('triggers exit for matching pair signal', () => {
      const pos = makePosition({
        openTimestamp: 1000,
      });

      // Add a signal for this pair
      const signal: StatArbSignal = {
        signalId: 'sig-telegram-1',
        pair: { tokenA: 'BTC', tokenB: 'ETH', key: 'BTC-ETH' },
        direction: 'long_pair',
        zScore: 2.5,
        correlation: 0.9,
        halfLifeHours: 24,
        hedgeRatio: 1.5,
        recommendedLeverage: 18,
        source: 'telegram',
        timestamp: 2000, // After position open
        consumed: false,
        expiresAt: Date.now() + 3_600_000,
      };
      store.addStatArbSignal(signal);

      const result = manager.evaluateTelegramCloseExit(pos);
      expect(result.shouldExit).toBe(true);
      expect(result.exitReason).toBe('telegram_close');
      expect(result.metadata.telegramSignalId).toBe('sig-telegram-1');
    });

    it('ignores signal if timestamp is before position entry', () => {
      const pos = makePosition({
        openTimestamp: 5000,
      });

      const signal: StatArbSignal = {
        signalId: 'sig-old',
        pair: { tokenA: 'BTC', tokenB: 'ETH', key: 'BTC-ETH' },
        direction: 'long_pair',
        zScore: 2.5,
        correlation: 0.9,
        halfLifeHours: 24,
        hedgeRatio: 1.5,
        recommendedLeverage: 18,
        source: 'telegram',
        timestamp: 1000, // Before position open
        consumed: false,
        expiresAt: Date.now() + 3_600_000,
      };
      store.addStatArbSignal(signal);

      const result = manager.evaluateTelegramCloseExit(pos);
      expect(result.shouldExit).toBe(false);
    });
  });

  // ── AC7: Close order failure handling ─────────────────────────────────

  describe('close failure handling (AC7)', () => {
    it('retries once then succeeds', async () => {
      const pos = makePosition();
      store.openStatArbPosition(pos);

      (orderManager.placeOrder as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(new Error('network timeout'))
        .mockResolvedValueOnce(makeOrderResult({ fillPrice: '40000' }))
        .mockResolvedValueOnce(makeOrderResult({ fillPrice: '3000' }));

      const result = await manager.closePosition('pos-1', 'manual');
      expect(result.positionId).toBe('pos-1');

      // 3 calls: first fail + retry success + short close
      expect(orderManager.placeOrder).toHaveBeenCalledTimes(3);
    });

    it('throws after retry fails with FATAL log', async () => {
      const pos = makePosition();
      store.openStatArbPosition(pos);

      (orderManager.placeOrder as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(new Error('first fail'))
        .mockRejectedValueOnce(new Error('retry fail'));

      await expect(manager.closePosition('pos-1', 'stoploss')).rejects.toThrow('retry fail');
    });
  });

  // ── AC8: Position status update ───────────────────────────────────────

  describe('position status update on close (AC8)', () => {
    it('moves position from active to completed map', async () => {
      const pos = makePosition();
      store.openStatArbPosition(pos);

      expect(store.getActiveStatArbPosition('pos-1')).toBeDefined();

      await manager.closePosition('pos-1', 'mean_reversion');

      expect(store.getActiveStatArbPosition('pos-1')).toBeUndefined();
      expect(store.getCompletedStatArbPositions()).toHaveLength(1);
    });

    it('emits stat_arb_position_closed event', async () => {
      const pos = makePosition();
      store.openStatArbPosition(pos);

      const closedPositions: StatArbPosition[] = [];
      store.emitter.on('stat_arb_position_closed', (p: StatArbPosition) => closedPositions.push(p));

      await manager.closePosition('pos-1', 'time_stop');

      expect(closedPositions).toHaveLength(1);
      expect(closedPositions[0].closeReason).toBe('time_stop');
    });

    it('finalizes funding tracker on close', async () => {
      const pos = makePosition();
      store.openStatArbPosition(pos);

      await manager.closePosition('pos-1', 'manual');

      expect(fundingTracker.finalizeFunding).toHaveBeenCalledWith('pos-1');
    });
  });

  // ── evaluateAllExitConditions ─────────────────────────────────────────

  describe('evaluateAllExitConditions', () => {
    it('stoploss takes priority over other exits', () => {
      const pos = makePosition({ marginUsed: 1000, openTimestamp: 0, halfLifeHours: 1 });

      // Combined loss exceeds 30%, AND time exceeds 3x half-life, AND Z is low
      const result = manager.evaluateAllExitConditions(
        pos,
        0.1,        // Z below threshold (mean reversion)
        Date.now(),  // well past 3 hours (time stop)
        -400,        // -40% loss (stoploss)
      );

      expect(result.exitReason).toBe('stoploss');
    });

    it('returns no exit when nothing triggers', () => {
      const pos = makePosition({
        marginUsed: 1000,
        openTimestamp: Date.now() - 1_000,
        halfLifeHours: 24,
      });

      const result = manager.evaluateAllExitConditions(
        pos,
        2.0,         // Z still high
        Date.now(),  // only 1 second in
        10,          // positive P&L
      );

      expect(result.shouldExit).toBe(false);
      expect(result.exitReason).toBeNull();
    });
  });
});
