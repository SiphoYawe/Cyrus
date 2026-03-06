// BalanceReconciler — compares on-chain balances against store each OODA cycle
// NOT a RunnableBase — called synchronously within the StrategyController's tick
// Runs AFTER managing in-flight transfers, BEFORE evaluating strategy entries

import type { Store } from '../core/store.js';
import type { HyperliquidConnectorInterface } from '../connectors/hyperliquid-connector.js';
import type { ChainId, TokenAddress } from '../core/types.js';
import { CHAINS, USDC_ADDRESSES } from '../core/constants.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('balance-reconciler');

// --- Config ---

export interface BalanceReconcilerConfig {
  /** Discrepancy threshold as fraction (default 0.01 = 1%) */
  readonly discrepancyThreshold: number;
  /** EVM chains to reconcile */
  readonly trackedChains: readonly ChainId[];
  /** Run reconciliation every N ticks (default 1 = every tick) */
  readonly reconcileIntervalTicks: number;
  /** Max time for reconciliation before skipping (default 10s) */
  readonly timeoutMs: number;
  /** Auto-correct store balances after consecutive detections (default true) */
  readonly autoCorrect: boolean;
  /** Number of consecutive detections before auto-correction (default 2) */
  readonly autoCorrectAfter: number;
}

const DEFAULT_CONFIG: BalanceReconcilerConfig = {
  discrepancyThreshold: 0.01,
  trackedChains: [
    CHAINS.ETHEREUM,
    CHAINS.ARBITRUM,
    CHAINS.OPTIMISM,
    CHAINS.POLYGON,
    CHAINS.BASE,
    CHAINS.BSC,
  ],
  reconcileIntervalTicks: 1,
  timeoutMs: 10_000,
  autoCorrect: true,
  autoCorrectAfter: 2,
};

// --- Types ---

export interface DiscrepancyReport {
  readonly venue: string;
  readonly chainId: ChainId;
  readonly token: TokenAddress;
  readonly expected: bigint;
  readonly actual: bigint;
  readonly delta: bigint;
  readonly percentageDiff: number;
}

export interface ReconciliationReport {
  readonly timestamp: number;
  readonly discrepancies: readonly DiscrepancyReport[];
  readonly totalPortfolioValue: bigint;
  readonly largestDiscrepancyPct: number;
  readonly reconciliationDurationMs: number;
  readonly chainsReconciled: number;
  readonly chainsSkipped: number;
}

// Interface for on-chain balance fetching (for testability)
export interface EvmBalanceFetcher {
  fetchUsdcBalance(chainId: ChainId, tokenAddress: TokenAddress, walletAddress: string): Promise<bigint>;
}

// Interface for WS notification (for testability)
export interface ReconciliationNotifier {
  broadcast(envelope: { event: string; data: unknown; timestamp: number }): void;
}

export class BalanceReconciler {
  private readonly store: Store;
  private readonly hyperliquidConnector: HyperliquidConnectorInterface;
  private readonly evmFetcher: EvmBalanceFetcher;
  private readonly notifier: ReconciliationNotifier | null;
  private readonly walletAddress: string;
  private readonly config: BalanceReconcilerConfig;

  private tickCount = 0;
  private lastReconciliationTimestamp = 0;
  private lastReport: ReconciliationReport | null = null;
  private readonly pendingDiscrepancies: Map<string, number> = new Map();

  constructor(
    store: Store,
    hyperliquidConnector: HyperliquidConnectorInterface,
    evmFetcher: EvmBalanceFetcher,
    walletAddress: string,
    config?: Partial<BalanceReconcilerConfig>,
    notifier?: ReconciliationNotifier | null,
  ) {
    this.store = store;
    this.hyperliquidConnector = hyperliquidConnector;
    this.evmFetcher = evmFetcher;
    this.walletAddress = walletAddress;
    this.config = { ...DEFAULT_CONFIG, ...config };
    if (this.config.reconcileIntervalTicks < 1) {
      throw new Error('reconcileIntervalTicks must be >= 1');
    }
    this.notifier = notifier ?? null;
  }

  /**
   * Main entry point — called each OODA tick.
   * Respects interval config to reduce API load.
   */
  async reconcile(): Promise<ReconciliationReport | null> {
    this.tickCount++;

    // Skip if not on reconciliation interval
    if (this.tickCount % this.config.reconcileIntervalTicks !== 0) {
      return null;
    }

    const startTime = Date.now();

    try {
      // Fetch on-chain balances with timeout (clear timer on completion to avoid leaks)
      let timerId: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timerId = setTimeout(() => reject(new Error('Reconciliation timed out')), this.config.timeoutMs);
      });

      const reconcilePromise = this.runReconciliation(startTime);
      const report = await Promise.race([reconcilePromise, timeoutPromise]);
      clearTimeout(timerId);

      this.lastReport = report;
      this.lastReconciliationTimestamp = report.timestamp;

