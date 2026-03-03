// ComposerExecutor — stage pipeline for Composer DeFi operations (vault deposits, staking, lending)
// Key differences from BridgeExecutor:
// - Validates protocol is in supported list (trigger stage)
// - toToken = vault/protocol token address auto-activates Composer in LI.FI
// - Longer max polling duration (90 min default) for multi-step Composer operations
// - Close stage updates destination chain balance on COMPLETED

import { BaseExecutor } from './base-executor.js';
import type { StageResult } from './base-executor.js';
import type { ExecutorAction, ComposerAction } from '../core/action-types.js';
import type { ExecutionResult, TransferId } from '../core/types.js';
import type { LiFiConnectorInterface, QuoteResult, QuoteParams, LiFiStatusResponse } from '../connectors/types.js';
import type { Store, CreateTransferParams } from '../core/store.js';
import type { ApprovalHandler } from './approval-handler.js';
import type { TransactionExecutor, TransactionResult } from './transaction-executor.js';
import type { PreFlightChecker, PreFlightConfig } from './pre-flight-checks.js';
import { DEFAULT_SLIPPAGE } from '../core/constants.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('composer-executor');

const MAX_ATTEMPTS = 2;

export const SUPPORTED_COMPOSER_PROTOCOLS = [
  'aave-v3',
  'morpho',
  'euler',
  'pendle',
  'lido',
  'etherfi',
  'ethena',
] as const;

export interface ComposerExecutorConfig {
  readonly maxGasCostUsd: number;
  readonly defaultSlippage: number;
  readonly maxPollingDurationMs: number; // default 90 min, hard limit
  readonly pollIntervalMs?: number;      // override for tests
}

const DEFAULT_COMPOSER_CONFIG: ComposerExecutorConfig = {
  maxGasCostUsd: 50,
  defaultSlippage: DEFAULT_SLIPPAGE,
  maxPollingDurationMs: 90 * 60 * 1000, // 90 min — Composer multi-step ops take longer
};

