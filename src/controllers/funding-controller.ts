// FundingController — evaluates margin needs and emits funding bridge actions
// Runs in the agent's tick loop via RunnableBase
// Reacts to stat arb signals that require Hyperliquid margin

import { randomUUID } from 'node:crypto';
import { RunnableBase } from '../core/runnable-base.js';
import type { Store } from '../core/store.js';
import type { ActionQueue } from '../core/action-queue.js';
import type { StatArbSignal } from '../core/store-slices/stat-arb-slice.js';
import type { FundingBridgeAction } from '../core/action-types.js';
import type { ChainId, TokenAddress } from '../core/types.js';
import { chainId } from '../core/types.js';
import { CHAINS, USDC_ADDRESSES } from '../core/constants.js';
import type { FundingMutex } from './funding-mutex.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('funding-controller');

// --- Config ---

export interface FundingControllerConfig {
  /** Extra margin buffer above required (default 0.10 = 10%) */
  readonly marginBuffer: number;
  /** Minimum amount to bridge in USDC smallest units (default 50 USDC = 50_000_000n) */
  readonly minBridgeAmount: bigint;
  /** Gas reserve per chain in USDC-equivalent smallest units (default ~$5 = 5_000_000n) */
  readonly gasReserveUsdc: bigint;
  /** Max concurrent bridge operations (default 3) */
  readonly maxConcurrentBridges: number;
  /** Tick interval in ms (default 15s) */
  readonly tickIntervalMs: number;
  /** EVM chains to scan for USDC balances */
  readonly sourceChains: readonly ChainId[];
  /** Cooldown between funding cycles in ms (default 600_000 = 10 min) */
  readonly fundingCooldownMs: number;
}

const DEFAULT_CONFIG: FundingControllerConfig = {
  marginBuffer: 0.10,
  minBridgeAmount: 50_000_000n, // 50 USDC (6 decimals)
  gasReserveUsdc: 5_000_000n,   // ~$5 USDC reserve
  maxConcurrentBridges: 3,
  tickIntervalMs: 15_000,
  sourceChains: [
    CHAINS.ETHEREUM,
    CHAINS.ARBITRUM,
    CHAINS.OPTIMISM,
    CHAINS.POLYGON,
    CHAINS.BASE,
    CHAINS.BSC,
  ],
  fundingCooldownMs: 600_000, // 10 minutes
};

// --- Types ---

export interface FundingRequest {
  readonly signalId: string;
  readonly requiredAmount: bigint;
  readonly currentBalance: bigint;
  readonly deficit: bigint;
}

export interface ChainFundingPlan {
  readonly chainId: ChainId;
  readonly tokenAddress: TokenAddress;
  readonly availableAmount: bigint;
  readonly bridgeAmount: bigint;
}

export interface FundingBatch {
  readonly batchId: string;
  readonly triggeringSignalId: string;
  readonly targetAmount: bigint;
  readonly plans: readonly ChainFundingPlan[];
  totalBridged: bigint;
  completedCount: number;
  failedCount: number;
  status: FundingBatchStatus;
}

export type FundingBatchStatus = 'pending' | 'in-progress' | 'completed' | 'partial' | 'failed';

// Hyperliquid chain representation in the store (Arbitrum settlement)
const HYPERLIQUID_CHAIN = CHAINS.ARBITRUM;

export class FundingController extends RunnableBase {
  private readonly store: Store;
  private readonly actionQueue: ActionQueue;
  private readonly config: FundingControllerConfig;
  private readonly activeBatches: Map<string, FundingBatch> = new Map();
  private readonly mutex: FundingMutex | null;
  private lastFundingCycleTime = 0;

  constructor(
    store: Store,
    actionQueue: ActionQueue,
    config?: Partial<FundingControllerConfig>,
    mutex?: FundingMutex,
  ) {
    const merged = { ...DEFAULT_CONFIG, ...config };
    super(merged.tickIntervalMs, 'funding-controller');
    this.store = store;
    this.actionQueue = actionQueue;
    this.config = merged;
    this.mutex = mutex ?? null;
  }

