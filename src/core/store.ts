import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createLogger } from '../utils/logger.js';
import type {
  BalanceEntry,
  InFlightTransfer,
  CompletedTransfer,
  Position,
  PriceEntry,
  Trade,
  ChainId,
  TokenAddress,
  TransferId,
  TransferStatus,
} from './types.js';
import { transferId } from './types.js';
import type {
  RegimeClassification,
  DecisionReport,
  ReportFilter,
} from '../ai/types.js';
import type {
  StatArbSignal,
  StatArbPosition,
  StatArbCloseData,
  SignalCountStats,
} from './store-slices/stat-arb-slice.js';
import {
  STAT_ARB_SIGNAL_EVENT,
  STAT_ARB_POSITION_OPENED_EVENT,
  STAT_ARB_POSITION_CLOSED_EVENT,
  STAT_ARB_EXIT_SIGNAL_EVENT,
  isSignalExpired,
} from './store-slices/stat-arb-slice.js';

const logger = createLogger('store');

// Store event types
export type StoreEventMap = {
  'balance.updated': [BalanceEntry];
  'transfer.created': [InFlightTransfer];
  'transfer.updated': [InFlightTransfer];
  'transfer.completed': [CompletedTransfer];
  'position.updated': [Position];
  'price.updated': [PriceEntry];
  'regime_changed': [RegimeClassification];
  'regime_detection_failed': [{ error: string; timestamp: number }];
  'strategy_selection_changed': [{ previous: string[]; current: string[]; regime: string }];
  'stat_arb_signal': [StatArbSignal];
  'stat_arb_position_opened': [StatArbPosition];
  'stat_arb_position_closed': [StatArbPosition];
  'stat_arb_exit_signal': [import('./store-slices/stat-arb-slice.js').StatArbExitSignal];
};

export type StoreEventName = keyof StoreEventMap;

// Params for creating a transfer
export interface CreateTransferParams {
  readonly txHash: string | null;
  readonly fromChain: ChainId;
  readonly toChain: ChainId;
  readonly fromToken: TokenAddress;
  readonly toToken: TokenAddress;
  readonly amount: bigint;
  readonly bridge: string;
  readonly quoteData: unknown;
}

function balanceKey(chainId: ChainId, tokenAddress: TokenAddress): string {
  return `${chainId}-${tokenAddress}`;
}

function priceKey(chainId: ChainId, tokenAddress: TokenAddress): string {
  return `${chainId}-${tokenAddress}`;
}

export class Store {
  private static instance: Store | null = null;

  readonly emitter: EventEmitter;

  private readonly balances: Map<string, BalanceEntry>;
  private readonly transfers: Map<string, InFlightTransfer>;
  private readonly completedTransfers: Map<string, CompletedTransfer>;
  private readonly positions: Map<string, Position>;
  private readonly prices: Map<string, PriceEntry>;
  private readonly trades: Map<string, Trade>;

  // --- AI slices ---
  private currentRegime: RegimeClassification | null;
  private readonly regimeHistory: RegimeClassification[];
  private readonly decisionReports: DecisionReport[];

  // --- Stat arb slices ---
  private readonly statArbSignals: Map<string, StatArbSignal>;
  private readonly activeStatArbPositions: Map<string, StatArbPosition>;
  private readonly completedStatArbPositions: Map<string, StatArbPosition>;

  private constructor() {
    this.emitter = new EventEmitter();
    this.balances = new Map();
    this.transfers = new Map();
    this.completedTransfers = new Map();
    this.positions = new Map();
    this.prices = new Map();
    this.trades = new Map();
    this.currentRegime = null;
    this.regimeHistory = [];
    this.decisionReports = [];
    this.statArbSignals = new Map();
    this.activeStatArbPositions = new Map();
    this.completedStatArbPositions = new Map();
  }

  static getInstance(): Store {
    if (!Store.instance) {
      Store.instance = new Store();
    }
    return Store.instance;
  }

  // --- Balance methods ---

  setBalance(
    chainId: ChainId,
    tokenAddress: TokenAddress,
    amount: bigint,
    usdValue: number,
    symbol: string,
    decimals: number,
  ): void {
    const key = balanceKey(chainId, tokenAddress);
    const entry: BalanceEntry = {
      chainId,
      tokenAddress,
      symbol,
      decimals,
      amount,
      usdValue,
      updatedAt: Date.now(),
    };
    this.balances.set(key, entry);
    this.emitter.emit('balance.updated', entry);
    logger.debug({ chainId, tokenAddress, amount: amount.toString(), symbol }, 'Balance updated');
  }

