import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../utils/logger.js';
import { Store } from './store.js';
import type {
  InFlightTransfer,
  ActivityLogEntry,
  TransferStatus,
  ChainId,
  TokenAddress,
  TransferId,
} from './types.js';
import { chainId, tokenAddress, transferId } from './types.js';

const logger = createLogger('persistence');

// Resolve __dirname for ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Terminal statuses that should not be reloaded
const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'partial',
  'refunded',
  'failed',
  'timed_out',
]);

export class PersistenceService {
  private readonly db: Database.Database;
  private readonly store: Store;
  private unsubscribers: Array<() => void> = [];

  constructor(dbPath: string, store?: Store) {
    this.store = store ?? Store.getInstance();

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    this.runMigrations();
    this.subscribeToStoreEvents();
    this.restoreTransfers();

    logger.info({ dbPath }, 'PersistenceService initialized');
  }

  // --- Migration system ---

  private runMigrations(): void {
    // Create migrations tracking table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS _migrations (
        version TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);

    const migrationsDir = join(__dirname, 'migrations');

    let files: string[];
    try {
      files = readdirSync(migrationsDir)
        .filter((f) => f.endsWith('.sql'))
        .sort();
    } catch {
      logger.warn({ migrationsDir }, 'Migrations directory not found, skipping');
      return;
    }

    const applied = new Set(
      this.db
        .prepare('SELECT version FROM _migrations')
        .all()
        .map((row) => (row as { version: string }).version),
    );

