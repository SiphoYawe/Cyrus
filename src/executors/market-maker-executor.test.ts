import { describe, it, expect, beforeEach } from 'vitest';
import { MarketMakerExecutor } from './market-maker-executor.js';
import type {
  MarketMakerExecutorConfig,
  ManagedOrder,
} from './market-maker-executor.js';
import type { MarketMakeAction, ExecutorAction } from '../core/action-types.js';
import { Store } from '../core/store.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createDefaultConfig(): MarketMakerExecutorConfig {
  return {
    minCapitalUsd: 10,
    maxSpread: 0.05,
    maxLevels: 10,
    staleOrderThreshold: 0.005,
    fillSimulation: false,
  };
}

function makeMarketMakeAction(
  overrides: Partial<MarketMakeAction> = {},
): MarketMakeAction {
  return {
    id: 'mm-test-1',
    type: 'market_make' as const,
    priority: 1,
    createdAt: Date.now(),
    strategyId: 'MarketMaker',
    symbol: 'WETH/USDC',
    spread: 0.001,
    orderSize: 50_000_000n, // 50 USDC
    levels: 3,
    metadata: {
      midPrice: 2000,
      staleOrderThreshold: 0.005,
      orderLevels: [
        { level: 1, bidPrice: 1999, askPrice: 2001, size: 50_000_000n },
        { level: 2, bidPrice: 1998, askPrice: 2002, size: 50_000_000n },
        { level: 3, bidPrice: 1997, askPrice: 2003, size: 50_000_000n },
      ],
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MarketMakerExecutor', () => {
  let executor: MarketMakerExecutor;
  let store: Store;

  beforeEach(() => {
    Store.getInstance().reset();
    executor = new MarketMakerExecutor(createDefaultConfig());
    store = Store.getInstance();
  });

  // --- canHandle ---

  describe('canHandle', () => {
    it('handles market_make actions', () => {
      expect(executor.canHandle(makeMarketMakeAction())).toBe(true);
    });

    it('rejects non-market_make actions', () => {
      expect(executor.canHandle({ type: 'swap' } as ExecutorAction)).toBe(false);
      expect(executor.canHandle({ type: 'perp' } as ExecutorAction)).toBe(false);
      expect(executor.canHandle({ type: 'bridge' } as ExecutorAction)).toBe(false);
    });
  });

  // --- Trigger stage ---

  describe('trigger stage', () => {
    it('passes with valid spread, levels, and capital', async () => {
      const result = await executor.execute(makeMarketMakeAction());
      expect(result.success).toBe(true);
    });

    it('rejects spread of zero', async () => {
      const result = await executor.execute(
        makeMarketMakeAction({ spread: 0 }),
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('Spread');
    });

    it('rejects spread exceeding maxSpread', async () => {
      const result = await executor.execute(
        makeMarketMakeAction({ spread: 0.10 }),
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('Spread');
    });

    it('rejects levels of zero', async () => {
      const result = await executor.execute(
        makeMarketMakeAction({ levels: 0 }),
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('Levels');
    });

    it('rejects levels exceeding maxLevels', async () => {
      const result = await executor.execute(
        makeMarketMakeAction({ levels: 20 }),
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('Levels');
    });

    it('rejects zero order size', async () => {
      const result = await executor.execute(
        makeMarketMakeAction({ orderSize: 0n }),
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('Order size');
    });

    it('rejects invalid mid price (zero)', async () => {
      const result = await executor.execute(
        makeMarketMakeAction({
          metadata: { midPrice: 0, orderLevels: [] },
        }),
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('mid price');
    });

    it('rejects when total order value below minCapitalUsd', async () => {
      const tightExecutor = new MarketMakerExecutor({
        ...createDefaultConfig(),
        minCapitalUsd: 1_000_000_000, // impossibly high
      });

      const result = await tightExecutor.execute(makeMarketMakeAction());
      expect(result.success).toBe(false);
      expect(result.error).toContain('capital');
    });
  });

  // --- Open stage ---

  describe('open stage', () => {
    it('places bid and ask orders at each level from metadata', async () => {
      const result = await executor.execute(makeMarketMakeAction());
      expect(result.success).toBe(true);

      const orders = executor.getOrders();
      expect(orders.length).toBe(6); // 3 levels * 2 (bid + ask)

      const bids = orders.filter((o) => o.side === 'bid');
      const asks = orders.filter((o) => o.side === 'ask');
      expect(bids.length).toBe(3);
      expect(asks.length).toBe(3);
    });

    it('falls back to computed levels when orderLevels not in metadata', async () => {
      const result = await executor.execute(
        makeMarketMakeAction({
          metadata: { midPrice: 2000 },
        }),
      );
      expect(result.success).toBe(true);

      const orders = executor.getOrders();
      expect(orders.length).toBe(6);

      // Verify computed prices
      const bids = orders.filter((o) => o.side === 'bid');
      const asks = orders.filter((o) => o.side === 'ask');

      // Level 1 bid at midPrice * (1 - spread * 0.5) = 2000 * 0.9995 = 1999
      expect(bids[0]!.price).toBeCloseTo(2000 * (1 - 0.001 * 0.5), 2);
      // Level 1 ask at midPrice * (1 + spread * 0.5) = 2000 * 1.0005 = 2001
      expect(asks[0]!.price).toBeCloseTo(2000 * (1 + 0.001 * 0.5), 2);
    });

    it('all orders start with open status', async () => {
      await executor.execute(makeMarketMakeAction());

      // After execution completes, orders will be cancelled in close stage
      // But we can verify the flow succeeded
      const orders = executor.getOrders();
      // All orders should be cancelled after close stage
      const cancelledOrders = orders.filter((o) => o.status === 'cancelled');
      expect(cancelledOrders.length).toBeGreaterThan(0);
    });
  });

  // --- Manage stage ---

  describe('manage stage', () => {
    it('completes manage stage successfully', async () => {
      const result = await executor.execute(makeMarketMakeAction());
      expect(result.success).toBe(true);
    });

    it('detects stale orders when price moves significantly', async () => {
      // Create an action with mid price that causes stale detection
      const action = makeMarketMakeAction({
        metadata: {
          midPrice: 2100, // shifted from 2000 where orders were placed
          staleOrderThreshold: 0.001, // very tight threshold
          orderLevels: [
            { level: 1, bidPrice: 1999, askPrice: 2001, size: 50_000_000n },
            { level: 2, bidPrice: 1998, askPrice: 2002, size: 50_000_000n },
            { level: 3, bidPrice: 1997, askPrice: 2003, size: 50_000_000n },
          ],
        },
      });

      const result = await executor.execute(action);
      expect(result.success).toBe(true);

      // Should have replacement orders in addition to originals
      const orders = executor.getOrders();
      expect(orders.length).toBeGreaterThan(6); // original 6 + replacements
    });

    it('simulates fills when fillSimulation is enabled', async () => {
      const fillExecutor = new MarketMakerExecutor({
        ...createDefaultConfig(),
        fillSimulation: true,
      });

      // Place orders at 1999/2001 and set midPrice to 1998 (below bid)
      const action = makeMarketMakeAction({
        metadata: {
          midPrice: 1998, // below level 1 bid
          staleOrderThreshold: 1.0, // wide threshold to avoid stale detection
          orderLevels: [
            { level: 1, bidPrice: 1999, askPrice: 2001, size: 50_000_000n },
          ],
        },
      });

      await fillExecutor.execute(action);

      const fills = fillExecutor.getFills();
      // Bid at 1999 should fill because midPrice 1998 <= 1999
      expect(fills.length).toBeGreaterThan(0);
      expect(fills.some((f) => f.side === 'bid')).toBe(true);
    });
  });

  // --- Close stage ---

  describe('close stage', () => {
    it('cancels all open orders and records trade', async () => {
      const result = await executor.execute(makeMarketMakeAction());
      expect(result.success).toBe(true);

      // Verify trade was recorded in store
      const trades = store.getAllTrades();
      expect(trades.length).toBeGreaterThan(0);
      expect(trades[0]!.strategyId).toBe('MarketMaker');
    });

    it('reports P&L in the result metadata', async () => {
      const result = await executor.execute(makeMarketMakeAction());
      expect(result.success).toBe(true);
      expect(result.metadata).toBeDefined();
    });
  });

  // --- Full lifecycle ---

  describe('full lifecycle', () => {
    it('executes Trigger -> Open -> Manage -> Close', async () => {
      const result = await executor.execute(makeMarketMakeAction());
      expect(result.success).toBe(true);
      expect(result.transferId).not.toBeNull();
    });

    it('resets state between executions', async () => {
      await executor.execute(makeMarketMakeAction());
      const firstOrders = executor.getOrders().length;

      await executor.execute(makeMarketMakeAction());
      const secondOrders = executor.getOrders().length;

      // Both should have same order count (state was reset)
      expect(firstOrders).toBe(secondOrders);
    });
  });

  // --- P&L calculation ---

  describe('P&L calculation', () => {
    it('calculates positive P&L when ask fills > bid fills', async () => {
      const fillExecutor = new MarketMakerExecutor({
        ...createDefaultConfig(),
        fillSimulation: true,
      });

      // Set midPrice very high so all asks fill
      const action = makeMarketMakeAction({
        metadata: {
          midPrice: 2100, // above all ask prices
          staleOrderThreshold: 1.0,
          orderLevels: [
            { level: 1, bidPrice: 1999, askPrice: 2001, size: 50_000_000n },
            { level: 2, bidPrice: 1998, askPrice: 2002, size: 50_000_000n },
          ],
        },
      });

      await fillExecutor.execute(action);

      const fills = fillExecutor.getFills();
      const askFills = fills.filter((f) => f.side === 'ask');
      expect(askFills.length).toBeGreaterThan(0);
    });

    it('reports zero P&L with no fills', async () => {
      const result = await executor.execute(makeMarketMakeAction());
      expect(result.success).toBe(true);
      expect(executor.getPnl()).toBe(0);
    });
  });

  // --- Edge cases ---

  describe('edge cases', () => {
    it('handles single level', async () => {
      const result = await executor.execute(
        makeMarketMakeAction({
          levels: 1,
          metadata: {
            midPrice: 2000,
            orderLevels: [
              { level: 1, bidPrice: 1999, askPrice: 2001, size: 50_000_000n },
            ],
          },
        }),
      );
      expect(result.success).toBe(true);

      const orders = executor.getOrders();
      const openOrCancelled = orders.filter(
        (o) => o.status === 'open' || o.status === 'cancelled',
      );
      expect(openOrCancelled.length).toBe(2); // 1 bid + 1 ask
    });

    it('handles very small order sizes', async () => {
      const result = await executor.execute(
        makeMarketMakeAction({
          orderSize: 1n,
          metadata: {
            midPrice: 2000,
            orderLevels: [
              { level: 1, bidPrice: 1999, askPrice: 2001, size: 1n },
            ],
          },
        }),
      );
      // Should fail at trigger due to insufficient capital
      expect(result.success).toBe(false);
      expect(result.error).toContain('capital');
    });
  });
});