  async controlTask(): Promise<void> {
    // Cooldown check — prevent rapid-fire funding cycles
    const elapsed = Date.now() - this.lastFundingCycleTime;
    if (this.lastFundingCycleTime > 0 && elapsed < this.config.fundingCooldownMs) {
      logger.debug(
        { remainingMs: this.config.fundingCooldownMs - elapsed },
        'Funding cooldown active, skipping evaluation',
      );
      return;
    }

    // Check pending stat arb signals that need funding
    const pendingSignals = this.store.getPendingSignals();
    if (pendingSignals.length === 0) return;

    // Acquire mutex if present (prevents conflicting with withdrawal controller)
    if (this.mutex && !this.mutex.acquire('funding')) {
      logger.debug('Withdrawal in progress, skipping funding evaluation');
      return;
    }

    try {
      await this.evaluateAndEmit(pendingSignals);
    } finally {
      this.mutex?.release('funding');
    }
  }

  private async evaluateAndEmit(pendingSignals: StatArbSignal[]): Promise<void> {
    for (const signal of pendingSignals) {
      // Skip if we already have an active funding batch for this signal
      if (this.hasBatchForSignal(signal.signalId)) continue;

      const request = this.evaluateMarginNeed(signal);
      if (!request) continue; // Sufficient margin

      logger.info(
        {
          signalId: signal.signalId,
          deficit: request.deficit.toString(),
          required: request.requiredAmount.toString(),
          current: request.currentBalance.toString(),
        },
        'Margin deficiency detected, planning funding',
      );

      const plans = this.buildFundingPlan(request.deficit);
      if (plans.length === 0) {
        logger.warn(
          { signalId: signal.signalId, deficit: request.deficit.toString() },
          'No source chains with sufficient USDC to fund deficit',
        );
        continue;
      }

      const batch = this.createBatch(signal.signalId, request.deficit, plans);
      this.emitFundingActions(batch);
      this.lastFundingCycleTime = Date.now();
    }
  }

  async onStop(): Promise<void> {
    this.mutex?.release('funding');
    logger.info(
      { activeBatches: this.activeBatches.size },
      'FundingController stopping',
    );
  }

  // --- Core Logic ---

  /**
   * Evaluate whether a stat arb signal requires additional Hyperliquid margin.
   * Returns null if current balance is sufficient.
   */
  evaluateMarginNeed(signal: StatArbSignal): FundingRequest | null {
    // Calculate required capital from the signal
    // margin = (legA size * entryPrice + legB size * entryPrice) / leverage
    // Simplified: use hedgeRatio and recommended leverage to estimate capital
    const estimatedCapital = this.estimateRequiredCapital(signal);
    const requiredWithBuffer = estimatedCapital + (estimatedCapital * BigInt(Math.round(this.config.marginBuffer * 100))) / 100n;

    // Get current Hyperliquid margin balance from store
    const currentBalance = this.getHyperliquidBalance();

    if (currentBalance >= requiredWithBuffer) {
      return null; // Sufficient
    }

    const deficit = requiredWithBuffer - currentBalance;

    return {
      signalId: signal.signalId,
      requiredAmount: requiredWithBuffer,
      currentBalance,
      deficit,
    };
  }

  /**
   * Select the single best source chain to cover the deficit.
   */
  selectSourceChain(deficit: bigint): ChainFundingPlan | null {
    const candidates = this.getChainBalances()
      .filter((c) => c.availableAmount >= this.config.minBridgeAmount)
      .filter((c) => c.availableAmount - this.config.gasReserveUsdc > 0n)
      .map((c) => ({
        ...c,
        bridgeableAmount: c.availableAmount - this.config.gasReserveUsdc,
      }))
      .filter((c) => c.bridgeableAmount >= deficit)
      .sort((a, b) => (b.bridgeableAmount > a.bridgeableAmount ? 1 : -1));

    if (candidates.length === 0) return null;

    const best = candidates[0];
    return {
      chainId: best.chainId,
      tokenAddress: best.tokenAddress,
      availableAmount: best.availableAmount,
      bridgeAmount: deficit,
    };
  }