  getBalance(chainId: ChainId, tokenAddress: TokenAddress): BalanceEntry | undefined {
    return this.balances.get(balanceKey(chainId, tokenAddress));
  }

  getAvailableBalance(chainId: ChainId, tokenAddress: TokenAddress): bigint {
    const balance = this.getBalance(chainId, tokenAddress);
    if (!balance) return 0n;

    const inFlight = this.getInFlightByChainAndToken(chainId, tokenAddress);
    const lockedAmount = inFlight.reduce((sum, t) => sum + t.amount, 0n);

    const available = balance.amount - lockedAmount;
    return available > 0n ? available : 0n;
  }

  getAllBalances(): BalanceEntry[] {
    return Array.from(this.balances.values());
  }

  getBalancesByChain(chainId: ChainId): BalanceEntry[] {
    return Array.from(this.balances.values()).filter((b) => b.chainId === chainId);
  }

  // --- Transfer methods ---

  createTransfer(params: CreateTransferParams): InFlightTransfer {
    const id = transferId(randomUUID());
    const now = Date.now();

    const transfer: InFlightTransfer = {
      id,
      txHash: params.txHash,
      fromChain: params.fromChain,
      toChain: params.toChain,
      fromToken: params.fromToken,
      toToken: params.toToken,
      amount: params.amount,
      bridge: params.bridge,
      status: 'in_flight' as TransferStatus,
      quoteData: params.quoteData,
      createdAt: now,
      updatedAt: now,
      recovered: false,
    };

    this.transfers.set(id, transfer);
    this.emitter.emit('transfer.created', transfer);
    logger.info(
      { transferId: id, fromChain: params.fromChain, toChain: params.toChain, bridge: params.bridge },
      'Transfer created',
    );

    return transfer;
  }

  updateTransferStatus(id: TransferId, status: TransferStatus, metadata?: { txHash?: string }): void {
    const transfer = this.transfers.get(id);
    if (!transfer) {
      logger.warn({ transferId: id }, 'Attempted to update non-existent transfer');
      return;
    }

    transfer.status = status;
    transfer.updatedAt = Date.now();

    if (metadata?.txHash) {
      transfer.txHash = metadata.txHash;
    }

    this.emitter.emit('transfer.updated', transfer);
    logger.info({ transferId: id, status }, 'Transfer status updated');
  }

  completeTransfer(
    id: TransferId,
    receivedAmount: bigint,
    receivedToken: TokenAddress,
    receivedChain: ChainId,
  ): void {
    const transfer = this.transfers.get(id);
    if (!transfer) {
      logger.warn({ transferId: id }, 'Attempted to complete non-existent transfer');
      return;
    }

    // Determine final status
    const finalStatus: TransferStatus =
      receivedAmount > 0n ? 'completed' : 'failed';

    const completed: CompletedTransfer = {
      id: transfer.id,
      txHash: transfer.txHash ?? '',
      fromChain: transfer.fromChain,
      toChain: transfer.toChain,
      fromToken: transfer.fromToken,
      toToken: transfer.toToken,
      fromAmount: transfer.amount,
      toAmount: receivedAmount,
      bridge: transfer.bridge,
      status: finalStatus,
      completedAt: Date.now(),
    };

    // Move from active to completed
    this.transfers.delete(id);
    this.completedTransfers.set(id, completed);

    this.emitter.emit('transfer.completed', completed);
    logger.info(
      {
        transferId: id,
        status: finalStatus,
        receivedAmount: receivedAmount.toString(),
        receivedToken,
        receivedChain,
      },
      'Transfer completed',
    );
  }

  getInFlightByChainAndToken(chainId: ChainId, tokenAddress: TokenAddress): InFlightTransfer[] {
    return Array.from(this.transfers.values()).filter(
      (t) => t.fromChain === chainId && t.fromToken === tokenAddress,
    );
  }

  getActiveTransfers(): InFlightTransfer[] {
    return Array.from(this.transfers.values());
  }

  getCompletedTransfers(): CompletedTransfer[] {
    return Array.from(this.completedTransfers.values());
  }

  getTransfer(id: TransferId): InFlightTransfer | undefined {
    return this.transfers.get(id);
  }

  // --- Position methods ---

  setPosition(position: Position): void {
    this.positions.set(position.id, position);
    this.emitter.emit('position.updated', position);
  }

