// WithdrawalController — evaluates withdrawal requests and emits withdrawal actions
// Validates margin safety, daily limits, and target chain support

import { randomUUID } from 'node:crypto';
import { RunnableBase } from '../core/runnable-base.js';
import type { Store } from '../core/store.js';
import type { ActionQueue } from '../core/action-queue.js';
import type { HyperliquidConnectorInterface } from '../connectors/hyperliquid-connector.js';
import type { WithdrawalAction, WithdrawalReason } from '../core/action-types.js';
import type { ChainId, TokenAddress } from '../core/types.js';
import { CHAINS, USDC_ADDRESSES } from '../core/constants.js';
import type { FundingMutex } from './funding-mutex.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('withdrawal-controller');

// --- Config ---

export interface WithdrawalControllerConfig {
  /** Hyperliquid withdrawal timeout in ms (default 10 min) */
  readonly withdrawalTimeoutMs: number;
  /** Minimum withdrawal amount in USDC smallest units (default 50 USDC) */
  readonly minWithdrawalAmount: bigint;
  /** Safety buffer as fraction of required margin for open positions (default 0.20 = 20%) */
  readonly marginSafetyBuffer: number;
  /** Max total USDC withdrawals per day in smallest units (default 10,000 USDC) */
  readonly maxWithdrawalPerDay: bigint;
  /** Tick interval in ms (default 30s) */
  readonly tickIntervalMs: number;
  /** Supported target chains for withdrawals */
  readonly supportedTargetChains: readonly ChainId[];
}

const DEFAULT_CONFIG: WithdrawalControllerConfig = {
  withdrawalTimeoutMs: 10 * 60 * 1000, // 10 min
  minWithdrawalAmount: 50_000_000n,     // 50 USDC
  marginSafetyBuffer: 0.20,
  maxWithdrawalPerDay: 10_000_000_000n, // 10,000 USDC
  tickIntervalMs: 30_000,
  supportedTargetChains: [
    CHAINS.ETHEREUM,
    CHAINS.OPTIMISM,
    CHAINS.POLYGON,
    CHAINS.BASE,
    CHAINS.BSC,
  ],
};

// --- Types ---

export interface WithdrawalRequest {
  readonly amount: bigint;
  readonly targetChainId: ChainId;
  readonly targetToken: TokenAddress;
  readonly reason: WithdrawalReason;
}

export interface WithdrawalPlan {
  readonly requestId: string;
  readonly amount: bigint;
  readonly targetChainId: ChainId;
  readonly targetToken: TokenAddress;
  readonly reason: WithdrawalReason;
  readonly availableMargin: bigint;
  readonly requiredMarginForPositions: bigint;
}

export class WithdrawalController extends RunnableBase {
  private readonly store: Store;
  private readonly actionQueue: ActionQueue;
  private readonly hyperliquidConnector: HyperliquidConnectorInterface;
  private readonly config: WithdrawalControllerConfig;
  private readonly pendingRequests: WithdrawalRequest[] = [];
  private readonly mutex: FundingMutex | null;
  private dailyWithdrawn: bigint = 0n;
  private dailyResetTimestamp: number = 0;

  constructor(
    store: Store,
    actionQueue: ActionQueue,
    hyperliquidConnector: HyperliquidConnectorInterface,
    config?: Partial<WithdrawalControllerConfig>,
    mutex?: FundingMutex,
  ) {
    const merged = { ...DEFAULT_CONFIG, ...config };
    super(merged.tickIntervalMs, 'withdrawal-controller');
    this.store = store;
    this.actionQueue = actionQueue;
    this.hyperliquidConnector = hyperliquidConnector;
    this.config = merged;
    this.mutex = mutex ?? null;
  }

  async controlTask(): Promise<void> {
    this.resetDailyLimitIfNeeded();

    if (this.pendingRequests.length === 0) return;

    // Acquire mutex if present (prevents conflicting with funding controller)
    if (this.mutex && !this.mutex.acquire('withdrawal')) {
      logger.debug('Funding in progress, skipping withdrawal evaluation');
      return;
    }

    try {
      // Process one request at a time
      const request = this.pendingRequests[0];
      const plan = await this.evaluateWithdrawal(request);

      if (!plan) {
        // Remove invalid request
        this.pendingRequests.shift();
        return;
      }

      this.emitWithdrawalAction(plan);
      this.pendingRequests.shift();
    } finally {
      this.mutex?.release('withdrawal');
    }
  }

  async onStop(): Promise<void> {
    this.mutex?.release('withdrawal');
    logger.info(
      { pendingRequests: this.pendingRequests.length },
      'WithdrawalController stopping',
    );
  }

  /**
   * Submit a withdrawal request for processing.
   */
  requestWithdrawal(request: WithdrawalRequest): void {
    this.pendingRequests.push(request);
    logger.info(
      {
        amount: request.amount.toString(),
        targetChain: request.targetChainId,
        reason: request.reason,
      },
      'Withdrawal request queued',
    );
  }

