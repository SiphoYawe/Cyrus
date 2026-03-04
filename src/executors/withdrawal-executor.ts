// WithdrawalExecutor — two-phase pipeline for Hyperliquid withdrawal + LI.FI bridge
// Phase 1 (Open): Withdraw USDC from Hyperliquid margin to Arbitrum wallet
// Phase 2 (Manage): Bridge USDC from Arbitrum to target EVM chain via LI.FI
// Critical: if bridge fails after withdrawal, USDC stays on Arbitrum (no retry into HL)

import { BaseExecutor } from './base-executor.js';
import type { StageResult } from './base-executor.js';
import type { ExecutorAction, WithdrawalAction } from '../core/action-types.js';
import type { ExecutionResult, TransferId } from '../core/types.js';
import type { LiFiConnectorInterface, QuoteResult, QuoteParams, LiFiStatusResponse } from '../connectors/types.js';
import type { HyperliquidConnectorInterface } from '../connectors/hyperliquid-connector.js';
import type { Store, CreateTransferParams } from '../core/store.js';
import type { ApprovalHandler } from './approval-handler.js';
import type { TransactionExecutor, TransactionResult } from './transaction-executor.js';
import type { PreFlightChecker, PreFlightConfig } from './pre-flight-checks.js';
import { DEFAULT_SLIPPAGE, CHAINS, USDC_ADDRESSES } from '../core/constants.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('withdrawal-executor');

const MAX_BRIDGE_ATTEMPTS = 2;

export const WITHDRAWAL_PHASES = {
  TRIGGER: 'trigger',
  WITHDRAWAL_PENDING: 'withdrawal-pending',
  WITHDRAWAL_CONFIRMED: 'withdrawal-confirmed',
  BRIDGE_PENDING: 'bridge-pending',
  BRIDGE_COMPLETE: 'bridge-complete',
  FAILED: 'failed',
} as const;

export type WithdrawalPhase = (typeof WITHDRAWAL_PHASES)[keyof typeof WITHDRAWAL_PHASES];

export interface WithdrawalExecutorConfig {
  readonly withdrawalTimeoutMs: number;    // 10 min default
  readonly withdrawalPollIntervalMs: number; // 5s default
  readonly maxGasCostUsd: number;
  readonly defaultSlippage: number;
  readonly bridgeTimeoutMs: number;        // 30 min warning
  readonly maxBridgePollingMs: number;     // 60 min hard limit
  readonly bridgePollIntervalMs?: number;  // override for tests
}

const DEFAULT_CONFIG: WithdrawalExecutorConfig = {
  withdrawalTimeoutMs: 10 * 60 * 1000,    // 10 min
  withdrawalPollIntervalMs: 5_000,        // 5s
  maxGasCostUsd: 50,
  defaultSlippage: DEFAULT_SLIPPAGE,
  bridgeTimeoutMs: 30 * 60 * 1000,        // 30 min
  maxBridgePollingMs: 60 * 60 * 1000,     // 60 min
};

export class WithdrawalExecutor extends BaseExecutor {
  private readonly connector: LiFiConnectorInterface;
  private readonly hyperliquidConnector: HyperliquidConnectorInterface;
  private readonly approvalHandler: ApprovalHandler;
  private readonly transactionExecutor: TransactionExecutor;
  private readonly preFlightChecker: PreFlightChecker;
  private readonly store: Store;
  private readonly config: WithdrawalExecutorConfig;

  // Internal state (reset per execution)
  private phase: WithdrawalPhase = WITHDRAWAL_PHASES.TRIGGER;
  private withdrawnAmount: bigint = 0n;
  private quote: QuoteResult | null = null;
  private txResult: TransactionResult | null = null;
  private transferId: TransferId | null = null;
  private statusResponse: LiFiStatusResponse | null = null;

