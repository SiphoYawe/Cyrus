// ComposerExecutor — orchestrates Composer DeFi operations (vault deposits, staking, lending)
// Follows the same pattern as SwapExecutor: quote -> pre-flight -> approval -> execute -> store
// Composer is auto-activated by LI.FI when toToken is a vault/staking/lending token address

import type { Executor } from './executor-orchestrator.js';
import type { ExecutorAction, ComposerAction } from '../core/action-types.js';
import type { ExecutionResult } from '../core/types.js';
import type { LiFiConnectorInterface, QuoteParams, QuoteResult } from '../connectors/types.js';
import type { Store, CreateTransferParams } from '../core/store.js';
import type { ApprovalHandler } from './approval-handler.js';
import type { TransactionExecutor } from './transaction-executor.js';
import type { PreFlightChecker, PreFlightConfig } from './pre-flight-checks.js';
import { DEFAULT_SLIPPAGE } from '../core/constants.js';
import { createLogger } from '../utils/logger.js';
import { isSupportedProtocol } from './composer-registry.js';

const logger = createLogger('composer-executor');

export interface ComposerExecutorConfig {
  readonly enabled: boolean;
  readonly supportedProtocols: readonly string[];
  readonly defaultSlippage: number;
  readonly maxGasCostUsd: number;
  readonly maxBridgeTimeout?: number;
}

export class ComposerExecutor implements Executor {
  private readonly connector: LiFiConnectorInterface;
  private readonly approvalHandler: ApprovalHandler;
  private readonly transactionExecutor: TransactionExecutor;
  private readonly preFlightChecker: PreFlightChecker;
  private readonly store: Store;
  private readonly config: ComposerExecutorConfig;

  constructor(
    connector: LiFiConnectorInterface,
    approvalHandler: ApprovalHandler,
    transactionExecutor: TransactionExecutor,
    preFlightChecker: PreFlightChecker,
    store: Store,
    config: ComposerExecutorConfig,
  ) {
    this.connector = connector;
    this.approvalHandler = approvalHandler;
    this.transactionExecutor = transactionExecutor;
    this.preFlightChecker = preFlightChecker;
    this.store = store;
    this.config = config;
  }

  canHandle(action: ExecutorAction): boolean {
    return action.type === 'composer';
  }

