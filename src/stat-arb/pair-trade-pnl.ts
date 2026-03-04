// PairTradePnl — comprehensive P&L tracking for stat arb pair trades.
// Reads from Store (active + completed positions) and FundingRateTracker.
// Persists to SQLite for historical analysis and export.

import { Store } from '../core/store.js';
import { createLogger } from '../utils/logger.js';
import type { StatArbPosition, StatArbExitReason } from '../core/store-slices/stat-arb-slice.js';
import type { FundingRateTracker } from './funding-rate-tracker.js';
import type Database from 'better-sqlite3';

const logger = createLogger('pair-trade-pnl');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PairPositionPnl {
  readonly positionId: string;
  readonly pairId: string;
  readonly longPnl: number;
  readonly shortPnl: number;
  readonly fundingPnl: number;
  readonly totalFees: number;
  readonly netPnl: number;
  readonly returnPercent: number;
  readonly isRealized: boolean;
  readonly marginUsed: number;
}

export interface AggregateStats {
  readonly totalOpen: number;
  readonly totalClosed: number;
  readonly winRate: number;
  readonly profitFactor: number;
  readonly avgReturn: number;
  readonly avgHoldingPeriodHours: number;
  readonly totalNetPnl: number;
  readonly bestTrade: number;
  readonly worstTrade: number;
  readonly sharpeRatio: number;
}

export interface ExitReasonStats {
  readonly exitReason: StatArbExitReason;
  readonly count: number;
  readonly winRate: number;
  readonly avgPnl: number;
  readonly totalPnl: number;
}

// ---------------------------------------------------------------------------
// PairTradePnl
// ---------------------------------------------------------------------------

export class PairTradePnl {
  private readonly store: Store;
  private readonly fundingTracker: FundingRateTracker;
  private readonly db: Database.Database | null;

  constructor(
    fundingTracker: FundingRateTracker,
    db?: Database.Database,
    store?: Store,
  ) {
    this.store = store ?? Store.getInstance();
    this.fundingTracker = fundingTracker;
    this.db = db ?? null;
  }

  // ---------------------------------------------------------------------------
  // Per-position P&L (AC1, AC2, AC3)
  // ---------------------------------------------------------------------------

  getPositionPnl(positionId: string): PairPositionPnl {
    // Check active positions first, then completed
    const active = this.store.getActiveStatArbPosition(positionId);
    const completed = this.store.getCompletedStatArbPositions().find(
      (p) => p.positionId === positionId,
    );
    const pos = active ?? completed;

    if (!pos) {
      throw new Error(`Position not found: ${positionId}`);
    }

    const isRealized = pos.status === 'closed';

    let longPnl: number;
    let shortPnl: number;

    if (isRealized) {
      // AC3: Use exit fill prices for realized P&L
      const longExitPrice = pos.legA.currentPrice; // Updated to exit price on close
      const shortExitPrice = pos.legB.currentPrice;
      longPnl = (longExitPrice - pos.legA.entryPrice) * pos.legA.size * pos.leverage;
      shortPnl = (pos.legB.entryPrice - shortExitPrice) * pos.legB.size * pos.leverage;
    } else {
      // AC2: Use current market prices for unrealized P&L
      longPnl = pos.legA.unrealizedPnl;
      shortPnl = pos.legB.unrealizedPnl;
    }

    // Funding from tracker
    const fundingSummary = this.fundingTracker.getCumulativeFunding(positionId);
    const fundingPnl = Number(fundingSummary.netTotal) / 1e18;

    // Fees: StatArbPosition model does not store per-order fees.
    // PairPositionManager returns fees in PairCloseResult but they are not
    // persisted back to the position. Until a fees field is added to the
    // position model (cross-story concern), totalFees will be 0.
    // TODO: propagate fees from PairCloseResult into StatArbPosition.
    const totalFees = 0;

    const netPnl = longPnl + shortPnl + fundingPnl - totalFees;
    const marginUsed = pos.marginUsed;
    const returnPercent = marginUsed > 0 ? (netPnl / marginUsed) * 100 : 0;

    return {
      positionId,
      pairId: pos.pair.key,
      longPnl,
      shortPnl,
      fundingPnl,
      totalFees,
      netPnl,
      returnPercent,
      isRealized,
      marginUsed,
    };
  }

  // ---------------------------------------------------------------------------
  // Aggregate statistics (AC4, AC5, AC6)
  // ---------------------------------------------------------------------------