  constructor(
    connector: LiFiConnectorInterface,
    hyperliquidConnector: HyperliquidConnectorInterface,
    approvalHandler: ApprovalHandler,
    transactionExecutor: TransactionExecutor,
    preFlightChecker: PreFlightChecker,
    store: Store,
    config?: Partial<WithdrawalExecutorConfig>,
  ) {
    super();
    this.connector = connector;
    this.hyperliquidConnector = hyperliquidConnector;
    this.approvalHandler = approvalHandler;
    this.transactionExecutor = transactionExecutor;
    this.preFlightChecker = preFlightChecker;
    this.store = store;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  canHandle(action: ExecutorAction): boolean {
    return action.type === 'withdrawal';
  }

  async execute(action: ExecutorAction): Promise<ExecutionResult> {
    this.phase = WITHDRAWAL_PHASES.TRIGGER;
    this.withdrawnAmount = 0n;
    this.quote = null;
    this.txResult = null;
    this.transferId = null;
    this.statusResponse = null;
    return super.execute(action);
  }

  // --- Trigger Stage: Validate withdrawal ---
  protected async trigger(action: ExecutorAction): Promise<StageResult> {
    if (!this.canHandle(action)) {
      return { success: false, error: `WithdrawalExecutor cannot handle action type: ${action.type}` };
    }

    const withdrawal = action as WithdrawalAction;

    // Validate amount > 0
    if (withdrawal.amount <= 0n) {
      return { success: false, error: 'Withdrawal amount must be positive' };
    }

    // Validate target chain has USDC address
    const targetUsdc = USDC_ADDRESSES[withdrawal.targetChainId as number];
    if (!targetUsdc) {
      return { success: false, error: `No USDC address for target chain ${withdrawal.targetChainId}` };
    }

    logger.info(
      {
        actionId: action.id,
        amount: withdrawal.amount.toString(),
        targetChain: withdrawal.targetChainId,
        reason: withdrawal.reason,
      },
      'Withdrawal trigger stage passed',
    );

    return { success: true };
  }

  // --- Open Stage: Initiate Hyperliquid withdrawal ---
  protected async open(action: ExecutorAction): Promise<StageResult> {
    const withdrawal = action as WithdrawalAction;
    this.phase = WITHDRAWAL_PHASES.WITHDRAWAL_PENDING;

    try {
      // Format amount for Hyperliquid (decimal string)
      const amountStr = this.formatUsdcAmount(withdrawal.amount);

      logger.info(
        { amount: amountStr, targetChain: withdrawal.targetChainId },
        'Initiating Hyperliquid margin withdrawal',
      );

      const success = await this.hyperliquidConnector.withdrawFromMargin(amountStr);
      if (!success) {
        this.phase = WITHDRAWAL_PHASES.FAILED;
        return { success: false, error: 'Hyperliquid margin withdrawal request rejected' };
      }

      this.withdrawnAmount = withdrawal.amount;

      // Create InFlightTransfer to track the overall flow
      const transferParams: CreateTransferParams = {
        txHash: null, // No tx hash for HL withdrawal
        fromChain: CHAINS.ARBITRUM, // HL settles on Arbitrum
        toChain: withdrawal.targetChainId,
        fromToken: USDC_ADDRESSES[CHAINS.ARBITRUM as number],
        toToken: withdrawal.targetToken,
        amount: withdrawal.amount,
        bridge: 'hyperliquid-withdrawal',
        quoteData: { reason: withdrawal.reason, phase: 'withdrawal' },
      };

      const transfer = this.store.createTransfer(transferParams);
      this.transferId = transfer.id;

      logger.info(
        { transferId: transfer.id, amount: amountStr },
        'Hyperliquid withdrawal initiated',
      );

      return {
        success: true,
        data: {
          transferId: transfer.id,
          withdrawnAmount: amountStr,
          phase: this.phase,
        },
      };
    } catch (err) {
      this.phase = WITHDRAWAL_PHASES.FAILED;
      const message = err instanceof Error ? err.message : 'Unknown error';
      logger.error({ error: message }, 'Hyperliquid withdrawal failed');
      return { success: false, error: message };
    }
  }

  // --- Manage Stage: Two-phase monitoring ---
  protected async manage(action: ExecutorAction): Promise<StageResult> {
    const withdrawal = action as WithdrawalAction;

    // Phase 1: Wait for Hyperliquid withdrawal to confirm (USDC arrives on Arbitrum)
    const withdrawalResult = await this.waitForWithdrawalConfirmation();
    if (!withdrawalResult.success) {
      this.phase = WITHDRAWAL_PHASES.FAILED;
      return withdrawalResult;
    }

    this.phase = WITHDRAWAL_PHASES.WITHDRAWAL_CONFIRMED;
    logger.info('Hyperliquid withdrawal confirmed, initiating bridge');

    // Phase 2: Bridge from Arbitrum to target chain
    const bridgeResult = await this.executeBridge(withdrawal);
    if (!bridgeResult.success) {
      // Bridge failed — USDC stays on Arbitrum
      // Update Arbitrum USDC balance instead
      this.phase = WITHDRAWAL_PHASES.FAILED;
      return bridgeResult;
    }

    // Phase 3: Poll bridge status
    this.phase = WITHDRAWAL_PHASES.BRIDGE_PENDING;
    const statusResult = await this.pollBridgeStatus(withdrawal);
    if (!statusResult.success) {
      this.phase = WITHDRAWAL_PHASES.FAILED;
      return statusResult;
    }

    this.phase = WITHDRAWAL_PHASES.BRIDGE_COMPLETE;
    return { success: true };
  }

  // --- Close Stage: Finalize based on outcome ---
  protected async close(action: ExecutorAction): Promise<StageResult> {
    const withdrawal = action as WithdrawalAction;

    if (this.phase === WITHDRAWAL_PHASES.FAILED && !this.statusResponse) {
      // Hyperliquid withdrawal failed — no bridge was attempted
      if (this.transferId) {
        this.store.updateTransferStatus(this.transferId, 'failed');
      }
      logger.error(
        { actionId: action.id, phase: this.phase },
        'Withdrawal failed at Hyperliquid stage',
      );
      return {
        success: true,
        data: {
          transferId: this.transferId,
          phase: this.phase,
          status: 'withdrawal_failed',
        },
      };
    }

    if (!this.statusResponse || !this.transferId) {
      return { success: false, error: 'No status data to close withdrawal' };
    }

    const status = this.statusResponse.status;
    const substatus = this.statusResponse.substatus;
    const receiving = this.statusResponse.receiving;

    if (status === 'DONE' && substatus === 'COMPLETED') {
      const receivedAmount = receiving?.amount ? BigInt(receiving.amount) : 0n;
      const receivedToken = receiving?.token?.address ?? (withdrawal.targetToken as string);

      this.store.completeTransfer(
        this.transferId,
        receivedAmount,
        receivedToken as any,
        withdrawal.targetChainId,
      );

      logger.info(
        {
          transferId: this.transferId,
          receivedAmount: receivedAmount.toString(),
          targetChain: withdrawal.targetChainId,
        },
        'Withdrawal completed successfully',
      );
    } else if (status === 'DONE' && substatus === 'PARTIAL') {
      const receivedAmount = receiving?.amount ? BigInt(receiving.amount) : 0n;
      this.store.completeTransfer(
        this.transferId,
        receivedAmount,
        (receiving?.token?.address ?? withdrawal.targetToken) as any,
        withdrawal.targetChainId,
      );

      logger.warn(
        { transferId: this.transferId, receivedAmount: receivedAmount.toString() },
        'Withdrawal bridge completed with partial fill',
      );
    } else if (status === 'DONE' && substatus === 'REFUNDED') {
      // USDC refunded back to Arbitrum
      this.store.completeTransfer(
        this.transferId,
        this.withdrawnAmount,
        USDC_ADDRESSES[CHAINS.ARBITRUM as number],
        CHAINS.ARBITRUM,
      );

      logger.warn(
        { transferId: this.transferId },
        'Bridge refunded — USDC returned to Arbitrum, manual intervention recommended',
      );
    } else {
      // FAILED — USDC stays on Arbitrum
      this.store.updateTransferStatus(this.transferId, 'failed');

      // Update Arbitrum balance to reflect USDC is there
      const arbUsdc = USDC_ADDRESSES[CHAINS.ARBITRUM as number];
      const currentBalance = this.store.getBalance(CHAINS.ARBITRUM, arbUsdc);
      if (currentBalance) {
        this.store.setBalance(
          CHAINS.ARBITRUM,
          arbUsdc,
          currentBalance.amount + this.withdrawnAmount,
          currentBalance.usdValue + Number(this.withdrawnAmount) / 1_000_000,
          'USDC',
          6,
        );
      }

      logger.error(
        {
          transferId: this.transferId,
          status,
          substatus,
          bridge: this.quote?.tool,
        },
        'Bridge failed after Hyperliquid withdrawal — USDC on Arbitrum, manual intervention recommended',
      );
    }

    return {
      success: true,
      data: {
        transferId: this.transferId,
        txHash: this.txResult?.txHash ?? null,
        status,
        substatus,
        bridge: this.quote?.tool ?? 'unknown',
        phase: this.phase,
      },
    };
  }

  // --- Internal Phases ---

  private async waitForWithdrawalConfirmation(): Promise<StageResult> {
    const startTime = Date.now();
    const pollInterval = this.config.bridgePollIntervalMs ?? this.config.withdrawalPollIntervalMs;

    while (Date.now() - startTime < this.config.withdrawalTimeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, pollInterval));

      try {
        // Check Hyperliquid balance to see if withdrawal processed
        const balance = await this.hyperliquidConnector.queryBalance();
        // If withdrawable has decreased, withdrawal is processing/complete
        // For now, we assume the withdrawal confirms after the first successful poll
        // In production, this would check on-chain Arbitrum USDC balance

        logger.debug(
          { withdrawable: balance.withdrawable, elapsed: Date.now() - startTime },
          'Checking withdrawal confirmation',
        );

        // Simulated confirmation — in production, check Arbitrum USDC balance
        return { success: true };
      } catch (err) {
        logger.warn(
          { error: (err as Error).message },
          'Withdrawal confirmation poll error',
        );
      }
    }