      return report;
    } catch (err) {
      logger.warn(
        { error: (err as Error).message, elapsed: Date.now() - startTime },
        'Reconciliation skipped',
      );
      return null;
    }
  }

  private async runReconciliation(startTime: number): Promise<ReconciliationReport> {
    const discrepancies: DiscrepancyReport[] = [];
    let totalPortfolioValue = 0n;
    let chainsReconciled = 0;
    let chainsSkipped = 0;

    // Get in-flight transfer amounts for exclusion
    const inFlightAmounts = this.getInFlightAmounts();

    // --- EVM Chain Reconciliation ---
    const evmResults = await this.fetchEvmBalances();
    for (const [key, onChainBalance] of evmResults) {
      const [chainIdStr, tokenAddr] = key.split('-');
      const chain = Number(chainIdStr) as ChainId;
      const token = tokenAddr as TokenAddress;

      totalPortfolioValue += onChainBalance;

      // Get store balance
      const storeBalance = this.store.getBalance(chain, token);
      const storeAmount = storeBalance?.amount ?? 0n;

      // Subtract in-flight amounts (tokens in transit)
      const inFlightKey = key;
      const inFlightDeduction = inFlightAmounts.get(inFlightKey) ?? 0n;
      const adjustedStoreAmount = storeAmount > inFlightDeduction
        ? storeAmount - inFlightDeduction
        : 0n;

      // Compare
      const discrepancy = this.calculateDiscrepancy(onChainBalance, adjustedStoreAmount);
      if (discrepancy !== null) {
        discrepancies.push({
          venue: 'evm',
          chainId: chain,
          token,
          expected: adjustedStoreAmount,
          actual: onChainBalance,
          delta: discrepancy.delta,
          percentageDiff: discrepancy.percentageDiff,
        });
      }

      chainsReconciled++;
    }

    // --- Hyperliquid Reconciliation ---
    // TODO: HL and EVM both compare against the Arbitrum store slot.
    // A venue-aware store dimension would prevent double-counting.
    const hlResult = await this.fetchHyperliquidBalance();
    if (hlResult !== null) {
      totalPortfolioValue += hlResult.totalValue;

      const arbUsdc = USDC_ADDRESSES[CHAINS.ARBITRUM as number];
      const hlStoreBalance = this.store.getBalance(CHAINS.ARBITRUM, arbUsdc);
      const hlStoreAmount = hlStoreBalance?.amount ?? 0n;

      // Subtract in-flight amounts targeting Arbitrum
      const hlInFlightKey = `${CHAINS.ARBITRUM as number}-${arbUsdc}`;
      const hlInFlight = inFlightAmounts.get(hlInFlightKey) ?? 0n;
      const adjustedHlStore = hlStoreAmount > hlInFlight
        ? hlStoreAmount - hlInFlight
        : 0n;

      const discrepancy = this.calculateDiscrepancy(hlResult.totalValue, adjustedHlStore);
      if (discrepancy !== null) {
        discrepancies.push({
          venue: 'hyperliquid',
          chainId: CHAINS.ARBITRUM,
          token: arbUsdc,
          expected: adjustedHlStore,
          actual: hlResult.totalValue,
          delta: discrepancy.delta,
          percentageDiff: discrepancy.percentageDiff,
        });
      }
      chainsReconciled++;
    } else {
      chainsSkipped++;
    }

    // Handle discrepancies (always call to clear stale pending counters)
    this.handleDiscrepancies(discrepancies);

    const largestDiscrepancyPct = discrepancies.length > 0
      ? Math.max(...discrepancies.map((d) => d.percentageDiff))
      : 0;

    const report: ReconciliationReport = {
      timestamp: Date.now(),
      discrepancies,
      totalPortfolioValue,
      largestDiscrepancyPct,
      reconciliationDurationMs: Date.now() - startTime,
      chainsReconciled,
      chainsSkipped,
    };

    logger.info(
      {
        discrepancies: discrepancies.length,
        totalPortfolioValue: totalPortfolioValue.toString(),
        chainsReconciled,
        chainsSkipped,
        durationMs: report.reconciliationDurationMs,
      },
      'Reconciliation completed',
    );

    return report;
  }

  // --- Balance Fetching ---

  private async fetchEvmBalances(): Promise<Map<string, bigint>> {
    const results = new Map<string, bigint>();

    // Fetch all chains in parallel
    const fetchPromises = this.config.trackedChains.map(async (chain) => {
      const usdcAddr = USDC_ADDRESSES[chain as number];
      if (!usdcAddr) return;

      try {
        const balance = await this.evmFetcher.fetchUsdcBalance(
          chain,
          usdcAddr,
          this.walletAddress,
        );
        const key = `${chain as number}-${usdcAddr}`;
        results.set(key, balance);
      } catch (err) {
        logger.warn(
          { chainId: chain, error: (err as Error).message },
          'Failed to fetch EVM balance, skipping chain',
        );
      }
    });

    await Promise.all(fetchPromises);
    return results;
  }

  private async fetchHyperliquidBalance(): Promise<{
    totalValue: bigint;
    margin: number;
    unrealizedPnl: number;
  } | null> {
    try {
      const balance = await this.hyperliquidConnector.queryBalance();
      const positions = await this.hyperliquidConnector.queryPositions();

      const marginUsd = balance.crossMarginSummary.accountValue;
      const unrealizedPnl = positions.reduce(
        (sum, pos) => {
          const parsed = parseFloat(pos.unrealizedPnl || '0');
          return sum + (Number.isNaN(parsed) ? 0 : parsed);
        },
        0,
      );

      // Convert to bigint (USDC 6 decimals)
      const totalValueUsd = marginUsd + unrealizedPnl;
      const totalValue = BigInt(Math.floor(Math.max(0, totalValueUsd) * 1_000_000));

      return { totalValue, margin: marginUsd, unrealizedPnl };
    } catch (err) {
      logger.warn(
        { error: (err as Error).message },
        'Failed to fetch Hyperliquid balance, skipping',
      );
      return null;
    }
  }

  // --- Comparison Logic ---

  /**
   * Calculate discrepancy between on-chain and store balance.
   * Uses basis points (10000 = 100%) for bigint-safe percentage.
   * Returns null if within threshold.
   */
  private calculateDiscrepancy(
    actual: bigint,
    expected: bigint,
  ): { delta: bigint; percentageDiff: number } | null {
    const delta = actual > expected ? actual - expected : expected - actual;

    // Avoid division by zero
    const denominator = actual > expected ? actual : expected;
    if (denominator === 0n) return null;

    // Calculate basis points: (delta * 10000) / denominator
    const discrepancyBps = (delta * 10000n) / denominator;
    const thresholdBps = BigInt(Math.round(this.config.discrepancyThreshold * 10000));

    if (discrepancyBps <= thresholdBps) return null;

    const percentageDiff = Number(discrepancyBps) / 100; // Convert bps to percentage

    return { delta, percentageDiff };
  }

  // --- Alert & Correction ---

  private handleDiscrepancies(discrepancies: readonly DiscrepancyReport[]): void {
    // Track which keys were seen this cycle for clearing resolved ones
    const seenKeys = new Set<string>();

    for (const d of discrepancies) {
      const key = `${d.chainId as number}-${d.token}`;
      seenKeys.add(key);

      // Log warning
      logger.warn(
        {
          venue: d.venue,
          chainId: d.chainId,
          token: d.token,
          expected: d.expected.toString(),
          actual: d.actual.toString(),
          delta: d.delta.toString(),
          percentageDiff: `${d.percentageDiff.toFixed(2)}%`,
        },
        'Balance discrepancy detected',
      );

      // Increment consecutive detection counter
      const count = (this.pendingDiscrepancies.get(key) ?? 0) + 1;
      this.pendingDiscrepancies.set(key, count);

      // Auto-correct after configured consecutive detections
      if (this.config.autoCorrect && count >= this.config.autoCorrectAfter) {
        const storeBalance = this.store.getBalance(d.chainId, d.token);
        logger.info(
          {
            chainId: d.chainId,
            token: d.token,
            before: (storeBalance?.amount ?? 0n).toString(),
            after: d.actual.toString(),
            consecutiveDetections: count,
          },
          'Auto-correcting store balance to on-chain truth',
        );

        this.store.setBalance(
          d.chainId,
          d.token,
          d.actual,
          Number(d.actual) / 1_000_000, // Approximate USD value
          storeBalance?.symbol ?? 'USDC',
          storeBalance?.decimals ?? 6,
        );
        // Clear counter after correction
        this.pendingDiscrepancies.delete(key);
      }
    }

    // Clear counters for resolved discrepancies (not seen this cycle)
    for (const key of this.pendingDiscrepancies.keys()) {
      if (!seenKeys.has(key)) {
        this.pendingDiscrepancies.delete(key);
      }
    }

    // Emit event on store emitter for subscribers
    if (discrepancies.length > 0) {
      this.store.emitter.emit('balance_discrepancy', discrepancies);
    }

    // Send WebSocket notification
    if (this.notifier && discrepancies.length > 0) {
      this.notifier.broadcast({
        event: 'balance_discrepancy',
        data: discrepancies.map((d) => ({
          venue: d.venue,
          chainId: d.chainId,
          token: d.token,
          expected: d.expected.toString(),
          actual: d.actual.toString(),
          delta: d.delta.toString(),
          percentageDiff: d.percentageDiff,
        })),
        timestamp: Date.now(),
      });
    }
  }

  getPendingDiscrepancies(): Map<string, number> {
    return this.pendingDiscrepancies;
  }

  // --- In-Flight Deductions ---

  private getInFlightAmounts(): Map<string, bigint> {
    const amounts = new Map<string, bigint>();
    const activeTransfers = this.store.getActiveTransfers();

    for (const transfer of activeTransfers) {
      const key = `${transfer.fromChain as number}-${transfer.fromToken}`;
      const current = amounts.get(key) ?? 0n;
      amounts.set(key, current + transfer.amount);
    }

    return amounts;
  }

  // --- Accessors for testing ---

  getLastReport(): ReconciliationReport | null {
    return this.lastReport;
  }

  getLastReconciliationTimestamp(): number {
    return this.lastReconciliationTimestamp;
  }

  getTickCount(): number {
    return this.tickCount;
  }
}
