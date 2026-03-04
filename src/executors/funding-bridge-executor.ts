// FundingBridgeExecutor — stage pipeline for cross-chain bridge + Hyperliquid margin deposit
// Extends BridgeExecutor pattern with Hyperliquid deposit in Close stage
// Bridges USDC from any EVM chain to Arbitrum, then deposits to Hyperliquid margin

import { BaseExecutor } from './base-executor.js';
import type { StageResult } from './base-executor.js';
import type { ExecutorAction, FundingBridgeAction } from '../core/action-types.js';
import type { ExecutionResult, TransferId } from '../core/types.js';
import type { LiFiConnectorInterface, QuoteResult, QuoteParams, LiFiStatusResponse } from '../connectors/types.js';
import type { HyperliquidConnectorInterface } from '../connectors/hyperliquid-connector.js';
import type { Store, CreateTransferParams } from '../core/store.js';
import type { ApprovalHandler } from './approval-handler.js';
import type { TransactionExecutor, TransactionResult } from './transaction-executor.js';
import type { PreFlightChecker, PreFlightConfig } from './pre-flight-checks.js';
import { DEFAULT_SLIPPAGE } from '../core/constants.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('funding-bridge-executor');

const MAX_ATTEMPTS = 2;

export interface FundingBridgeExecutorConfig {
  readonly maxGasCostUsd: number;
  readonly defaultSlippage: number;
  readonly bridgeTimeoutMs: number;     // 30 min warning threshold
  readonly maxPollingDurationMs: number; // 60 min hard limit
  readonly pollIntervalMs?: number;      // override for tests
}

const DEFAULT_CONFIG: FundingBridgeExecutorConfig = {
  maxGasCostUsd: 50,
  defaultSlippage: DEFAULT_SLIPPAGE,
  bridgeTimeoutMs: 30 * 60 * 1000,     // 30 min
  maxPollingDurationMs: 60 * 60 * 1000, // 60 min
};

export class FundingBridgeExecutor extends BaseExecutor {
  private readonly connector: LiFiConnectorInterface;
  private readonly hyperliquidConnector: HyperliquidConnectorInterface;
  private readonly approvalHandler: ApprovalHandler;
  private readonly transactionExecutor: TransactionExecutor;
  private readonly preFlightChecker: PreFlightChecker;
  private readonly store: Store;
  private readonly config: FundingBridgeExecutorConfig;

  // Callback to notify FundingController of completion
  private readonly onCompleted?: (batchId: string, depositedAmount: bigint) => void;
  private readonly onFailed?: (batchId: string) => void;