  getAggregateStats(): AggregateStats {
    const openPositions = this.store.getAllActiveStatArbPositions();
    const closedPositions = this.store.getCompletedStatArbPositions();

    const totalOpen = openPositions.length;
    const totalClosed = closedPositions.length;

    if (totalClosed === 0) {
      return {
        totalOpen,
        totalClosed: 0,
        winRate: 0,
        profitFactor: 0,
        avgReturn: 0,
        avgHoldingPeriodHours: 0,
        totalNetPnl: 0,
        bestTrade: 0,
        worstTrade: 0,
        sharpeRatio: 0,
      };
    }

    // Calculate P&L for each closed position
    const pnls = closedPositions.map((pos) => pos.closePnl ?? 0);
    const returns = closedPositions.map((pos) =>
      pos.marginUsed > 0 ? ((pos.closePnl ?? 0) / pos.marginUsed) * 100 : 0,
    );

    // AC5: Win rate
    const winners = pnls.filter((p) => p > 0).length;
    const winRate = (winners / totalClosed) * 100;

    // AC6: Profit factor
    const grossProfit = pnls.filter((p) => p > 0).reduce((a, b) => a + b, 0);
    const grossLoss = Math.abs(pnls.filter((p) => p < 0).reduce((a, b) => a + b, 0));
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

    // Average return
    const avgReturn = returns.reduce((a, b) => a + b, 0) / totalClosed;

    // Average holding period
    const holdingMs = closedPositions.map(
      (pos) => (pos.closeTimestamp ?? pos.openTimestamp) - pos.openTimestamp,
    );
    const avgHoldingPeriodHours = holdingMs.reduce((a, b) => a + b, 0) / totalClosed / 3_600_000;

    // Total net P&L
    const totalNetPnl = pnls.reduce((a, b) => a + b, 0);

    // Best and worst
    const bestTrade = Math.max(...pnls);
    const worstTrade = Math.min(...pnls);

    // Sharpe ratio (simplified: mean return / std of returns)
    const meanReturn = avgReturn;
    const variance =
      returns.reduce((sum, r) => sum + (r - meanReturn) ** 2, 0) / totalClosed;
    const stdReturn = Math.sqrt(variance);
    // Annualize: estimate trades per year from avg holding period
    const tradesPerYear = avgHoldingPeriodHours > 0 ? (365 * 24) / avgHoldingPeriodHours : 0;
    const sharpeRatio = stdReturn > 0 ? (meanReturn / stdReturn) * Math.sqrt(tradesPerYear) : 0;

    return {
      totalOpen,
      totalClosed,
      winRate,
      profitFactor,
      avgReturn,
      avgHoldingPeriodHours,
      totalNetPnl,
      bestTrade,
      worstTrade,
      sharpeRatio,
    };
  }

  // ---------------------------------------------------------------------------
  // Stats by exit reason (AC8)
  // ---------------------------------------------------------------------------

  getStatsByExitReason(): ExitReasonStats[] {
    const closedPositions = this.store.getCompletedStatArbPositions();
    const grouped = new Map<StatArbExitReason, StatArbPosition[]>();

    for (const pos of closedPositions) {
      const reason = pos.closeReason;
      if (!reason) continue;
      const group = grouped.get(reason) ?? [];
      group.push(pos);
      grouped.set(reason, group);
    }

    const stats: ExitReasonStats[] = [];

    for (const [exitReason, positions] of grouped) {
      const pnls = positions.map((p) => p.closePnl ?? 0);
      const count = positions.length;
      const winners = pnls.filter((p) => p > 0).length;
      const winRate = count > 0 ? (winners / count) * 100 : 0;
      const totalPnl = pnls.reduce((a, b) => a + b, 0);
      const avgPnl = count > 0 ? totalPnl / count : 0;

      stats.push({ exitReason, count, winRate, avgPnl, totalPnl });
    }

    // Sort by count descending
    stats.sort((a, b) => b.count - a.count);

    return stats;
  }

  // ---------------------------------------------------------------------------
  // Real-time P&L snapshot (AC9)
  // ---------------------------------------------------------------------------

  getRealTimePnlSnapshot(): PairPositionPnl[] {
    const openPositions = this.store.getAllActiveStatArbPositions();
    const snapshots: PairPositionPnl[] = [];

    for (const pos of openPositions) {
      const longPnl = pos.legA.unrealizedPnl;
      const shortPnl = pos.legB.unrealizedPnl;
      const fundingSummary = this.fundingTracker.getCumulativeFunding(pos.positionId);
      const fundingPnl = Number(fundingSummary.netTotal) / 1e18;
      const netPnl = longPnl + shortPnl + fundingPnl;
      const returnPercent = pos.marginUsed > 0 ? (netPnl / pos.marginUsed) * 100 : 0;

      snapshots.push({
        positionId: pos.positionId,
        pairId: pos.pair.key,
        longPnl,
        shortPnl,
        fundingPnl,
        totalFees: 0,
        netPnl,
        returnPercent,
        isRealized: false,
        marginUsed: pos.marginUsed,
      });
    }

    // Sort by netPnl descending (most profitable first)
    snapshots.sort((a, b) => b.netPnl - a.netPnl);

    return snapshots;
  }

