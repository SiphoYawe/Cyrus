// BridgeExecutor — stage pipeline for cross-chain bridge operations
// Key differences from SwapExecutor:
// - Manages DESTINATION chain balance updates (not source)
// - Bridge timeout is a warning, not an error
// - Longer max polling duration (60 min default)
// - SQLite persistence for crash recovery

import { BaseExecutor } from './base-executor.js';
import type { StageResult } from './base-executor.js';
import type { ExecutorAction, BridgeAction } from '../core/action-types.js';
import type { ExecutionResult, TransferId } from '../core/types.js';
import type { LiFiConnectorInterface, QuoteResult, QuoteParams, LiFiStatusResponse } from '../connectors/types.js';
import type { Store, CreateTransferParams } from '../core/store.js';
import type { ApprovalHandler } from './approval-handler.js';
import type { TransactionExecutor, TransactionResult } from './transaction-executor.js';
import type { PreFlightChecker, PreFlightConfig } from './pre-flight-checks.js';
import { DEFAULT_SLIPPAGE } from '../core/constants.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('bridge-executor');

const MAX_ATTEMPTS = 2;

export interface BridgeExecutorConfig {
  readonly maxGasCostUsd: number;
  readonly defaultSlippage: number;
  readonly bridgeTimeoutMs: number;     // default 30 min, warning threshold
  readonly maxPollingDurationMs: number; // default 60 min, hard limit
  readonly pollIntervalMs?: number;      // override for tests
}

const DEFAULT_BRIDGE_CONFIG: BridgeExecutorConfig = {
  maxGasCostUsd: 50,
  defaultSlippage: DEFAULT_SLIPPAGE,
  bridgeTimeoutMs: 30 * 60 * 1000,     // 30 min
  maxPollingDurationMs: 60 * 60 * 1000, // 60 min
};

export class BridgeExecutor extends BaseExecutor {
  private readonly connector: LiFiConnectorInterface;
  private readonly approvalHandler: ApprovalHandler;
  private readonly transactionExecutor: TransactionExecutor;
  private readonly preFlightChecker: PreFlightChecker;
  private readonly store: Store;
  private readonly config: BridgeExecutorConfig;