  async execute(action: ExecutorAction): Promise<ExecutionResult> {
    if (!this.canHandle(action)) {
      return {
        success: false,
        transferId: null,
        txHash: null,
        error: `ComposerExecutor cannot handle action type: ${action.type}`,
        metadata: { actionId: action.id, actionType: action.type },
      };
    }

    const composerAction = action as ComposerAction;

    logger.info(
      {
        actionId: composerAction.id,
        protocol: composerAction.protocol,
        fromChain: composerAction.fromChain,
        toChain: composerAction.toChain,
        fromToken: composerAction.fromToken,
        toToken: composerAction.toToken,
        amount: composerAction.amount.toString(),
      },
      'Starting Composer execution',
    );

    // 1. Check if Composer is enabled
    if (!this.config.enabled) {
      logger.warn(
        { actionId: composerAction.id },
        'Composer is disabled in configuration',
      );
      return {
        success: false,
        transferId: null,
        txHash: null,
        error: 'Composer is disabled in configuration',
        metadata: { actionId: composerAction.id, protocol: composerAction.protocol },
      };
    }

    // 2. Validate protocol is in supportedProtocols
    if (!this.config.supportedProtocols.includes(composerAction.protocol)) {
      logger.warn(
        {
          actionId: composerAction.id,
          protocol: composerAction.protocol,
          supportedProtocols: this.config.supportedProtocols,
        },
        'Unsupported protocol for Composer execution',
      );
      return {
        success: false,
        transferId: null,
        txHash: null,
        error: `Unsupported protocol: ${composerAction.protocol}. Supported: ${this.config.supportedProtocols.join(', ')}`,
        metadata: {
          actionId: composerAction.id,
          protocol: composerAction.protocol,
          supportedProtocols: [...this.config.supportedProtocols],
        },
      };
    }

    try {
      // 3. Get quote — toToken = vault token address triggers Composer auto-activation
      const slippage = this.config.defaultSlippage;

      const quoteParams: QuoteParams = {
        fromChain: composerAction.fromChain,
        toChain: composerAction.toChain,
        fromToken: composerAction.fromToken,
        toToken: composerAction.toToken,
        fromAmount: composerAction.amount.toString(),
        slippage,
      };

      logger.info(
        { quoteParams, protocol: composerAction.protocol },
        'Requesting Composer quote from LI.FI',
      );
      const quote = await this.connector.getQuote(quoteParams);
      logger.info(
        {
          tool: quote.tool,
          estimatedOutput: quote.estimate.toAmount,
          approvalAddress: quote.estimate.approvalAddress,
        },
        'Composer quote received',
      );

      // 4. Run pre-flight checks
      const preFlightConfig: PreFlightConfig = {
        maxGasCostUsd: this.config.maxGasCostUsd,
        defaultSlippage: slippage ?? DEFAULT_SLIPPAGE,
        maxBridgeTimeout: this.config.maxBridgeTimeout,
      };

      const preFlightResult = this.preFlightChecker.runAllChecks(quote, preFlightConfig);

      if (!preFlightResult.passed) {
        logger.warn(
          { actionId: composerAction.id, failures: preFlightResult.failures },
          'Pre-flight checks failed for Composer action, aborting',
        );
        return {
          success: false,
          transferId: null,
          txHash: null,
          error: `Pre-flight checks failed: ${preFlightResult.failures.join('; ')}`,
          metadata: {
            actionId: composerAction.id,
            protocol: composerAction.protocol,
            isComposer: true,
            failures: preFlightResult.failures,
          },
        };
      }

      // 5. Handle token approval
      logger.info(
        { actionId: composerAction.id, protocol: composerAction.protocol },
        'Handling token approval for Composer action',
      );
      const approvalTxHash = await this.approvalHandler.handleApproval(
        quote,
        composerAction.fromToken,
      );

      if (approvalTxHash) {
        logger.info(
          { approvalTxHash, actionId: composerAction.id },
          'Token approval confirmed for Composer action',
        );
      } else {
        logger.info({ actionId: composerAction.id }, 'No approval needed for Composer action');
      }

      // 6. Execute transaction
      logger.info(
        { actionId: composerAction.id, protocol: composerAction.protocol },
        'Executing Composer transaction',
      );
      const txResult = await this.transactionExecutor.execute(quote);

      // 7. Create InFlightTransfer in store with Composer metadata
      const bridge = quote.tool || 'composer';
      const transferParams: CreateTransferParams = {
        txHash: txResult.txHash,
        fromChain: composerAction.fromChain,
        toChain: composerAction.toChain,
        fromToken: composerAction.fromToken,
        toToken: composerAction.toToken,
        amount: composerAction.amount,
        bridge,
        quoteData: quote,
      };

      const transfer = this.store.createTransfer(transferParams);

      logger.info(
        {
          transferId: transfer.id,
          txHash: txResult.txHash,
          actionId: composerAction.id,
          protocol: composerAction.protocol,
          isComposer: true,
        },
        'Composer execution completed successfully',
      );

      return {
        success: true,
        transferId: transfer.id,
        txHash: txResult.txHash,
        error: null,
        metadata: {
          actionId: composerAction.id,
          protocol: composerAction.protocol,
          isComposer: true,
          bridge,
          tool: quote.tool,
          blockNumber: txResult.blockNumber.toString(),
          gasUsed: txResult.gasUsed.toString(),
          approvalTxHash: approvalTxHash ?? undefined,
        },
      };
    } catch (error) {
      return this.handleComposerFailure(composerAction, error instanceof Error ? error : new Error('Unknown error'));
    }
  }

  /**
   * Handle Composer execution failure — returns a failure result with fallback recommendations.
   */
  handleComposerFailure(action: ComposerAction, error: Error): ExecutionResult {
    const message = error.message || 'Unknown error during Composer execution';

    logger.error(
      {
        actionId: action.id,
        protocol: action.protocol,
        error: message,
        isComposer: true,
      },
      'Composer execution failed',
    );

    // Provide fallback steps recommendation
    const fallbackSteps = [
      `Try direct swap from ${action.fromToken} on chain ${action.fromChain}`,
      `Verify vault token ${action.toToken} is still active on chain ${action.toChain}`,
      `Check if protocol ${action.protocol} is operational`,
      'Retry with higher slippage if price impact was the issue',
    ];

    return {
      success: false,
      transferId: null,
      txHash: null,
      error: message,
      metadata: {
        actionId: action.id,
        protocol: action.protocol,
        isComposer: true,
        errorType: error.constructor.name,
        fallbackSteps,
      },
    };
  }
}