  // ---------------------------------------------------------------------------
  // SQLite persistence (AC7)
  // ---------------------------------------------------------------------------

  persistPosition(pos: StatArbPosition): void {
    if (!this.db) return;

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO stat_arb_positions
        (position_id, pair_id, long_symbol, short_symbol, long_size, short_size,
         long_entry_price, short_entry_price, long_exit_price, short_exit_price,
         leverage, hedge_ratio, entry_z_score, exit_z_score,
         entry_timestamp, exit_timestamp, long_realized_pnl, short_realized_pnl,
         cumulative_funding, total_fees, net_pnl, return_percent,
         exit_reason, status, direction, signal_source, margin_used)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const netPnl = pos.closePnl ?? pos.combinedPnl;
    const returnPercent = pos.marginUsed > 0 ? (netPnl / pos.marginUsed) * 100 : 0;

    stmt.run(
      pos.positionId,
      pos.pair.key,
      pos.legA.symbol,
      pos.legB.symbol,
      pos.legA.size,
      pos.legB.size,
      pos.legA.entryPrice,
      pos.legB.entryPrice,
      pos.status === 'closed' ? pos.legA.currentPrice : null,
      pos.status === 'closed' ? pos.legB.currentPrice : null,
      pos.leverage,
      pos.hedgeRatio,
      null, // entry_z_score — stored in action, not position
      null, // exit_z_score
      pos.openTimestamp,
      pos.closeTimestamp ?? null,
      pos.status === 'closed' ? (pos.legA.currentPrice - pos.legA.entryPrice) * pos.legA.size * pos.leverage : null,
      pos.status === 'closed' ? (pos.legB.entryPrice - pos.legB.currentPrice) * pos.legB.size * pos.leverage : null,
      pos.accumulatedFunding,
      0, // fees tracked at close time
      netPnl,
      returnPercent,
      pos.closeReason ?? null,
      pos.status,
      pos.direction,
      pos.signalSource,
      pos.marginUsed,
    );

    logger.debug({ positionId: pos.positionId, status: pos.status }, 'Position persisted to SQLite');
  }

  queryPositions(status?: string): StatArbPositionRow[] {
    if (!this.db) return [];

    const sql = status
      ? 'SELECT * FROM stat_arb_positions WHERE status = ? ORDER BY entry_timestamp DESC'
      : 'SELECT * FROM stat_arb_positions ORDER BY entry_timestamp DESC';

    const rows = status
      ? this.db.prepare(sql).all(status)
      : this.db.prepare(sql).all();

    return rows as StatArbPositionRow[];
  }

  // ---------------------------------------------------------------------------
  // Export (AC10)
  // ---------------------------------------------------------------------------

  exportTrades(format: 'json' | 'csv'): string {
    const rows = this.queryPositions('closed');

    if (format === 'json') {
      return JSON.stringify(rows, null, 2);
    }

    // CSV
    if (rows.length === 0) return '';

    const headers = Object.keys(rows[0]);
    const lines = [headers.join(',')];

    for (const row of rows) {
      const values = headers.map((h) => {
        const val = (row as unknown as Record<string, unknown>)[h];
        if (val === null || val === undefined) return '';
        if (typeof val === 'string' && val.includes(',')) return `"${val}"`;
        return String(val);
      });
      lines.push(values.join(','));
    }

    return lines.join('\n');
  }
}

// ---------------------------------------------------------------------------
// Row type for SQLite queries
// ---------------------------------------------------------------------------

export interface StatArbPositionRow {
  position_id: string;
  pair_id: string;
  long_symbol: string;
  short_symbol: string;
  long_size: number;
  short_size: number;
  long_entry_price: number;
  short_entry_price: number;
  long_exit_price: number | null;
  short_exit_price: number | null;
  leverage: number;
  hedge_ratio: number;
  entry_z_score: number | null;
  exit_z_score: number | null;
  entry_timestamp: number;
  exit_timestamp: number | null;
  long_realized_pnl: number | null;
  short_realized_pnl: number | null;
  cumulative_funding: number;
  total_fees: number;
  net_pnl: number | null;
  return_percent: number | null;
  exit_reason: string | null;
  status: string;
  direction: string;
  signal_source: string | null;
  margin_used: number;
  created_at: string;
}
