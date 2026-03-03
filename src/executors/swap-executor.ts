// SwapExecutor — stage pipeline: Trigger → Open → Manage → Close
// Handles 'swap' and 'bridge' action types via LI.FI

import { BaseExecutor, EXECUTOR_STAGES } from './base-executor.js';
import type { StageResult } from './base-executor.js';
import type { ExecutorAction, SwapAction, BridgeAction } from '../core/action-types.js';
import type { ExecutionResult, TransferId } from '../core/types.js';
import type { LiFiConnectorInterface, QuoteResult, QuoteParams, LiFiStatusResponse } from '../connectors/types.js';
import type { Store, CreateTransferParams } from '../core/store.js';
import type { ApprovalHandler } from './approval-handler.js';
import type { TransactionExecutor, TransactionResult } from './transaction-executor.js';
import type { PreFlightChecker, PreFlightConfig } from './pre-flight-checks.js';
import { DEFAULT_SLIPPAGE } from '../core/constants.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('swap-executor');

const MAX_ATTEMPTS = 2;
const MAX_POLL_DURATION_MS = 30 * 60 * 1000; // 30 minutes
const POLL_INTERVALS = [10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 30_000, 30_000, 30_000, 30_000, 30_000, 30_000, 60_000]; // then 120s

export interface SwapExecutorConfig {
  readonly maxGasCostUsd: number;
  readonly defaultSlippage: number;
  readonly maxBridgeTimeout?: number;
  readonly pollIntervalMs?: number; // override for tests
}

export class SwapExecutor extends BaseExecutor {
  private readonly connector: LiFiConnectorInterface;
  private readonly approvalHandler: ApprovalHandler;
  private readonly transactionExecutor: TransactionExecutor;
  private readonly preFlightChecker: PreFlightChecker;
  private readonly store: Store;
  private readonly config: SwapExecutorConfig;

  // Stage state (reset per execution)
  private quote: QuoteResult | null = null;
  private txResult: TransactionResult | null = null;
  private transferId: TransferId | null = null;
  private statusResponse: LiFiStatusResponse | null = null;

  constructor(
    connector: LiFiConnectorInterface,
    approvalHandler: ApprovalHandler,
    transactionExecutor: TransactionExecutor,
    preFlightChecker: PreFlightChecker,
    store: Store,
    config: SwapExecutorConfig,
  ) {
    super();
    this.connector = connector;
    this.approvalHandler = approvalHandler;
    this.transactionExecutor = transactionExecutor;
    this.preFlightChecker = preFlightChecker;
    this.store = store;
    this.config = config;
  }

  canHandle(action: ExecutorAction): boolean {
    return action.type === 'swap' || action.type === 'bridge';
  }

  // Override execute to reset per-execution state
  async execute(action: ExecutorAction): Promise<ExecutionResult> {
    this.quote = null;
    this.txResult = null;
    this.transferId = null;
    this.statusResponse = null;
    return super.execute(action);
  }

  // --- Trigger Stage: validate preconditions ---
  protected async trigger(action: ExecutorAction): Promise<StageResult> {
    if (!this.canHandle(action)) {
      return { success: false, error: `SwapExecutor cannot handle action type: ${action.type}` };
    }

    const swapOrBridge = action as SwapAction | BridgeAction;

    // Check available balance
    const available = this.store.getAvailableBalance(swapOrBridge.fromChain, swapOrBridge.fromToken);
    if (available < swapOrBridge.amount) {
      return {
        success: false,
        error: `Insufficient balance on chain ${swapOrBridge.fromChain}: need ${swapOrBridge.amount}, have ${available}`,
      };
    }

    logger.info(
      {
        actionId: action.id,
        type: action.type,
        fromChain: swapOrBridge.fromChain,
        toChain: swapOrBridge.toChain,
        amount: swapOrBridge.amount.toString(),
      },
      'Trigger stage passed',
    );

    return { success: true };
  }