  /**
   * Evaluate whether a withdrawal request is valid and safe.
   */
  async evaluateWithdrawal(request: WithdrawalRequest): Promise<WithdrawalPlan | null> {
    // 1. Validate minimum amount
    if (request.amount < this.config.minWithdrawalAmount) {
      logger.warn(
        {
          amount: request.amount.toString(),
          minimum: this.config.minWithdrawalAmount.toString(),
        },
        'Withdrawal amount below minimum',
      );
      return null;
    }

    // 2. Validate target chain is supported
    if (!this.isTargetChainSupported(request.targetChainId)) {
      logger.warn(
        { targetChain: request.targetChainId },
        'Target chain not supported for withdrawal',
      );
      return null;
    }

    // 3. Check daily withdrawal limit
    this.resetDailyLimitIfNeeded();
    if (this.dailyWithdrawn + request.amount > this.config.maxWithdrawalPerDay) {
      logger.warn(
        {
          requested: request.amount.toString(),
          dailyWithdrawn: this.dailyWithdrawn.toString(),
          dailyLimit: this.config.maxWithdrawalPerDay.toString(),
        },
        'Daily withdrawal limit would be exceeded',
      );
      return null;
    }

    // 4. Query Hyperliquid balance and positions
    const balance = await this.hyperliquidConnector.queryBalance();
    const positions = await this.hyperliquidConnector.queryPositions();

    // Available margin (what can be withdrawn)
    const availableMarginUsd = balance.withdrawable;
    const availableMargin = BigInt(Math.floor(availableMarginUsd * 1_000_000));

    // Required margin for open positions
    const totalMarginUsed = balance.totalMarginUsed;
    const requiredMarginForPositions = BigInt(Math.floor(totalMarginUsed * 1_000_000));

    // Safety buffer: cannot withdraw if it would leave margin below safety threshold
    const safetyBufferAmount = (requiredMarginForPositions * BigInt(Math.round(this.config.marginSafetyBuffer * 100))) / 100n;
    const safeMaxWithdrawal = availableMargin > safetyBufferAmount
      ? availableMargin - safetyBufferAmount
      : 0n;

    if (request.amount > safeMaxWithdrawal) {
      logger.warn(
        {
          requestedAmount: request.amount.toString(),
          availableMargin: availableMargin.toString(),
          safeMax: safeMaxWithdrawal.toString(),
          requiredMargin: requiredMarginForPositions.toString(),
          openPositions: positions.length,
        },
        'Withdrawal amount exceeds safe margin limit',
      );
      return null;
    }

    // 5. Validate USDC address exists on target chain
    const targetUsdcAddr = USDC_ADDRESSES[request.targetChainId as number];
    if (!targetUsdcAddr) {
      logger.warn(
        { targetChain: request.targetChainId },
        'No USDC address for target chain',
      );
      return null;
    }

    // All validations passed
    const plan: WithdrawalPlan = {
      requestId: randomUUID(),
      amount: request.amount,
      targetChainId: request.targetChainId,
      targetToken: request.targetToken,
      reason: request.reason,
      availableMargin,
      requiredMarginForPositions,
    };

    logger.info(
      {
        requestId: plan.requestId,
        amount: plan.amount.toString(),
        targetChain: plan.targetChainId,
        reason: plan.reason,
      },
      'Withdrawal plan approved',
    );

    return plan;
  }

  // --- Helpers ---

  private isTargetChainSupported(chainId: ChainId): boolean {
    return this.config.supportedTargetChains.includes(chainId);
  }

  private resetDailyLimitIfNeeded(): void {
    const now = Date.now();
    const oneDayMs = 24 * 60 * 60 * 1000;
    if (now - this.dailyResetTimestamp > oneDayMs) {
      this.dailyWithdrawn = 0n;
      this.dailyResetTimestamp = now;
    }
  }

  private emitWithdrawalAction(plan: WithdrawalPlan): void {
    const action: WithdrawalAction = {
      id: randomUUID(),
      type: 'withdrawal',
      priority: 7,
      createdAt: Date.now(),
      strategyId: 'withdrawal-controller',
      amount: plan.amount,
      targetChainId: plan.targetChainId,
      targetToken: plan.targetToken,
      reason: plan.reason,
      metadata: {
        requestId: plan.requestId,
        availableMargin: plan.availableMargin.toString(),
        requiredMargin: plan.requiredMarginForPositions.toString(),
      },
    };

    this.actionQueue.enqueue(action);
    this.dailyWithdrawn += plan.amount;

    logger.info(
      {
        actionId: action.id,
        amount: plan.amount.toString(),
        targetChain: plan.targetChainId,
      },
      'Withdrawal action enqueued',
    );
  }

  // --- Accessors for testing ---

  getPendingRequests(): readonly WithdrawalRequest[] {
    return this.pendingRequests;
  }

  getDailyWithdrawn(): bigint {
    return this.dailyWithdrawn;
  }

  getConfig(): WithdrawalControllerConfig {
    return this.config;
  }
}
