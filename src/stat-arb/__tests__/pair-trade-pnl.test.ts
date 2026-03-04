import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { PairTradePnl } from '../pair-trade-pnl.js';
import { Store } from '../../core/store.js';
import type { StatArbPosition, StatArbLeg } from '../../core/store-slices/stat-arb-slice.js';
import type { FundingRateTracker } from '../funding-rate-tracker.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLeg(overrides: Partial<StatArbLeg> = {}): StatArbLeg {
  return {
    symbol: 'ETH',
    side: 'long',
    size: 5,
    entryPrice: 3000,
    currentPrice: 3100,
    unrealizedPnl: 500,
    funding: 0,
    orderId: 'order-1',
    ...overrides,
  };
}

function makePosition(overrides: Partial<StatArbPosition> = {}): StatArbPosition {
  return {
    positionId: `pos-${Math.random().toString(36).slice(2, 8)}`,
    pair: { tokenA: 'BTC', tokenB: 'ETH', key: 'BTC-ETH' },
    direction: 'long_pair',
    hedgeRatio: 1.5,
    leverage: 18,
    legA: makeLeg({ symbol: 'BTC', side: 'long', size: 4, entryPrice: 40000, currentPrice: 41000, unrealizedPnl: 72000 }),
    legB: makeLeg({ symbol: 'ETH', side: 'short', size: 6, entryPrice: 3000, currentPrice: 2900, unrealizedPnl: 10800 }),
    openTimestamp: Date.now() - 3_600_000,
    halfLifeHours: 24,
    combinedPnl: 82800,
    accumulatedFunding: 0,
    marginUsed: 555.56,
    status: 'active',
    signalSource: 'native',
    ...overrides,
  };
}