  getPosition(id: string): Position | undefined {
    return this.positions.get(id);
  }

  getAllPositions(): Position[] {
    return Array.from(this.positions.values());
  }

  // --- Price methods ---

  setPrice(chainId: ChainId, tokenAddress: TokenAddress, priceUsd: number): void {
    const key = priceKey(chainId, tokenAddress);
    const entry: PriceEntry = {
      chainId,
      tokenAddress,
      priceUsd,
      timestamp: Date.now(),
    };
    this.prices.set(key, entry);
    this.emitter.emit('price.updated', entry);
  }

  getPrice(chainId: ChainId, tokenAddress: TokenAddress): PriceEntry | undefined {
    return this.prices.get(priceKey(chainId, tokenAddress));
  }

  // --- Trade methods ---

  addTrade(trade: Trade): void {
    this.trades.set(trade.id, trade);
  }

  getTrade(id: string): Trade | undefined {
    return this.trades.get(id);
  }

  getAllTrades(): Trade[] {
    return Array.from(this.trades.values());
  }

  // --- Regime classification methods ---

  setRegimeClassification(classification: RegimeClassification): void {
    this.currentRegime = classification;
    this.regimeHistory.push(classification);

    // Cap history at 100 entries
    const maxHistory = 100;
    if (this.regimeHistory.length > maxHistory) {
      this.regimeHistory.splice(0, this.regimeHistory.length - maxHistory);
    }

    logger.debug(
      { regime: classification.regime, confidence: classification.confidence },
      'Regime classification stored',
    );
  }

  getLatestRegime(): RegimeClassification | null {
    return this.currentRegime;
  }

  getRegimeHistory(limit?: number): RegimeClassification[] {
    if (limit !== undefined && limit > 0) {
      return this.regimeHistory.slice(-limit);
    }
    return [...this.regimeHistory];
  }

  // --- Decision report methods ---

  addReport(report: DecisionReport): void {
    this.decisionReports.push(report);

    // Cap at 1000 reports, evict oldest first
    const maxReports = 1000;
    if (this.decisionReports.length > maxReports) {
      this.decisionReports.splice(0, this.decisionReports.length - maxReports);
    }

    logger.debug(
      { reportId: report.id, strategy: report.strategyName, outcome: report.outcome },
      'Decision report stored',
    );
  }

  updateReportOutcome(reportId: string, outcome: DecisionReport['outcome'], reason?: string): void {
    const report = this.decisionReports.find((r) => r.id === reportId);
    if (!report) {
      logger.warn({ reportId }, 'Attempted to update non-existent decision report');
      return;
    }
    report.outcome = outcome;
    if (reason) {
      report.narrative = `${report.narrative}\n\nOutcome update: ${reason}`;
    }
  }

  getReports(filter?: ReportFilter): DecisionReport[] {
    let results = [...this.decisionReports];

    if (filter?.strategyName) {
      results = results.filter((r) => r.strategyName === filter.strategyName);
    }
    if (filter?.outcome) {
      results = results.filter((r) => r.outcome === filter.outcome);
    }
    if (filter?.fromTimestamp) {
      results = results.filter((r) => r.timestamp >= filter.fromTimestamp!);
    }
    if (filter?.toTimestamp) {
      results = results.filter((r) => r.timestamp <= filter.toTimestamp!);
    }

    // Sort by timestamp descending (most recent first)
    results.sort((a, b) => b.timestamp - a.timestamp);

    // Pagination
    const offset = filter?.offset ?? 0;
    const limit = filter?.limit ?? 50;
    return results.slice(offset, offset + limit);
  }

  // --- Stat arb signal methods ---

  addStatArbSignal(signal: StatArbSignal): void {
    this.statArbSignals.set(signal.pair.key, signal);
    this.emitter.emit(STAT_ARB_SIGNAL_EVENT, signal);
    logger.debug({ pairKey: signal.pair.key, direction: signal.direction, zScore: signal.zScore }, 'Stat arb signal added');
  }

  getSignalByPairKey(pairKey: string): StatArbSignal | undefined {
    return this.statArbSignals.get(pairKey);
  }

  getPendingSignals(): StatArbSignal[] {
    return Array.from(this.statArbSignals.values()).filter(
      (s) => !s.consumed && !isSignalExpired(s),
    );
  }

  markSignalConsumed(pairKey: string): boolean {
    const signal = this.statArbSignals.get(pairKey);
    if (!signal) return false;
    signal.consumed = true;
    return true;
  }