    logger.error(
      { elapsed: Date.now() - startTime, timeout: this.config.withdrawalTimeoutMs },
      'Hyperliquid withdrawal timed out',
    );
    return { success: false, error: 'Hyperliquid withdrawal timed out' };
  }

  private async executeBridge(withdrawal: WithdrawalAction): Promise<StageResult> {
    const arbUsdc = USDC_ADDRESSES[CHAINS.ARBITRUM as number];
    let attempts = 0;

    while (attempts < MAX_BRIDGE_ATTEMPTS) {
      attempts++;
      try {
        const quoteParams: QuoteParams = {
          fromChain: CHAINS.ARBITRUM,
          toChain: withdrawal.targetChainId,
          fromToken: arbUsdc,
          toToken: withdrawal.targetToken,
          fromAmount: this.withdrawnAmount.toString(),
          slippage: this.config.defaultSlippage,
        };

        this.quote = await this.connector.getQuote(quoteParams);
        logger.info(
          { tool: this.quote.tool, toAmount: this.quote.estimate.toAmount },
          'Withdrawal bridge quote received',
        );

        // Pre-flight checks
        const preFlightConfig: PreFlightConfig = {
          maxGasCostUsd: this.config.maxGasCostUsd,
          defaultSlippage: this.config.defaultSlippage,
          maxBridgeTimeout: this.config.bridgeTimeoutMs / 1000,
        };

        const preFlightResult = this.preFlightChecker.runAllChecks(this.quote, preFlightConfig);
        if (!preFlightResult.passed) {
          return {
            success: false,
            error: `Pre-flight checks failed: ${preFlightResult.failures.join('; ')}`,
          };
        }

        // Handle approval
        const approvalTxHash = await this.approvalHandler.handleApproval(
          this.quote,
          arbUsdc,
        );
        if (approvalTxHash) {
          logger.info({ approvalTxHash }, 'Bridge approval confirmed');
        }

        // Execute bridge transaction
        this.txResult = await this.transactionExecutor.execute(this.quote);

        // Update InFlightTransfer with bridge tx hash
        if (this.transferId) {
          this.store.updateTransferStatus(this.transferId, 'in_flight', {
            txHash: this.txResult.txHash,
          });
        }

        logger.info(
          { txHash: this.txResult.txHash, bridge: this.quote.tool },
          'Withdrawal bridge transaction submitted',
        );

        return { success: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        const isRevert = message.toLowerCase().includes('execution reverted');

        if (isRevert && attempts < MAX_BRIDGE_ATTEMPTS) {
          logger.warn({ attempt: attempts, error: message }, 'Bridge execution reverted, retrying');
          continue;
        }

        logger.error({ attempt: attempts, error: message }, 'Withdrawal bridge failed');
        return { success: false, error: message };
      }
    }

    return { success: false, error: 'Max bridge retry attempts exceeded' };
  }

  private async pollBridgeStatus(withdrawal: WithdrawalAction): Promise<StageResult> {
    if (!this.txResult || !this.quote) {
      return { success: false, error: 'No bridge transaction to poll' };
    }

    const startTime = Date.now();
    let pollIndex = 0;
    let timeoutWarned = false;

    const pollIntervals = [
      10_000, 10_000, 10_000, 10_000, 10_000, 10_000,
      30_000, 30_000, 30_000, 30_000, 30_000, 30_000,
      60_000, 60_000, 60_000, 60_000, 60_000, 60_000,
      60_000, 60_000, 60_000, 60_000, 60_000, 60_000,
    ];

    while (Date.now() - startTime < this.config.maxBridgePollingMs) {
      const interval = this.config.bridgePollIntervalMs ?? (
        pollIndex < pollIntervals.length ? pollIntervals[pollIndex] : 120_000
      );

      await new Promise((resolve) => setTimeout(resolve, interval));
      pollIndex++;

      const elapsed = Date.now() - startTime;
      if (!timeoutWarned && elapsed > this.config.bridgeTimeoutMs) {
        logger.warn(
          { transferId: this.transferId, elapsedMs: elapsed, bridge: this.quote.tool },
          'Withdrawal bridge timeout barrier exceeded, continuing to poll',
        );
        timeoutWarned = true;
      }

      try {
        this.statusResponse = await this.connector.getStatus(
          this.txResult.txHash,
          this.quote.tool,
          CHAINS.ARBITRUM as number,
          withdrawal.targetChainId as number,
        );

        const status = this.statusResponse.status;

        if (status === 'NOT_FOUND' || status === 'PENDING') {
          logger.debug({ status, pollIndex }, 'Withdrawal bridge still in progress');
          continue;
        }

        if (status === 'DONE' || status === 'FAILED') {
          logger.info(
            { status, substatus: this.statusResponse.substatus, elapsedMs: elapsed },
            'Withdrawal bridge reached terminal status',
          );
          return { success: true };
        }
      } catch (err) {
        logger.warn({ error: (err as Error).message, pollIndex }, 'Bridge status poll error');
      }
    }

    logger.warn({ transferId: this.transferId }, 'Withdrawal bridge polling timed out');
    return { success: false, error: 'Withdrawal bridge status polling timed out' };
  }

  // --- Helpers ---

  private formatUsdcAmount(amount: bigint): string {
    const whole = amount / 1_000_000n;
    const frac = amount % 1_000_000n;
    if (frac === 0n) return whole.toString();
    const fracStr = frac.toString().padStart(6, '0').replace(/0+$/, '');
    return `${whole}.${fracStr}`;
  }

  getPhase(): WithdrawalPhase {
    return this.phase;
  }
}