export class ComposerExecutor extends BaseExecutor {
  private readonly connector: LiFiConnectorInterface;
  private readonly approvalHandler: ApprovalHandler;
  private readonly transactionExecutor: TransactionExecutor;
  private readonly preFlightChecker: PreFlightChecker;
  private readonly store: Store;
  private readonly config: ComposerExecutorConfig;

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
    config?: Partial<ComposerExecutorConfig>,
  ) {
    super();
    this.connector = connector;
    this.approvalHandler = approvalHandler;
    this.transactionExecutor = transactionExecutor;
    this.preFlightChecker = preFlightChecker;
    this.store = store;
    this.config = { ...DEFAULT_COMPOSER_CONFIG, ...config };
  }

  canHandle(action: ExecutorAction): boolean {
    return action.type === 'composer';
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
      return { success: false, error: `ComposerExecutor cannot handle action type: ${action.type}` };
    }

    const composer = action as ComposerAction;

    // Validate protocol is supported
    const supportedList: readonly string[] = SUPPORTED_COMPOSER_PROTOCOLS;
    if (!supportedList.includes(composer.protocol)) {
      return {
        success: false,
        error: `Unsupported protocol: ${composer.protocol}. Supported: ${SUPPORTED_COMPOSER_PROTOCOLS.join(', ')}`,
      };
    }

    // Validate balance
    const available = this.store.getAvailableBalance(composer.fromChain, composer.fromToken);
    if (available < composer.amount) {
      return {
        success: false,
        error: `Insufficient balance on chain ${composer.fromChain}: need ${composer.amount}, have ${available}`,
      };
    }

    logger.info(
      {
        actionId: action.id,
        protocol: composer.protocol,
        fromChain: composer.fromChain,
        toChain: composer.toChain,
        amount: composer.amount.toString(),
      },
      'Composer trigger stage passed',
    );

    return { success: true };
  }

  // --- Open Stage ---
  protected async open(action: ExecutorAction): Promise<StageResult> {
    const composer = action as ComposerAction;
    let attempts = 0;

    while (attempts < MAX_ATTEMPTS) {
      attempts++;
      try {
        // 1. Get quote — toToken = vault/protocol token auto-activates Composer
        const quoteParams: QuoteParams = {
          fromChain: composer.fromChain,
          toChain: composer.toChain,
          fromToken: composer.fromToken,
          toToken: composer.toToken,
          fromAmount: composer.amount.toString(),
          slippage: this.config.defaultSlippage,
        };

        this.quote = await this.connector.getQuote(quoteParams);
        logger.info(
          { tool: this.quote.tool, toAmount: this.quote.estimate.toAmount, protocol: composer.protocol },
          'Composer quote received',
        );

        // 2. Pre-flight checks
        const preFlightConfig: PreFlightConfig = {
          maxGasCostUsd: this.config.maxGasCostUsd,
          defaultSlippage: this.config.defaultSlippage,
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
          composer.fromToken,
        );
        if (approvalTxHash) {
          logger.info({ approvalTxHash }, 'Composer token approval confirmed');
        }

        // 4. Execute transaction
        this.txResult = await this.transactionExecutor.execute(this.quote);

        // 5. Create InFlightTransfer
        const bridge = this.quote.tool || 'composer';
        const transferParams: CreateTransferParams = {
          txHash: this.txResult.txHash,
          fromChain: composer.fromChain,
          toChain: composer.toChain,
          fromToken: composer.fromToken,
          toToken: composer.toToken,
          amount: composer.amount,
          bridge,
          quoteData: this.quote,
        };

        const transfer = this.store.createTransfer(transferParams);
        this.transferId = transfer.id;

        logger.info(
          { transferId: transfer.id, txHash: this.txResult.txHash, protocol: composer.protocol, bridge },
          'Composer open stage complete',
        );

        return {
          success: true,
          data: {
            transferId: transfer.id,
            txHash: this.txResult.txHash,
            bridge,
            tool: this.quote.tool,
            protocol: composer.protocol,
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        const isRevert = message.toLowerCase().includes('execution reverted');

        if (isRevert && attempts < MAX_ATTEMPTS) {
          logger.warn({ attempt: attempts, error: message }, 'Composer execution reverted, retrying');
          continue;
        }

        logger.error({ attempt: attempts, error: message }, 'Composer open stage failed');
        return { success: false, error: message };
      }
    }

    return { success: false, error: 'Max retry attempts exceeded' };
  }

  // --- Manage Stage ---
  protected async manage(action: ExecutorAction): Promise<StageResult> {
    if (!this.txResult || !this.quote || !this.transferId) {
      return { success: false, error: 'No Composer transaction to manage' };
    }

    const composer = action as ComposerAction;
    const startTime = Date.now();
    let pollIndex = 0;

    // Longer backoff intervals for Composer multi-step operations
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

      try {
        this.statusResponse = await this.connector.getStatus(
          this.txResult.txHash,
          this.quote.tool,
          composer.fromChain as number,
          composer.toChain as number,
        );

        const status = this.statusResponse.status;

        if (status === 'NOT_FOUND' || status === 'PENDING') {
          logger.debug({ status, pollIndex, protocol: composer.protocol }, 'Composer transfer still in progress');
          continue;
        }

        if (status === 'DONE' || status === 'FAILED') {
          logger.info(
            { status, substatus: this.statusResponse.substatus, protocol: composer.protocol },
            'Composer reached terminal status',
          );
          return { success: true };
        }
      } catch (err) {
        logger.warn({ error: (err as Error).message, pollIndex }, 'Composer status poll error');
      }
    }

    logger.warn({ transferId: this.transferId, protocol: composer.protocol }, 'Composer polling timed out');
    return { success: false, error: 'Composer status polling timed out' };
  }

  // --- Close Stage ---
  protected async close(action: ExecutorAction): Promise<StageResult> {
    if (!this.statusResponse || !this.transferId || !this.txResult) {
      return { success: false, error: 'No status data to close Composer operation' };
    }

    const composer = action as ComposerAction;
    const status = this.statusResponse.status;
    const substatus = this.statusResponse.substatus;
    const receiving = this.statusResponse.receiving;

    if (status === 'DONE' && substatus === 'COMPLETED') {
      const receivedAmount = receiving?.amount ? BigInt(receiving.amount) : 0n;
      const receivedToken = receiving?.token?.address ?? (composer.toToken as string);
      this.store.completeTransfer(
        this.transferId,
        receivedAmount,
        receivedToken as any,
        composer.toChain,
      );
      logger.info(
        { transferId: this.transferId, receivedAmount: receivedAmount.toString(), protocol: composer.protocol },
        'Composer completed successfully',
      );
    } else if (status === 'DONE' && substatus === 'PARTIAL') {
      const receivedAmount = receiving?.amount ? BigInt(receiving.amount) : 0n;
      this.store.completeTransfer(
        this.transferId,
        receivedAmount,
        (receiving?.token?.address ?? composer.toToken) as any,
        composer.toChain,
      );
      logger.warn(
        { transferId: this.transferId, receivedAmount: receivedAmount.toString(), protocol: composer.protocol },
        'Composer completed with partial fill',
      );
    } else if (status === 'DONE' && substatus === 'REFUNDED') {
      this.store.completeTransfer(
        this.transferId,
        0n,
        composer.fromToken,
        composer.fromChain,
      );
      logger.info({ transferId: this.transferId, protocol: composer.protocol }, 'Composer refunded to source chain');
    } else {
      // FAILED
      this.store.updateTransferStatus(this.transferId, 'failed');
      logger.error(
        { transferId: this.transferId, status, substatus, protocol: composer.protocol, tool: this.quote?.tool },
        'Composer failed',
      );
    }

    return {
      success: true,
      data: {
        transferId: this.transferId,
        txHash: this.txResult.txHash,
        status,
        substatus,
        protocol: composer.protocol,
        bridge: this.quote?.tool ?? 'composer',
      },
    };
  }
}