    for (const file of files) {
      const version = file.replace('.sql', '');
      if (applied.has(version)) {
        continue;
      }

      const sql = readFileSync(join(migrationsDir, file), 'utf-8');
      this.db.exec(sql);
      this.db
        .prepare('INSERT INTO _migrations (version, applied_at) VALUES (?, ?)')
        .run(version, new Date().toISOString());

      logger.info({ version, file }, 'Migration applied');
    }
  }

  // --- Store event subscriptions ---

  private subscribeToStoreEvents(): void {
    const onTransferCreated = (transfer: InFlightTransfer): void => {
      this.persistTransfer(transfer);
    };

    const onTransferUpdated = (transfer: InFlightTransfer): void => {
      this.updateTransferStatus(transfer.id, transfer.status);
    };

    const onTransferCompleted = (completed: {
      id: TransferId;
      txHash: string;
      fromChain: ChainId;
      toChain: ChainId;
      fromToken: TokenAddress;
      toToken: TokenAddress;
      fromAmount: bigint;
      toAmount: bigint;
      bridge: string;
      status: TransferStatus;
      completedAt: number;
    }): void => {
      // Delete from in_flight table
      this.deleteTransfer(completed.id);

      // Log activity
      const entry: ActivityLogEntry = {
        id: crypto.randomUUID(),
        timestamp: new Date(completed.completedAt).toISOString(),
        chainId: completed.toChain,
        fromToken: completed.fromToken,
        toToken: completed.toToken,
        fromAmount: completed.fromAmount.toString(),
        toAmount: completed.toAmount.toString(),
        txHash: completed.txHash,
        decisionReportId: null,
        actionType: 'transfer',
        createdAt: new Date().toISOString(),
      };
      this.logActivity(entry);
    };

    this.store.emitter.on('transfer.created', onTransferCreated);
    this.store.emitter.on('transfer.updated', onTransferUpdated);
    this.store.emitter.on('transfer.completed', onTransferCompleted);

    this.unsubscribers.push(
      () => this.store.emitter.off('transfer.created', onTransferCreated),
      () => this.store.emitter.off('transfer.updated', onTransferUpdated),
      () => this.store.emitter.off('transfer.completed', onTransferCompleted),
    );
  }

  // --- Crash recovery ---

  private restoreTransfers(): void {
    const transfers = this.loadPersistedTransfers();
    for (const transfer of transfers) {
      // Mark as recovered
      const recovered: InFlightTransfer = {
        ...transfer,
        recovered: true,
      };
      this.store.restoreTransfer(recovered);
    }

    if (transfers.length > 0) {
      logger.info({ count: transfers.length }, 'Restored in-flight transfers from persistence');
    }
  }

  // --- Transfer persistence ---

  persistTransfer(transfer: InFlightTransfer): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO in_flight_transfers
        (id, tx_hash, bridge, from_chain, to_chain, from_token, to_token, amount, status, quote_json, created_at, updated_at)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      transfer.id,
      transfer.txHash,
      transfer.bridge,
      transfer.fromChain as number,
      transfer.toChain as number,
      transfer.fromToken as string,
      transfer.toToken as string,
      transfer.amount.toString(),
      transfer.status,
      JSON.stringify(transfer.quoteData),
      new Date(transfer.createdAt).toISOString(),
      new Date(transfer.updatedAt).toISOString(),
    );

    logger.debug({ transferId: transfer.id }, 'Transfer persisted');
  }

  updateTransferStatus(id: TransferId, status: TransferStatus): void {
    const stmt = this.db.prepare(`
      UPDATE in_flight_transfers
      SET status = ?, updated_at = ?
      WHERE id = ?
    `);

    stmt.run(status, new Date().toISOString(), id as string);
    logger.debug({ transferId: id, status }, 'Transfer status persisted');
  }

  deleteTransfer(id: TransferId): void {
    const stmt = this.db.prepare('DELETE FROM in_flight_transfers WHERE id = ?');
    stmt.run(id as string);
    logger.debug({ transferId: id }, 'Transfer deleted from persistence');
  }

  loadPersistedTransfers(): InFlightTransfer[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM in_flight_transfers WHERE status NOT IN (${Array.from(TERMINAL_STATUSES)
          .map(() => '?')
          .join(', ')})`,
      )
      .all(...Array.from(TERMINAL_STATUSES)) as Array<{
      id: string;
      tx_hash: string | null;
      bridge: string;
      from_chain: number;
      to_chain: number;
      from_token: string;
      to_token: string;
      amount: string;
      status: string;
      quote_json: string | null;
      created_at: string;
      updated_at: string;
    }>;

    return rows.map((row) => ({
      id: transferId(row.id),
      txHash: row.tx_hash,
      fromChain: chainId(row.from_chain),
      toChain: chainId(row.to_chain),
      fromToken: tokenAddress(row.from_token),
      toToken: tokenAddress(row.to_token),
      amount: BigInt(row.amount),
      bridge: row.bridge,
      status: row.status as TransferStatus,
      quoteData: row.quote_json ? JSON.parse(row.quote_json) : null,
      createdAt: new Date(row.created_at).getTime(),
      updatedAt: new Date(row.updated_at).getTime(),
      recovered: false,
    }));
  }

  // --- Activity log ---

  logActivity(entry: ActivityLogEntry): void {
    const stmt = this.db.prepare(`
      INSERT INTO activity_log
        (id, timestamp, chain_id, from_token, to_token, from_amount, to_amount, tx_hash, decision_report_id, action_type, created_at)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      entry.id,
      entry.timestamp,
      entry.chainId as number,
      entry.fromToken as string,
      entry.toToken as string,
      entry.fromAmount,
      entry.toAmount,
      entry.txHash,
      entry.decisionReportId,
      entry.actionType,
      entry.createdAt,
    );

    logger.debug({ activityId: entry.id, actionType: entry.actionType }, 'Activity logged');
  }

  getActivityLog(
    limit: number = 50,
    offset: number = 0,
  ): { entries: ActivityLogEntry[]; total: number } {
    const total = (
      this.db.prepare('SELECT COUNT(*) as count FROM activity_log').get() as { count: number }
    ).count;

    const rows = this.db
      .prepare('SELECT * FROM activity_log ORDER BY created_at DESC LIMIT ? OFFSET ?')
      .all(limit, offset) as Array<{
      id: string;
      timestamp: string;
      chain_id: number;
      from_token: string;
      to_token: string;
      from_amount: string;
      to_amount: string;
      tx_hash: string;
      decision_report_id: string | null;
      action_type: string;
      created_at: string;
    }>;

    const entries: ActivityLogEntry[] = rows.map((row) => ({
      id: row.id,
      timestamp: row.timestamp,
      chainId: chainId(row.chain_id),
      fromToken: tokenAddress(row.from_token),
      toToken: tokenAddress(row.to_token),
      fromAmount: row.from_amount,
      toAmount: row.to_amount,
      txHash: row.tx_hash,
      decisionReportId: row.decision_report_id,
      actionType: row.action_type,
      createdAt: row.created_at,
    }));

    return { entries, total };
  }

  pruneActivityLog(retentionDays: number): number {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - retentionDays);
    const cutoffIso = cutoff.toISOString();

    const result = this.db
      .prepare('DELETE FROM activity_log WHERE created_at < ?')
      .run(cutoffIso);

    logger.info(
      { retentionDays, deleted: result.changes },
      'Activity log pruned',
    );

    return result.changes;
  }

  // --- Backtest results persistence ---

  saveBacktestResult(result: {
    id: string;
    strategyName: string;
    startDate: number;
    endDate: number;
    initialCapital: string;
    finalPortfolioValue: string;
    totalTrades: number;
    totalReturn: number;
    sharpeRatio: number;
    sortinoRatio: number;
    maxDrawdown: number;
    winRate: number;
    profitFactor: number;
    calmarRatio: number;
    annualizedReturn: number;
    parametersJson: string | null;
    equityCurveJson: string;
    tradeLogJson: string;
    durationMs: number;
  }): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO backtest_results
        (id, strategy_name, start_date, end_date, initial_capital, final_portfolio_value,
         total_trades, total_return, sharpe_ratio, sortino_ratio, max_drawdown,
         win_rate, profit_factor, calmar_ratio, annualized_return,
         parameters_json, equity_curve_json, trade_log_json, duration_ms, created_at)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      result.id,
      result.strategyName,
      result.startDate,
      result.endDate,
      result.initialCapital,
      result.finalPortfolioValue,
      result.totalTrades,
      result.totalReturn,
      result.sharpeRatio,
      result.sortinoRatio,
      result.maxDrawdown,
      result.winRate,
      result.profitFactor,
      result.calmarRatio,
      result.annualizedReturn,
      result.parametersJson,
      result.equityCurveJson,
      result.tradeLogJson,
      result.durationMs,
      new Date().toISOString(),
    );

    logger.debug({ backtestId: result.id, strategy: result.strategyName }, 'Backtest result saved');
  }

  getBacktestResults(
    limit: number = 50,
    offset: number = 0,
    strategyName?: string,
  ): { entries: Array<Record<string, unknown>>; total: number } {
    let countQuery = 'SELECT COUNT(*) as count FROM backtest_results';
    let dataQuery = 'SELECT * FROM backtest_results';
    const params: unknown[] = [];

    if (strategyName) {
      countQuery += ' WHERE strategy_name = ?';
      dataQuery += ' WHERE strategy_name = ?';
      params.push(strategyName);
    }

    dataQuery += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';

    const total = (
      this.db.prepare(countQuery).get(...params) as { count: number }
    ).count;

    const rows = this.db
      .prepare(dataQuery)
      .all(...params, limit, offset) as Array<Record<string, unknown>>;

    return { entries: rows, total };
  }

  // --- Lifecycle ---

  getDb(): Database.Database {
    return this.db;
  }

  close(): void {
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];
    this.db.close();
    logger.info('PersistenceService closed');
  }
}