  removeSignal(pairKey: string): boolean {
    return this.statArbSignals.delete(pairKey);
  }

  pruneExpiredSignals(): number {
    let pruned = 0;
    for (const [key, signal] of this.statArbSignals) {
      if (isSignalExpired(signal)) {
        this.statArbSignals.delete(key);
        pruned++;
      }
    }
    if (pruned > 0) {
      logger.debug({ pruned }, 'Pruned expired stat arb signals');
    }
    return pruned;
  }

  getSignalCount(): SignalCountStats {
    let pending = 0;
    let consumed = 0;
    let expired = 0;
    const now = Date.now();
    for (const signal of this.statArbSignals.values()) {
      if (now > signal.expiresAt) {
        expired++;
      } else if (signal.consumed) {
        consumed++;
      } else {
        pending++;
      }
    }
    return { total: this.statArbSignals.size, pending, consumed, expired };
  }

  getAllStatArbSignals(): StatArbSignal[] {
    return Array.from(this.statArbSignals.values());
  }

  // --- Stat arb position methods ---

  openStatArbPosition(position: StatArbPosition): void {
    this.activeStatArbPositions.set(position.positionId, position);
    this.emitter.emit(STAT_ARB_POSITION_OPENED_EVENT, position);
    logger.info(
      { positionId: position.positionId, pair: position.pair.key, direction: position.direction },
      'Stat arb position opened',
    );
  }

  closeStatArbPosition(positionId: string, closeData: StatArbCloseData): void {
    const position = this.activeStatArbPositions.get(positionId);
    if (!position) {
      throw new Error(`Cannot close non-existent stat arb position: ${positionId}`);
    }

    // Update position with close data
    const closedPosition: StatArbPosition = {
      ...position,
      status: 'closed' as const,
      closeReason: closeData.reason,
      closeTimestamp: closeData.closeTimestamp,
      closePnl: closeData.closePnl,
      combinedPnl: closeData.closePnl,
      legA: { ...position.legA, currentPrice: closeData.legAClosePrice },
      legB: { ...position.legB, currentPrice: closeData.legBClosePrice },
    };

    // Move from active to completed
    this.activeStatArbPositions.delete(positionId);
    this.completedStatArbPositions.set(positionId, closedPosition);
    this.emitter.emit(STAT_ARB_POSITION_CLOSED_EVENT, closedPosition);
    logger.info(
      { positionId, reason: closeData.reason, pnl: closeData.closePnl },
      'Stat arb position closed',
    );
  }

  getActiveStatArbPosition(positionId: string): StatArbPosition | undefined {
    return this.activeStatArbPositions.get(positionId);
  }

  getActivePositionByPairKey(pairKey: string): StatArbPosition | undefined {
    for (const position of this.activeStatArbPositions.values()) {
      if (position.pair.key === pairKey) return position;
    }
    return undefined;
  }

  getAllActiveStatArbPositions(): StatArbPosition[] {
    return Array.from(this.activeStatArbPositions.values());
  }

  getCompletedStatArbPositions(): StatArbPosition[] {
    return Array.from(this.completedStatArbPositions.values());
  }

  updateStatArbPositionPnl(
    positionId: string,
    combinedPnl: number,
    accumulatedFunding: number,
  ): void {
    const position = this.activeStatArbPositions.get(positionId);
    if (!position) {
      logger.warn({ positionId }, 'Attempted to update PnL on non-existent stat arb position');
      return;
    }
    position.combinedPnl = combinedPnl;
    position.accumulatedFunding = accumulatedFunding;
  }

  getActiveStatArbPositionCount(): number {
    return this.activeStatArbPositions.size;
  }

  // --- Restore (for crash recovery) ---

  restoreTransfer(transfer: InFlightTransfer): void {
    this.transfers.set(transfer.id, transfer);
    logger.info({ transferId: transfer.id, status: transfer.status }, 'Transfer restored from persistence');
  }

  // --- Reset (for tests) ---

  reset(): void {
    this.balances.clear();
    this.transfers.clear();
    this.completedTransfers.clear();
    this.positions.clear();
    this.prices.clear();
    this.trades.clear();
    this.currentRegime = null;
    this.regimeHistory.length = 0;
    this.decisionReports.length = 0;
    this.statArbSignals.clear();
    this.activeStatArbPositions.clear();
    this.completedStatArbPositions.clear();
    this.emitter.removeAllListeners();
    Store.instance = null;
    logger.debug('Store reset');
  }
}