  // Stage state
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
    config?: Partial<BridgeExecutorConfig>,
  ) {
    super();
    this.connector = connector;
    this.approvalHandler = approvalHandler;
    this.transactionExecutor = transactionExecutor;
    this.preFlightChecker = preFlightChecker;
    this.store = store;
    this.config = { ...DEFAULT_BRIDGE_CONFIG, ...config };
  }

  canHandle(action: ExecutorAction): boolean {
    return action.type === 'bridge';
  }

  async execute(action: ExecutorAction): Promise<ExecutionResult> {
    this.quote = null;
    this.txResult = null;
    this.transferId = null;
    this.statusResponse = null;
    return super.execute(action);
  }

  // --- Trigger Stage ---
  protected async trigger(action: ExecutorAction): Promise<StageResult> {
    if (!this.canHandle(action)) {
      return { success: false, error: `BridgeExecutor cannot handle action type: ${action.type}` };
    }

    const bridge = action as BridgeAction;

    if (bridge.fromChain === bridge.toChain) {
      return { success: false, error: 'BridgeExecutor requires cross-chain transfer (fromChain !== toChain)' };
    }

    const available = this.store.getAvailableBalance(bridge.fromChain, bridge.fromToken);
    if (available < bridge.amount) {
      return {
        success: false,
        error: `Insufficient balance on chain ${bridge.fromChain}: need ${bridge.amount}, have ${available}`,
      };
    }

    logger.info(
      {
        actionId: action.id,
        fromChain: bridge.fromChain,
        toChain: bridge.toChain,
        amount: bridge.amount.toString(),
      },
      'Bridge trigger stage passed',
    );

    return { success: true };
  }

  // --- Open Stage ---
  protected async open(action: ExecutorAction): Promise<StageResult> {
    const bridge = action as BridgeAction;
    let attempts = 0;

    while (attempts < MAX_ATTEMPTS) {
      attempts++;
      try {
        const quoteParams: QuoteParams = {
          fromChain: bridge.fromChain,
          toChain: bridge.toChain,
          fromToken: bridge.fromToken,
          toToken: bridge.toToken,
          fromAmount: bridge.amount.toString(),
          slippage: this.config.defaultSlippage,
        };

        this.quote = await this.connector.getQuote(quoteParams);
        logger.info(
          { tool: this.quote.tool, toAmount: this.quote.estimate.toAmount },
          'Bridge quote received',
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

        // Approval
        const approvalTxHash = await this.approvalHandler.handleApproval(
          this.quote,
          bridge.fromToken,
        );
        if (approvalTxHash) {
          logger.info({ approvalTxHash }, 'Bridge token approval confirmed');
        }

        // Execute
        this.txResult = await this.transactionExecutor.execute(this.quote);

        // Create InFlightTransfer
        const bridgeTool = this.quote.tool || 'unknown';
        const transferParams: CreateTransferParams = {
          txHash: this.txResult.txHash,
          fromChain: bridge.fromChain,
          toChain: bridge.toChain,
          fromToken: bridge.fromToken,
          toToken: bridge.toToken,
          amount: bridge.amount,
          bridge: bridgeTool,
          quoteData: this.quote,
        };

        const transfer = this.store.createTransfer(transferParams);
        this.transferId = transfer.id;

        logger.info(
          { transferId: transfer.id, txHash: this.txResult.txHash, bridge: bridgeTool },
          'Bridge open stage complete',
        );

        return {
          success: true,
          data: {
            transferId: transfer.id,
            txHash: this.txResult.txHash,
            bridge: bridgeTool,
            tool: this.quote.tool,
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        const isRevert = message.toLowerCase().includes('execution reverted');

        if (isRevert && attempts < MAX_ATTEMPTS) {
          logger.warn({ attempt: attempts, error: message }, 'Bridge execution reverted, retrying');
          continue;
        }

        logger.error({ attempt: attempts, error: message }, 'Bridge open stage failed');
        return { success: false, error: message };
      }
    }

    return { success: false, error: 'Max retry attempts exceeded' };
  }

  // --- Manage Stage ---
  protected async manage(action: ExecutorAction): Promise<StageResult> {
    if (!this.txResult || !this.quote || !this.transferId) {
      return { success: false, error: 'No bridge transaction to manage' };
    }

    const bridge = action as BridgeAction;
    const startTime = Date.now();
    let pollIndex = 0;
    let timeoutWarned = false;

    const pollIntervals = [10_000, 10_000, 10_000, 10_000, 10_000, 10_000,
      30_000, 30_000, 30_000, 30_000, 30_000, 30_000,
      60_000, 60_000, 60_000, 60_000, 60_000, 60_000,
      60_000, 60_000, 60_000, 60_000, 60_000, 60_000];

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
          'Bridge timeout barrier exceeded, continuing to poll',
        );
        timeoutWarned = true;
      }

      try {
        this.statusResponse = await this.connector.getStatus(
          this.txResult.txHash,
          this.quote.tool,
          bridge.fromChain as number,
          bridge.toChain as number,
        );

        const status = this.statusResponse.status;

        if (status === 'NOT_FOUND' || status === 'PENDING') {
          logger.debug({ status, pollIndex }, 'Bridge transfer still in progress');
          continue;
        }

        if (status === 'DONE' || status === 'FAILED') {
          logger.info(
            { status, substatus: this.statusResponse.substatus, elapsedMs: elapsed },
            'Bridge reached terminal status',
          );
          return { success: true };
        }
      } catch (err) {
        logger.warn({ error: (err as Error).message, pollIndex }, 'Bridge status poll error');
      }
    }

    logger.warn({ transferId: this.transferId }, 'Bridge polling timed out');
    return { success: false, error: 'Bridge status polling timed out' };
  }

  // --- Close Stage ---
  protected async close(action: ExecutorAction): Promise<StageResult> {
    if (!this.statusResponse || !this.transferId || !this.txResult) {
      return { success: false, error: 'No status data to close bridge' };
    }

    const bridge = action as BridgeAction;
    const status = this.statusResponse.status;
    const substatus = this.statusResponse.substatus;
    const receiving = this.statusResponse.receiving;

    if (status === 'DONE' && substatus === 'COMPLETED') {
      const receivedAmount = receiving?.amount ? BigInt(receiving.amount) : 0n;
      const receivedToken = receiving?.token?.address ?? (bridge.toToken as string);
      this.store.completeTransfer(
        this.transferId,
        receivedAmount,
        receivedToken as any,
        bridge.toChain,
      );
      logger.info(
        { transferId: this.transferId, receivedAmount: receivedAmount.toString(), destChain: bridge.toChain },
        'Bridge completed successfully',
      );
    } else if (status === 'DONE' && substatus === 'PARTIAL') {
      const receivedAmount = receiving?.amount ? BigInt(receiving.amount) : 0n;
      this.store.completeTransfer(
        this.transferId,
        receivedAmount,
        (receiving?.token?.address ?? bridge.toToken) as any,
        bridge.toChain,
      );
      logger.warn(
        { transferId: this.transferId, receivedAmount: receivedAmount.toString() },
        'Bridge completed with partial fill',
      );
    } else if (status === 'DONE' && substatus === 'REFUNDED') {
      this.store.completeTransfer(
        this.transferId,
        0n,
        bridge.fromToken,
        bridge.fromChain,
      );
      logger.info({ transferId: this.transferId }, 'Bridge refunded to source chain');
    } else {
      // FAILED
      this.store.updateTransferStatus(this.transferId, 'failed');
      logger.error(
        { transferId: this.transferId, status, substatus, bridge: this.quote?.tool },
        'Bridge failed',
      );
    }

    return {
      success: true,
      data: {
        transferId: this.transferId,
        txHash: this.txResult.txHash,
        status,
        substatus,
        bridge: this.quote?.tool ?? 'unknown',
      },
    };
  }
}