  /**
   * Build a multi-chain plan when no single chain can cover the deficit.
   */
  buildMultiChainPlan(deficit: bigint): ChainFundingPlan[] {
    const candidates = this.getChainBalances()
      .filter((c) => c.availableAmount >= this.config.minBridgeAmount)
      .filter((c) => c.availableAmount - this.config.gasReserveUsdc > 0n)
      .map((c) => ({
        ...c,
        bridgeableAmount: c.availableAmount - this.config.gasReserveUsdc,
      }))
      .sort((a, b) => (b.bridgeableAmount > a.bridgeableAmount ? 1 : -1));

    const plans: ChainFundingPlan[] = [];
    let remaining = deficit;

    for (const candidate of candidates) {
      if (remaining <= 0n) break;
      if (plans.length >= this.config.maxConcurrentBridges) break;

      const bridgeAmount = candidate.bridgeableAmount < remaining
        ? candidate.bridgeableAmount
        : remaining;

      plans.push({
        chainId: candidate.chainId,
        tokenAddress: candidate.tokenAddress,
        availableAmount: candidate.availableAmount,
        bridgeAmount,
      });

      remaining -= bridgeAmount;
    }

    return plans;
  }

  /**
   * Build a funding plan: try single chain first, fall back to multi-chain.
   */
  buildFundingPlan(deficit: bigint): ChainFundingPlan[] {
    const singleChain = this.selectSourceChain(deficit);
    if (singleChain) return [singleChain];
    return this.buildMultiChainPlan(deficit);
  }

  // --- Batch Management ---

  private createBatch(
    signalId: string,
    targetAmount: bigint,
    plans: ChainFundingPlan[],
  ): FundingBatch {
    const batch: FundingBatch = {
      batchId: randomUUID(),
      triggeringSignalId: signalId,
      targetAmount,
      plans,
      totalBridged: 0n,
      completedCount: 0,
      failedCount: 0,
      status: 'pending',
    };

    this.activeBatches.set(batch.batchId, batch);
    logger.info(
      {
        batchId: batch.batchId,
        signalId,
        targetAmount: targetAmount.toString(),
        chainCount: plans.length,
      },
      'Funding batch created',
    );

    return batch;
  }

  /**
   * Called when a funding bridge completes successfully.
   */
  onBridgeCompleted(batchId: string, depositedAmount: bigint): void {
    const batch = this.activeBatches.get(batchId);
    if (!batch) return;

    batch.totalBridged += depositedAmount;
    batch.completedCount++;

    this.evaluateBatchCompletion(batch);
  }

  /**
   * Called when a funding bridge fails.
   */
  onBridgeFailed(batchId: string): void {
    const batch = this.activeBatches.get(batchId);
    if (!batch) return;

    batch.failedCount++;
    this.evaluateBatchCompletion(batch);
  }

  private evaluateBatchCompletion(batch: FundingBatch): void {
    const totalProcessed = batch.completedCount + batch.failedCount;
    const totalPlanned = batch.plans.length;

    if (totalProcessed < totalPlanned) {
      batch.status = 'in-progress';
      return;
    }

    // All bridges processed
    if (batch.failedCount === totalPlanned) {
      batch.status = 'failed';
      this.store.emitter.emit('transfer.completed', {
        id: batch.batchId,
        txHash: '',
        fromChain: chainId(0),
        toChain: HYPERLIQUID_CHAIN,
        fromToken: '' as TokenAddress,
        toToken: '' as TokenAddress,
        fromAmount: batch.targetAmount,
        toAmount: 0n,
        bridge: 'funding-batch',
        status: 'failed',
        completedAt: Date.now(),
      });
      logger.error({ batchId: batch.batchId }, 'Funding batch failed — all bridges failed');
    } else if (batch.totalBridged >= batch.targetAmount) {
      batch.status = 'completed';
      logger.info(
        { batchId: batch.batchId, totalBridged: batch.totalBridged.toString() },
        'Funding batch completed successfully',
      );
    } else {
      batch.status = 'partial';
      logger.warn(
        {
          batchId: batch.batchId,
          totalBridged: batch.totalBridged.toString(),
          targetAmount: batch.targetAmount.toString(),
        },
        'Funding batch partially completed',
      );
    }

    this.activeBatches.delete(batch.batchId);
  }

