// SwapExecutor — orchestrates quote → pre-flight → approval → execution → store update
// Handles both 'swap' and 'bridge' action types

import type { Executor } from './executor-orchestrator.js';
import type { ExecutorAction, SwapAction, BridgeAction } from '../core/action-types.js';
import type { ExecutionResult } from '../core/types.js';
import type { LiFiConnectorInterface, QuoteResult, QuoteParams } from '../connectors/types.js';
import type { Store, CreateTransferParams } from '../core/store.js';
import type { ApprovalHandler } from './approval-handler.js';
import type { TransactionExecutor } from './transaction-executor.js';
import type { PreFlightChecker, PreFlightConfig } from './pre-flight-checks.js';
import { transferId, chainId } from '../core/types.js';
import type { ChainId, TokenAddress } from '../core/types.js';
import { DEFAULT_SLIPPAGE } from '../core/constants.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('swap-executor');

export interface SwapExecutorConfig {
  readonly maxGasCostUsd: number;
  readonly defaultSlippage: number;
  readonly maxBridgeTimeout?: number;
}

export class SwapExecutor implements Executor {
  private readonly connector: LiFiConnectorInterface;
  private readonly approvalHandler: ApprovalHandler;
  private readonly transactionExecutor: TransactionExecutor;
  private readonly preFlightChecker: PreFlightChecker;
  private readonly store: Store;
  private readonly config: SwapExecutorConfig;

  constructor(
    connector: LiFiConnectorInterface,
    approvalHandler: ApprovalHandler,
    transactionExecutor: TransactionExecutor,
    preFlightChecker: PreFlightChecker,
    store: Store,
    config: SwapExecutorConfig,
  ) {
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

  async execute(action: ExecutorAction): Promise<ExecutionResult> {
    if (!this.canHandle(action)) {
      return {
        success: false,
        transferId: null,
        txHash: null,
        error: `SwapExecutor cannot handle action type: ${action.type}`,
        metadata: { actionId: action.id, actionType: action.type },
      };
    }

    const swapOrBridge = action as SwapAction | BridgeAction;

    logger.info(
      {
        actionId: swapOrBridge.id,
        type: swapOrBridge.type,
        fromChain: swapOrBridge.fromChain,
        toChain: swapOrBridge.toChain,
        fromToken: swapOrBridge.fromToken,
        toToken: swapOrBridge.toToken,
        amount: swapOrBridge.amount.toString(),
      },
      'Starting swap/bridge execution',
    );

    try {
      // 1. Get quote from connector
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

      logger.info({ quoteParams }, 'Requesting quote from LI.FI');
      const quote = await this.connector.getQuote(quoteParams);
      logger.info(
        {
          tool: quote.tool,
          estimatedOutput: quote.estimate.toAmount,
          approvalAddress: quote.estimate.approvalAddress,
        },
        'Quote received',
      );

      // 2. Run pre-flight checks
      const preFlightConfig: PreFlightConfig = {
        maxGasCostUsd: this.config.maxGasCostUsd,
        defaultSlippage: slippage ?? DEFAULT_SLIPPAGE,
        maxBridgeTimeout: this.config.maxBridgeTimeout,
      };

      const preFlightResult = this.preFlightChecker.runAllChecks(quote, preFlightConfig);

      if (!preFlightResult.passed) {
        logger.warn(
          { actionId: swapOrBridge.id, failures: preFlightResult.failures },
          'Pre-flight checks failed, aborting execution',
        );
        return {
          success: false,
          transferId: null,
          txHash: null,
          error: `Pre-flight checks failed: ${preFlightResult.failures.join('; ')}`,
          metadata: {
            actionId: swapOrBridge.id,
            failures: preFlightResult.failures,
          },
        };
      }

      // 3. Handle token approval
      logger.info({ actionId: swapOrBridge.id }, 'Handling token approval');
      const approvalTxHash = await this.approvalHandler.handleApproval(
        quote,
        swapOrBridge.fromToken,
      );

      if (approvalTxHash) {
        logger.info(
          { approvalTxHash, actionId: swapOrBridge.id },
          'Token approval confirmed',
        );
      } else {
        logger.info({ actionId: swapOrBridge.id }, 'No approval needed');
      }

      // 4. Execute transaction
      logger.info({ actionId: swapOrBridge.id }, 'Executing main transaction');
      const txResult = await this.transactionExecutor.execute(quote);

      // 5. Create InFlightTransfer in store
      const bridge = quote.tool || 'unknown';
      const transferParams: CreateTransferParams = {
        txHash: txResult.txHash,
        fromChain: swapOrBridge.fromChain,
        toChain: swapOrBridge.toChain,
        fromToken: swapOrBridge.fromToken,
        toToken: swapOrBridge.toToken,
        amount: swapOrBridge.amount,
        bridge,
        quoteData: quote,
      };

      const transfer = this.store.createTransfer(transferParams);

      logger.info(
        {
          transferId: transfer.id,
          txHash: txResult.txHash,
          actionId: swapOrBridge.id,
        },
        'Swap/bridge execution completed successfully',
      );

      return {
        success: true,
        transferId: transfer.id,
        txHash: txResult.txHash,
        error: null,
        metadata: {
          actionId: swapOrBridge.id,
          bridge,
          tool: quote.tool,
          blockNumber: txResult.blockNumber.toString(),
          gasUsed: txResult.gasUsed.toString(),
          approvalTxHash: approvalTxHash ?? undefined,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error during swap execution';

      logger.error(
        { actionId: swapOrBridge.id, error: message },
        'Swap/bridge execution failed',
      );

      return {
        success: false,
        transferId: null,
        txHash: null,
        error: message,
        metadata: {
          actionId: swapOrBridge.id,
          errorType: error instanceof Error ? error.constructor.name : 'Unknown',
        },
      };
    }
  }
}