  // --- Open Stage: quote → approve → submit tx ---
  protected async open(action: ExecutorAction): Promise<StageResult> {
    const swapOrBridge = action as SwapAction | BridgeAction;
    let attempts = 0;

    while (attempts < MAX_ATTEMPTS) {
      attempts++;
      try {
        // 1. Get quote
        const slippage =
          swapOrBridge.type === 'swap'
            ? (swapOrBridge as SwapAction).slippage
            : this.config.defaultSlippage;

        const quoteParams: QuoteParams = {
          fromChain: swapOrBridge.fromChain,
          toChain: swapOrBridge.toChain,
          fromToken: swapOrBridge.fromToken,
          toToken: swapOrBridge.toToken,
          fromAmount: swapOrBridge.amount.toString(),
          slippage,
        };

        this.quote = await this.connector.getQuote(quoteParams);
        logger.info(
          { tool: this.quote.tool, toAmount: this.quote.estimate.toAmount },
          'Quote received',
        );

        // 2. Pre-flight checks
        const preFlightConfig: PreFlightConfig = {
          maxGasCostUsd: this.config.maxGasCostUsd,
          defaultSlippage: slippage ?? DEFAULT_SLIPPAGE,
          maxBridgeTimeout: this.config.maxBridgeTimeout,
        };

        const preFlightResult = this.preFlightChecker.runAllChecks(this.quote, preFlightConfig);
        if (!preFlightResult.passed) {
          return {
            success: false,
            error: `Pre-flight checks failed: ${preFlightResult.failures.join('; ')}`,
          };
        }

        // 3. Handle approval
        const approvalTxHash = await this.approvalHandler.handleApproval(
          this.quote,
          swapOrBridge.fromToken,
        );
        if (approvalTxHash) {
          logger.info({ approvalTxHash }, 'Token approval confirmed');
        }

        // 4. Execute transaction
        this.txResult = await this.transactionExecutor.execute(this.quote);

        // 5. Create InFlightTransfer
        const bridge = this.quote.tool || 'unknown';
        const transferParams: CreateTransferParams = {
          txHash: this.txResult.txHash,
          fromChain: swapOrBridge.fromChain,
          toChain: swapOrBridge.toChain,
          fromToken: swapOrBridge.fromToken,
          toToken: swapOrBridge.toToken,
          amount: swapOrBridge.amount,
          bridge,
          quoteData: this.quote,
        };

        const transfer = this.store.createTransfer(transferParams);
        this.transferId = transfer.id;

        logger.info(
          { transferId: transfer.id, txHash: this.txResult.txHash },
          'Open stage complete',
        );

        return {
          success: true,
          data: {
            transferId: transfer.id,
            txHash: this.txResult.txHash,
            bridge,
            tool: this.quote.tool,
            blockNumber: this.txResult.blockNumber.toString(),
            gasUsed: this.txResult.gasUsed.toString(),
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        const isRevert = message.toLowerCase().includes('execution reverted');

        if (isRevert && attempts < MAX_ATTEMPTS) {
          logger.warn(
            { attempt: attempts, error: message },
            'Execution reverted, retrying with fresh quote',
          );
          continue;
        }

        logger.error(
          { attempt: attempts, error: message, isRevert },
          'Open stage failed',
        );
        return {
          success: false,
          error: message,
          data: { errorType: err instanceof Error ? err.constructor.name : 'Unknown' },
        };
      }
    }

    return { success: false, error: 'Max retry attempts exceeded' };
  }

  // --- Manage Stage: poll status ---
  protected async manage(action: ExecutorAction): Promise<StageResult> {
    if (!this.txResult || !this.quote || !this.transferId) {
      return { success: false, error: 'No transaction to manage' };
    }

    const swapOrBridge = action as SwapAction | BridgeAction;
    const startTime = Date.now();
    let pollIndex = 0;

    while (Date.now() - startTime < MAX_POLL_DURATION_MS) {
      const interval = this.config.pollIntervalMs ?? (
        pollIndex < POLL_INTERVALS.length ? POLL_INTERVALS[pollIndex] : 120_000
      );

      await new Promise((resolve) => setTimeout(resolve, interval));
      pollIndex++;

      try {
        this.statusResponse = await this.connector.getStatus(
          this.txResult.txHash,
          this.quote.tool,
          swapOrBridge.fromChain as number,
          swapOrBridge.toChain as number,
        );

        const status = this.statusResponse.status;

        if (status === 'NOT_FOUND' || status === 'PENDING') {
          logger.debug({ status, pollIndex }, 'Transfer still in progress');
          continue;
        }

        if (status === 'DONE' || status === 'FAILED') {
          logger.info({ status, substatus: this.statusResponse.substatus }, 'Transfer reached terminal status');
          return { success: true };
        }
      } catch (err) {
        logger.warn(
          { error: (err as Error).message, pollIndex },
          'Status poll error, continuing',
        );
      }
    }

    // Timed out
    logger.warn({ transferId: this.transferId }, 'Status polling timed out after 30 minutes');
    return { success: false, error: 'Status polling timed out' };
  }

  // --- Close Stage: update balances, record trade ---
  protected async close(action: ExecutorAction): Promise<StageResult> {
    if (!this.statusResponse || !this.transferId || !this.txResult) {
      return { success: false, error: 'No status data to close' };
    }

    const swapOrBridge = action as SwapAction | BridgeAction;
    const status = this.statusResponse.status;
    const substatus = this.statusResponse.substatus;
    const receiving = this.statusResponse.receiving;

    if (status === 'DONE' && substatus === 'COMPLETED') {
      const receivedAmount = receiving?.amount ? BigInt(receiving.amount) : 0n;
      const receivedToken = receiving?.token?.address ?? (swapOrBridge.toToken as string);
      this.store.completeTransfer(
        this.transferId,
        receivedAmount,
        receivedToken as any,
        swapOrBridge.toChain,
      );
      logger.info({ transferId: this.transferId, receivedAmount: receivedAmount.toString() }, 'Swap completed');
    } else if (status === 'DONE' && substatus === 'PARTIAL') {
      const receivedAmount = receiving?.amount ? BigInt(receiving.amount) : 0n;
      this.store.completeTransfer(
        this.transferId,
        receivedAmount,
        (receiving?.token?.address ?? swapOrBridge.toToken) as any,
        swapOrBridge.toChain,
      );
      logger.warn({ transferId: this.transferId }, 'Swap completed with partial fill');
    } else if (status === 'DONE' && substatus === 'REFUNDED') {
      this.store.completeTransfer(
        this.transferId,
        0n,
        swapOrBridge.fromToken,
        swapOrBridge.fromChain,
      );
      logger.info({ transferId: this.transferId }, 'Swap refunded');
    } else {
      // FAILED
      this.store.updateTransferStatus(this.transferId, 'failed');
      logger.error({ transferId: this.transferId, status, substatus }, 'Swap failed');
    }

    return {
      success: true,
      data: {
        transferId: this.transferId,
        txHash: this.txResult.txHash,
        status,
        substatus,
        tool: this.quote?.tool,
        bridge: this.quote?.tool ?? 'unknown',
        blockNumber: this.txResult.blockNumber.toString(),
        gasUsed: this.txResult.gasUsed.toString(),
      },
    };
  }
}