  // --- Helpers ---

  private hasBatchForSignal(signalId: string): boolean {
    for (const batch of this.activeBatches.values()) {
      if (batch.triggeringSignalId === signalId) return true;
    }
    return false;
  }

  private emitFundingActions(batch: FundingBatch): void {
    for (const plan of batch.plans) {
      const usdcOnArbitrum = USDC_ADDRESSES[CHAINS.ARBITRUM as number];
      if (!usdcOnArbitrum) {
        logger.error('USDC address for Arbitrum not found');
        continue;
      }

      const action: FundingBridgeAction = {
        id: randomUUID(),
        type: 'funding_bridge',
        priority: 8, // High priority — funding blocks trading
        createdAt: Date.now(),
        strategyId: 'funding-controller',
        fromChain: plan.chainId,
        toChain: CHAINS.ARBITRUM,
        fromToken: plan.tokenAddress,
        toToken: usdcOnArbitrum,
        amount: plan.bridgeAmount,
        fundingBatchId: batch.batchId,
        triggeringSignalId: batch.triggeringSignalId,
        depositToHyperliquid: true,
        metadata: {
          fundingBatchId: batch.batchId,
          triggeringSignalId: batch.triggeringSignalId,
        },
      };

      this.actionQueue.enqueue(action);
      logger.info(
        {
          actionId: action.id,
          fromChain: plan.chainId,
          amount: plan.bridgeAmount.toString(),
          batchId: batch.batchId,
        },
        'Funding bridge action enqueued',
      );
    }

    batch.status = 'in-progress';
  }

  /**
   * Estimate required capital from a stat arb signal.
   * Uses signal parameters to compute margin requirement in USDC smallest units (6 decimals).
   */
  private estimateRequiredCapital(signal: StatArbSignal): bigint {
    // Each leg requires: size × price / leverage
    // For estimation, assume ~$1000 notional per leg at leverage
    // hedgeRatio tells us the relative sizing
    // The actual sizing comes from the signal parameters
    //
    // Simple heuristic: base capital = $500 USDC per leg, scaled by leverage
    const baseCapitalPerLeg = 500_000_000n; // $500 in USDC (6 decimals)
    const legs = 2n;
    const leverageFactor = BigInt(signal.recommendedLeverage || 1);

    // Total margin = (baseCapitalPerLeg × legs) / leverage
    const totalCapital = (baseCapitalPerLeg * legs) / (leverageFactor > 0n ? leverageFactor : 1n);
    return totalCapital;
  }

  private getHyperliquidBalance(): bigint {
    // Check store for Hyperliquid margin balance
    // Convention: stored under Arbitrum chain with a special marker
    const balance = this.store.getBalance(
      HYPERLIQUID_CHAIN,
      USDC_ADDRESSES[HYPERLIQUID_CHAIN as number],
    );
    return balance?.amount ?? 0n;
  }

  private getChainBalances(): Array<{
    chainId: ChainId;
    tokenAddress: TokenAddress;
    availableAmount: bigint;
  }> {
    const results: Array<{
      chainId: ChainId;
      tokenAddress: TokenAddress;
      availableAmount: bigint;
    }> = [];

    for (const chain of this.config.sourceChains) {
      // Skip Arbitrum — that's the destination chain
      if (chain === CHAINS.ARBITRUM) continue;

      const usdcAddr = USDC_ADDRESSES[chain as number];
      if (!usdcAddr) continue;

      const available = this.store.getAvailableBalance(chain, usdcAddr);
      if (available > 0n) {
        results.push({ chainId: chain, tokenAddress: usdcAddr, availableAmount: available });
      }
    }

    return results;
  }

  // --- Accessors for testing ---

  getActiveBatches(): Map<string, FundingBatch> {
    return this.activeBatches;
  }

  getConfig(): FundingControllerConfig {
    return this.config;
  }

  getLastFundingCycleTime(): number {
    return this.lastFundingCycleTime;
  }
}