  // Stage state (reset per execution)
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
    config?: Partial<FundingBridgeExecutorConfig>,
    callbacks?: {
      onCompleted?: (batchId: string, depositedAmount: bigint) => void;
      onFailed?: (batchId: string) => void;
    },
  ) {
    super();
    this.connector = connector;
    this.hyperliquidConnector = hyperliquidConnector;
    this.approvalHandler = approvalHandler;
    this.transactionExecutor = transactionExecutor;
    this.preFlightChecker = preFlightChecker;
    this.store = store;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.onCompleted = callbacks?.onCompleted;
    this.onFailed = callbacks?.onFailed;
  }

  canHandle(action: ExecutorAction): boolean {
    return action.type === 'funding_bridge';
  }

  async execute(action: ExecutorAction): Promise<ExecutionResult> {
    this.quote = null;
    this.txResult = null;
    this.transferId = null;
    this.statusResponse = null;
    const result = await super.execute(action);

    // If execution failed at any stage (e.g. polling timeout), notify the controller
    // so the batch does not get stuck in 'in-progress' forever.
    if (!result.success && action.type === 'funding_bridge') {
      const funding = action as FundingBridgeAction;
      this.onFailed?.(funding.fundingBatchId);
    }

    return result;
  }

  // --- Trigger Stage ---
  protected async trigger(action: ExecutorAction): Promise<StageResult> {
    if (!this.canHandle(action)) {
      return { success: false, error: `FundingBridgeExecutor cannot handle action type: ${action.type}` };
    }

    const funding = action as FundingBridgeAction;

    // Must be cross-chain
    if (funding.fromChain === funding.toChain) {
      return { success: false, error: 'Funding bridge requires cross-chain transfer (fromChain !== toChain)' };
    }

    // Check available USDC balance on source chain
    const available = this.store.getAvailableBalance(funding.fromChain, funding.fromToken);
    if (available < funding.amount) {
      return {
        success: false,
        error: `Insufficient USDC on chain ${funding.fromChain}: need ${funding.amount}, have ${available}`,
      };
    }

    logger.info(
      {
        actionId: action.id,
        fromChain: funding.fromChain,
        toChain: funding.toChain,
        amount: funding.amount.toString(),
        batchId: funding.fundingBatchId,
        signalId: funding.triggeringSignalId,
      },
      'Funding bridge trigger stage passed',
    );

    return { success: true };
  }

  // --- Open Stage ---
  protected async open(action: ExecutorAction): Promise<StageResult> {
    const funding = action as FundingBridgeAction;
    let attempts = 0;

    while (attempts < MAX_ATTEMPTS) {
      attempts++;
      try {
        // Request LI.FI quote
        const quoteParams: QuoteParams = {
          fromChain: funding.fromChain,
          toChain: funding.toChain,
          fromToken: funding.fromToken,
          toToken: funding.toToken,
          fromAmount: funding.amount.toString(),
          slippage: this.config.defaultSlippage,
        };

        this.quote = await this.connector.getQuote(quoteParams);
        logger.info(
          { tool: this.quote.tool, toAmount: this.quote.estimate.toAmount },
          'Funding bridge quote received',
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

        // Handle token approval
        const approvalTxHash = await this.approvalHandler.handleApproval(
          this.quote,
          funding.fromToken,
        );
        if (approvalTxHash) {
          logger.info({ approvalTxHash }, 'Funding bridge token approval confirmed');
        }

        // Execute bridge transaction
        this.txResult = await this.transactionExecutor.execute(this.quote);

        // Create InFlightTransfer with funding context
        const bridgeTool = this.quote.tool || 'unknown';
        const transferParams: CreateTransferParams = {
          txHash: this.txResult.txHash,
          fromChain: funding.fromChain,
          toChain: funding.toChain,
          fromToken: funding.fromToken,
          toToken: funding.toToken,
          amount: funding.amount,
          bridge: bridgeTool,
          quoteData: {
            ...this.quote,
            fundingBatchId: funding.fundingBatchId,
            triggeringSignalId: funding.triggeringSignalId,
          },
        };

        const transfer = this.store.createTransfer(transferParams);
        this.transferId = transfer.id;

        logger.info(
          {
            transferId: transfer.id,
            txHash: this.txResult.txHash,
            bridge: bridgeTool,
            batchId: funding.fundingBatchId,
          },
          'Funding bridge open stage complete',
        );

        return {
          success: true,
          data: {
            transferId: transfer.id,
            txHash: this.txResult.txHash,
            bridge: bridgeTool,
            tool: this.quote.tool,
            fundingBatchId: funding.fundingBatchId,
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        const isRevert = message.toLowerCase().includes('execution reverted');

        if (isRevert && attempts < MAX_ATTEMPTS) {
          logger.warn({ attempt: attempts, error: message }, 'Funding bridge execution reverted, retrying');
          continue;
        }

        logger.error({ attempt: attempts, error: message }, 'Funding bridge open stage failed');
        return { success: false, error: message };
      }
    }

    return { success: false, error: 'Max retry attempts exceeded' };
  }

  // --- Manage Stage ---
  protected async manage(action: ExecutorAction): Promise<StageResult> {
    if (!this.txResult || !this.quote || !this.transferId) {
      return { success: false, error: 'No funding bridge transaction to manage' };
    }

    const funding = action as FundingBridgeAction;
    const startTime = Date.now();
    let pollIndex = 0;
    let timeoutWarned = false;

    // Exponential backoff: 10s × 6, 30s × 6, 60s × 12, then 120s
    const pollIntervals = [
      10_000, 10_000, 10_000, 10_000, 10_000, 10_000,
      30_000, 30_000, 30_000, 30_000, 30_000, 30_000,
      60_000, 60_000, 60_000, 60_000, 60_000, 60_000,
      60_000, 60_000, 60_000, 60_000, 60_000, 60_000,
    ];

    while (Date.now() - startTime < this.config.maxPollingDurationMs) {
      const interval = this.config.pollIntervalMs ?? (
        pollIndex < pollIntervals.length ? pollIntervals[pollIndex] : 120_000
      );

      await new Promise((resolve) => setTimeout(resolve, interval));
      pollIndex++;

      // Check bridge timeout warning
      const elapsed = Date.now() - startTime;
      if (!timeoutWarned && elapsed > this.config.bridgeTimeoutMs) {
        logger.warn(
          { transferId: this.transferId, elapsedMs: elapsed, bridge: this.quote.tool },
          'Funding bridge timeout barrier exceeded, continuing to poll',
        );
        timeoutWarned = true;
      }

      try {
        this.statusResponse = await this.connector.getStatus(
          this.txResult.txHash,
          this.quote.tool,
          funding.fromChain as number,
          funding.toChain as number,
        );

        const status = this.statusResponse.status;

        if (status === 'NOT_FOUND' || status === 'PENDING') {
          logger.debug({ status, pollIndex }, 'Funding bridge still in progress');
          continue;
        }

        if (status === 'DONE' || status === 'FAILED') {
          logger.info(
            { status, substatus: this.statusResponse.substatus, elapsedMs: elapsed },
            'Funding bridge reached terminal status',
          );
          return { success: true };
        }
      } catch (err) {
        logger.warn({ error: (err as Error).message, pollIndex }, 'Funding bridge status poll error');
      }
    }

    logger.warn({ transferId: this.transferId }, 'Funding bridge polling timed out');
    return { success: false, error: 'Funding bridge status polling timed out' };
  }

  // --- Close Stage ---
  protected async close(action: ExecutorAction): Promise<StageResult> {
    if (!this.statusResponse || !this.transferId || !this.txResult) {
      return { success: false, error: 'No status data to close funding bridge' };
    }

    const funding = action as FundingBridgeAction;
    const status = this.statusResponse.status;
    const substatus = this.statusResponse.substatus;
    const receiving = this.statusResponse.receiving;

    if (status === 'DONE' && substatus === 'COMPLETED') {
      const receivedAmount = receiving?.amount ? BigInt(receiving.amount) : 0n;
      const receivedToken = receiving?.token?.address ?? (funding.toToken as string);

      // Complete the transfer in store
      this.store.completeTransfer(
        this.transferId,
        receivedAmount,
        receivedToken as any,
        funding.toChain,
      );

      // Deposit to Hyperliquid if configured
      if (funding.depositToHyperliquid && receivedAmount > 0n) {
        try {
          // Convert bigint to decimal string for Hyperliquid (6 decimals for USDC)
          const depositAmountStr = this.formatUsdcAmount(receivedAmount);
          await this.hyperliquidConnector.depositToMargin(depositAmountStr);

          logger.info(
            {
              transferId: this.transferId,
              depositedAmount: receivedAmount.toString(),
              depositAmountStr,
            },
            'USDC deposited to Hyperliquid margin',
          );

          // Notify controller of success
          this.onCompleted?.(funding.fundingBatchId, receivedAmount);
        } catch (err) {
          logger.error(
            { error: (err as Error).message, transferId: this.transferId },
            'Failed to deposit USDC to Hyperliquid margin',
          );
          // Bridge succeeded but deposit failed — notify as failed
          this.onFailed?.(funding.fundingBatchId);

          return {
            success: true,
            data: {
              transferId: this.transferId,
              txHash: this.txResult.txHash,
              status,
              substatus,
              bridge: this.quote?.tool ?? 'unknown',
              depositFailed: true,
            },
          };
        }
      }

      logger.info(
        {
          transferId: this.transferId,
          receivedAmount: receivedAmount.toString(),
          batchId: funding.fundingBatchId,
        },
        'Funding bridge completed successfully',
      );
    } else if (status === 'DONE' && substatus === 'PARTIAL') {
      // Partial fill — check if received token is USDC
      const receivedAmount = receiving?.amount ? BigInt(receiving.amount) : 0n;
      const receivedTokenAddr = receiving?.token?.address;

      this.store.completeTransfer(
        this.transferId,
        receivedAmount,
        (receivedTokenAddr ?? funding.toToken) as any,
        funding.toChain,
      );

      // If received non-USDC, skip Hyperliquid deposit
      if (receivedTokenAddr && receivedTokenAddr.toLowerCase() !== (funding.toToken as string).toLowerCase()) {
        logger.warn(
          {
            transferId: this.transferId,
            expectedToken: funding.toToken,
            receivedToken: receivedTokenAddr,
            receivedAmount: receivedAmount.toString(),
          },
          'Partial fill with non-USDC token, skipping Hyperliquid deposit',
        );
        // Queue follow-up swap (via metadata)
        this.onFailed?.(funding.fundingBatchId);
      } else if (receivedAmount > 0n && funding.depositToHyperliquid) {
        // Partial amount but correct token — deposit what we got
        try {
          const depositAmountStr = this.formatUsdcAmount(receivedAmount);
          await this.hyperliquidConnector.depositToMargin(depositAmountStr);
          this.onCompleted?.(funding.fundingBatchId, receivedAmount);
          logger.info(
            { transferId: this.transferId, depositedAmount: receivedAmount.toString() },
            'Partial USDC deposited to Hyperliquid',
          );
        } catch {
          this.onFailed?.(funding.fundingBatchId);
        }
      }
    } else if (status === 'DONE' && substatus === 'REFUNDED') {
      // Refunded — restore source chain balance
      this.store.completeTransfer(
        this.transferId,
        0n,
        funding.fromToken,
        funding.fromChain,
      );
      logger.info(
        { transferId: this.transferId, batchId: funding.fundingBatchId },
        'Funding bridge refunded to source chain',
      );
      this.onFailed?.(funding.fundingBatchId);
    } else {
      // FAILED
      this.store.updateTransferStatus(this.transferId, 'failed');
      logger.error(
        {
          transferId: this.transferId,
          status,
          substatus,
          bridge: this.quote?.tool,
          batchId: funding.fundingBatchId,
        },
        'Funding bridge failed',
      );
      this.onFailed?.(funding.fundingBatchId);
    }

    return {
      success: true,
      data: {
        transferId: this.transferId,
        txHash: this.txResult.txHash,
        status,
        substatus,
        bridge: this.quote?.tool ?? 'unknown',
        fundingBatchId: funding.fundingBatchId,
      },
    };
  }

  // --- Helpers ---

  /**
   * Format a bigint USDC amount (6 decimals) to a decimal string.
   * e.g., 1_500_000n → "1.5"
   */
  private formatUsdcAmount(amount: bigint): string {
    const whole = amount / 1_000_000n;
    const frac = amount % 1_000_000n;
    if (frac === 0n) return whole.toString();
    const fracStr = frac.toString().padStart(6, '0').replace(/0+$/, '');
    return `${whole}.${fracStr}`;
  }
}