function makeMockFundingTracker(): FundingRateTracker {
  return {
    updateFunding: vi.fn().mockResolvedValue(null),
    getCumulativeFunding: vi.fn().mockReturnValue({
      longTotal: 0n,
      shortTotal: 0n,
      netTotal: 0n,
      dailyRate: 0,
      history: [],
    }),
    checkFundingExposure: vi.fn(),
    finalizeFunding: vi.fn(),
  } as unknown as FundingRateTracker;
}

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS stat_arb_positions (
      position_id TEXT PRIMARY KEY,
      pair_id TEXT NOT NULL,
      long_symbol TEXT NOT NULL,
      short_symbol TEXT NOT NULL,
      long_size REAL NOT NULL,
      short_size REAL NOT NULL,
      long_entry_price REAL NOT NULL,
      short_entry_price REAL NOT NULL,
      long_exit_price REAL,
      short_exit_price REAL,
      leverage INTEGER NOT NULL,
      hedge_ratio REAL NOT NULL,
      entry_z_score REAL,
      exit_z_score REAL,
      entry_timestamp INTEGER NOT NULL,
      exit_timestamp INTEGER,
      long_realized_pnl REAL,
      short_realized_pnl REAL,
      cumulative_funding REAL DEFAULT 0,
      total_fees REAL DEFAULT 0,
      net_pnl REAL,
      return_percent REAL,
      exit_reason TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      direction TEXT NOT NULL,
      signal_source TEXT,
      margin_used REAL NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_stat_arb_pair_id ON stat_arb_positions(pair_id);
    CREATE INDEX IF NOT EXISTS idx_stat_arb_status ON stat_arb_positions(status);
  `);
  return db;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PairTradePnl', () => {
  let store: Store;
  let fundingTracker: ReturnType<typeof makeMockFundingTracker>;
  let pnl: PairTradePnl;

  beforeEach(() => {
    store = Store.getInstance();
    store.reset();
    vi.clearAllMocks();

    fundingTracker = makeMockFundingTracker();
    pnl = new PairTradePnl(fundingTracker, undefined, store);
  });

  // ── AC1, AC2: Per-position P&L ───────────────────────────────────────

  describe('getPositionPnl (AC1, AC2)', () => {
    it('returns unrealized P&L for open position using current prices', () => {
      const pos = makePosition({
        positionId: 'pos-open',
        legA: makeLeg({ unrealizedPnl: 72000 }),
        legB: makeLeg({ unrealizedPnl: 10800 }),
        marginUsed: 555.56,
      });
      store.openStatArbPosition(pos);

      const result = pnl.getPositionPnl('pos-open');

      expect(result.isRealized).toBe(false);
      expect(result.longPnl).toBe(72000);
      expect(result.shortPnl).toBe(10800);
      expect(result.netPnl).toBe(82800);
      expect(result.returnPercent).toBeCloseTo((82800 / 555.56) * 100, 0);
    });

    it('throws for nonexistent position', () => {
      expect(() => pnl.getPositionPnl('nonexistent')).toThrow('Position not found');
    });

    it('returns negative P&L for a losing pair', () => {
      // Long down 15%, short up 8%
      const pos = makePosition({
        positionId: 'pos-losing',
        legA: makeLeg({ symbol: 'BTC', side: 'long', unrealizedPnl: -600 }),
        legB: makeLeg({ symbol: 'ETH', side: 'short', unrealizedPnl: -320 }),
        marginUsed: 1000,
      });
      // Negative funding
      (fundingTracker.getCumulativeFunding as ReturnType<typeof vi.fn>).mockReturnValue({
        longTotal: 0n, shortTotal: 0n,
        netTotal: -30000000000000000000n, // -30 USD
        dailyRate: 0, history: [],
      });
      store.openStatArbPosition(pos);

      const result = pnl.getPositionPnl('pos-losing');

      expect(result.longPnl).toBe(-600);
      expect(result.shortPnl).toBe(-320);
      expect(result.fundingPnl).toBe(-30);
      expect(result.netPnl).toBe(-950); // -600 + -320 + -30
      expect(result.returnPercent).toBeCloseTo((-950 / 1000) * 100, 0);
    });

    it('handles one leg deeply negative but combined P&L positive', () => {
      // Long leg down big, but short leg up even more
      const pos = makePosition({
        positionId: 'pos-mixed',
        legA: makeLeg({ symbol: 'BTC', side: 'long', unrealizedPnl: -5000 }),
        legB: makeLeg({ symbol: 'ETH', side: 'short', unrealizedPnl: 7000 }),
        marginUsed: 2000,
      });
      store.openStatArbPosition(pos);

      const result = pnl.getPositionPnl('pos-mixed');

      expect(result.longPnl).toBe(-5000);
      expect(result.shortPnl).toBe(7000);
      expect(result.netPnl).toBe(2000); // -5000 + 7000
      expect(result.returnPercent).toBe(100); // 2000/2000 * 100
    });
  });

  // ── AC3: Realized P&L ────────────────────────────────────────────────

  describe('getPositionPnl realized (AC3)', () => {
    it('calculates realized P&L using exit fill prices', () => {
      const pos = makePosition({
        positionId: 'pos-closed',
        legA: makeLeg({ symbol: 'BTC', side: 'long', size: 4, entryPrice: 40000, currentPrice: 42000 }),
        legB: makeLeg({ symbol: 'ETH', side: 'short', size: 6, entryPrice: 3000, currentPrice: 2800 }),
        leverage: 18,
        marginUsed: 1000,
      });
      store.openStatArbPosition(pos);
      store.closeStatArbPosition('pos-closed', {
        reason: 'mean_reversion',
        closeTimestamp: Date.now(),
        closePnl: 165600,
        legAClosePrice: 42000,
        legBClosePrice: 2800,
      });

      const result = pnl.getPositionPnl('pos-closed');

      expect(result.isRealized).toBe(true);
      // Long: (42000 - 40000) * 4 * 18 = 144000
      expect(result.longPnl).toBe(144000);
      // Short: (3000 - 2800) * 6 * 18 = 21600
      expect(result.shortPnl).toBe(21600);
      expect(result.netPnl).toBe(165600);
    });

    it('includes funding in P&L', () => {
      const pos = makePosition({ positionId: 'pos-funded', marginUsed: 100 });
      store.openStatArbPosition(pos);
      store.closeStatArbPosition('pos-funded', {
        reason: 'time_stop',
        closeTimestamp: Date.now(),
        closePnl: 0,
        legAClosePrice: pos.legA.entryPrice,
        legBClosePrice: pos.legB.entryPrice,
      });

      // Funding of 20 USD
      (fundingTracker.getCumulativeFunding as ReturnType<typeof vi.fn>).mockReturnValue({
        longTotal: 0n, shortTotal: 0n,
        netTotal: 20000000000000000000n, // 20.0
        dailyRate: 0, history: [],
      });

      const result = pnl.getPositionPnl('pos-funded');
      expect(result.fundingPnl).toBe(20);
      expect(result.netPnl).toBe(20); // zero legs + 20 funding
    });
  });

  // ── AC4, AC5, AC6: Aggregate stats ───────────────────────────────────

  describe('getAggregateStats (AC4, AC5, AC6)', () => {
    function addClosedPositions(count: number, pnls: number[]): void {
      for (let i = 0; i < count; i++) {
        const pos = makePosition({
          positionId: `pos-${i}`,
          pair: { tokenA: 'BTC', tokenB: 'ETH', key: `BTC-ETH-${i}` },
          marginUsed: 1000,
          openTimestamp: 1000,
        });
        store.openStatArbPosition(pos);
        store.closeStatArbPosition(`pos-${i}`, {
          reason: pnls[i] > 0 ? 'mean_reversion' : 'stoploss',
          closeTimestamp: 1000 + (i + 1) * 3_600_000, // i+1 hours
          closePnl: pnls[i],
          legAClosePrice: 40000,
          legBClosePrice: 3000,
        });
      }
    }

    it('win rate: 3 wins, 2 losses -> 60%', () => {
      addClosedPositions(5, [100, 200, -50, 150, -100]);
      const stats = pnl.getAggregateStats();

      expect(stats.totalClosed).toBe(5);
      expect(stats.winRate).toBe(60);
    });

    it('profit factor: gross profit 450, gross loss 150 -> 3.0', () => {
      addClosedPositions(5, [100, 200, -50, 150, -100]);
      const stats = pnl.getAggregateStats();

      // Profit: 100+200+150 = 450, Loss: 50+100 = 150
      expect(stats.profitFactor).toBe(3);
    });

    it('profit factor with zero losses -> Infinity', () => {
      addClosedPositions(3, [100, 200, 50]);
      const stats = pnl.getAggregateStats();

      expect(stats.profitFactor).toBe(Infinity);
    });

    it('total net P&L sums all closed positions', () => {
      addClosedPositions(4, [100, -50, 200, -30]);
      const stats = pnl.getAggregateStats();

      expect(stats.totalNetPnl).toBe(220);
    });

    it('best and worst trade identified correctly', () => {
      addClosedPositions(4, [100, -50, 200, -30]);
      const stats = pnl.getAggregateStats();

      expect(stats.bestTrade).toBe(200);
      expect(stats.worstTrade).toBe(-50);
    });

    it('average holding period calculation', () => {
      addClosedPositions(3, [100, 200, 50]);
      const stats = pnl.getAggregateStats();

      // pos-0: 1h, pos-1: 2h, pos-2: 3h => avg = 2h
      expect(stats.avgHoldingPeriodHours).toBe(2);
    });

    it('returns zeros for no closed positions', () => {
      const pos = makePosition({ positionId: 'open-1' });
      store.openStatArbPosition(pos);

      const stats = pnl.getAggregateStats();
      expect(stats.totalClosed).toBe(0);
      expect(stats.winRate).toBe(0);
      expect(stats.profitFactor).toBe(0);
      expect(stats.totalOpen).toBe(1);
    });
  });

  // ── AC8: Stats by exit reason ─────────────────────────────────────────

  describe('getStatsByExitReason (AC8)', () => {
    it('groups stats by exit reason with correct metrics', () => {
      // 2 mean_reversion wins, 2 stoploss losses, 1 time_stop win
      const positions = [
        { id: 'p1', reason: 'mean_reversion' as const, pnl: 100 },
        { id: 'p2', reason: 'mean_reversion' as const, pnl: 200 },
        { id: 'p3', reason: 'stoploss' as const, pnl: -50 },
        { id: 'p4', reason: 'stoploss' as const, pnl: -100 },
        { id: 'p5', reason: 'time_stop' as const, pnl: 30 },
      ];

      for (const { id, reason, pnl: closePnl } of positions) {
        const pos = makePosition({
          positionId: id,
          pair: { tokenA: 'BTC', tokenB: 'ETH', key: `pair-${id}` },
        });
        store.openStatArbPosition(pos);
        store.closeStatArbPosition(id, {
          reason,
          closeTimestamp: Date.now(),
          closePnl,
          legAClosePrice: 40000,
          legBClosePrice: 3000,
        });
      }

      const stats = pnl.getStatsByExitReason();

      // Sorted by count descending
      expect(stats).toHaveLength(3);
      expect(stats[0].exitReason).toBe('mean_reversion');
      expect(stats[0].count).toBe(2);
      expect(stats[0].winRate).toBe(100);
      expect(stats[0].totalPnl).toBe(300);
      expect(stats[0].avgPnl).toBe(150);

      expect(stats[1].exitReason).toBe('stoploss');
      expect(stats[1].count).toBe(2);
      expect(stats[1].winRate).toBe(0);
      expect(stats[1].totalPnl).toBe(-150);

      expect(stats[2].exitReason).toBe('time_stop');
      expect(stats[2].count).toBe(1);
      expect(stats[2].winRate).toBe(100);
    });
  });

  // ── AC7: SQLite persistence ───────────────────────────────────────────

  describe('SQLite persistence (AC7)', () => {
    let db: Database.Database;
    let pnlWithDb: PairTradePnl;

    beforeEach(() => {
      db = createTestDb();
      pnlWithDb = new PairTradePnl(fundingTracker, db, store);
    });

    it('inserts position on open', () => {
      const pos = makePosition({ positionId: 'persist-1', status: 'active' });
      pnlWithDb.persistPosition(pos);

      const rows = db.prepare('SELECT * FROM stat_arb_positions WHERE position_id = ?').all('persist-1');
      expect(rows).toHaveLength(1);
      expect((rows[0] as Record<string, unknown>).status).toBe('active');
    });

    it('updates position on close', () => {
      const pos = makePosition({ positionId: 'persist-2', status: 'active' });
      pnlWithDb.persistPosition(pos);

      // Close it
      store.openStatArbPosition(pos);
      store.closeStatArbPosition('persist-2', {
        reason: 'mean_reversion',
        closeTimestamp: Date.now(),
        closePnl: 500,
        legAClosePrice: 41000,
        legBClosePrice: 2900,
      });

      const closed = store.getCompletedStatArbPositions().find((p) => p.positionId === 'persist-2')!;
      pnlWithDb.persistPosition(closed);

      const rows = db.prepare('SELECT * FROM stat_arb_positions WHERE position_id = ?').all('persist-2');
      expect(rows).toHaveLength(1);
      expect((rows[0] as Record<string, unknown>).status).toBe('closed');
      expect((rows[0] as Record<string, unknown>).exit_reason).toBe('mean_reversion');
    });

    it('queries by pairId', () => {
      const pos1 = makePosition({ positionId: 'q-1', pair: { tokenA: 'BTC', tokenB: 'ETH', key: 'BTC-ETH' } });
      const pos2 = makePosition({ positionId: 'q-2', pair: { tokenA: 'SOL', tokenB: 'AVAX', key: 'AVAX-SOL' } });
      pnlWithDb.persistPosition(pos1);
      pnlWithDb.persistPosition(pos2);

      const all = pnlWithDb.queryPositions();
      expect(all).toHaveLength(2);
    });
  });

  // ── AC9: Real-time P&L snapshot ───────────────────────────────────────

  describe('getRealTimePnlSnapshot (AC9)', () => {
    it('returns open positions ordered by P&L descending', () => {
      const pos1 = makePosition({
        positionId: 'snap-1',
        pair: { tokenA: 'BTC', tokenB: 'ETH', key: 'BTC-ETH' },
        legA: makeLeg({ unrealizedPnl: 100 }),
        legB: makeLeg({ unrealizedPnl: 50 }),
        marginUsed: 1000,
      });
      const pos2 = makePosition({
        positionId: 'snap-2',
        pair: { tokenA: 'SOL', tokenB: 'AVAX', key: 'AVAX-SOL' },
        legA: makeLeg({ unrealizedPnl: 500 }),
        legB: makeLeg({ unrealizedPnl: 200 }),
        marginUsed: 2000,
      });
      const pos3 = makePosition({
        positionId: 'snap-3',
        pair: { tokenA: 'DOGE', tokenB: 'SHIB', key: 'DOGE-SHIB' },
        legA: makeLeg({ unrealizedPnl: -100 }),
        legB: makeLeg({ unrealizedPnl: -50 }),
        marginUsed: 500,
      });

      store.openStatArbPosition(pos1);
      store.openStatArbPosition(pos2);
      store.openStatArbPosition(pos3);

      const snapshot = pnl.getRealTimePnlSnapshot();

      expect(snapshot).toHaveLength(3);
      // Most profitable first
      expect(snapshot[0].positionId).toBe('snap-2'); // 700
      expect(snapshot[1].positionId).toBe('snap-1'); // 150
      expect(snapshot[2].positionId).toBe('snap-3'); // -150
      expect(snapshot[0].isRealized).toBe(false);
    });
  });

  // ── AC10: Export ──────────────────────────────────────────────────────

  describe('exportTrades (AC10)', () => {
    let db: Database.Database;
    let pnlWithDb: PairTradePnl;

    beforeEach(() => {
      db = createTestDb();
      pnlWithDb = new PairTradePnl(fundingTracker, db, store);
    });

    it('JSON export contains full P&L breakdown', () => {
      const pos = makePosition({ positionId: 'export-1' });
      store.openStatArbPosition(pos);
      store.closeStatArbPosition('export-1', {
        reason: 'mean_reversion',
        closeTimestamp: Date.now(),
        closePnl: 500,
        legAClosePrice: 41000,
        legBClosePrice: 2900,
      });
      const closed = store.getCompletedStatArbPositions()[0];
      pnlWithDb.persistPosition(closed);

      const json = pnlWithDb.exportTrades('json');
      const parsed = JSON.parse(json);

      expect(parsed).toHaveLength(1);
      expect(parsed[0].position_id).toBe('export-1');
      expect(parsed[0].exit_reason).toBe('mean_reversion');
      expect(parsed[0].status).toBe('closed');
    });

    it('CSV export contains headers and correct formatting', () => {
      const pos = makePosition({ positionId: 'csv-1' });
      store.openStatArbPosition(pos);
      store.closeStatArbPosition('csv-1', {
        reason: 'stoploss',
        closeTimestamp: Date.now(),
        closePnl: -200,
        legAClosePrice: 39000,
        legBClosePrice: 3100,
      });
      const closed = store.getCompletedStatArbPositions()[0];
      pnlWithDb.persistPosition(closed);

      const csv = pnlWithDb.exportTrades('csv');
      const lines = csv.split('\n');

      // Has header + 1 data row
      expect(lines.length).toBe(2);
      expect(lines[0]).toContain('position_id');
      expect(lines[0]).toContain('net_pnl');
      expect(lines[0]).toContain('exit_reason');
      expect(lines[1]).toContain('csv-1');
    });

    it('empty export for no closed positions', () => {
      const csv = pnlWithDb.exportTrades('csv');
      expect(csv).toBe('');
    });
  });
});
