import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ComposerExecutor } from './composer-executor.js';
import type { ComposerExecutorConfig } from './composer-executor.js';
import type { ApprovalHandler } from './approval-handler.js';
import type { TransactionExecutor, TransactionResult } from './transaction-executor.js';
import type { PreFlightChecker, PreFlightResult } from './pre-flight-checks.js';
import type { LiFiConnectorInterface, QuoteResult } from '../connectors/types.js';
import { Store } from '../core/store.js';
import type { ComposerAction, ExecutorAction } from '../core/action-types.js';
import { chainId, tokenAddress } from '../core/types.js';
import { EXECUTOR_STAGES } from './base-executor.js';

// --- Mock factories ---

function createMockQuote(): QuoteResult {
  return {
    transactionRequest: {
      to: '0xdeadbeef00000000000000000000000000000001',
      data: '0x1234',
      value: '0',
      gasLimit: '300000',
      chainId: 8453,
    },
    estimate: {
      approvalAddress: '0xspender0000000000000000000000000000000001',
      toAmount: '980000',
      toAmountMin: '975000',
      executionDuration: 15,
      gasCosts: [{ amount: '500000000000000', amountUSD: '1.50', token: { symbol: 'ETH' } }],
    },
    tool: 'lifi-composer',
    toolDetails: { key: 'lifi-composer', name: 'LI.FI Composer', logoURI: '' },
    action: {
      fromChainId: 8453,
      toChainId: 8453,
      fromToken: { address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' },
      toToken: { address: '0x7bfa7c4f149e7415b73bdedfe609237e29cbf34a' },
      fromAmount: '1000000',
    },
  };
}

function createMockTxResult(overrides: Partial<TransactionResult> = {}): TransactionResult {
  return {
    txHash: '0xtxhash000000000000000000000000000000000000000000000000000000cd',
    chainId: 8453,
    blockNumber: 25000000n,
    gasUsed: 250000n,
    status: 'success',
    ...overrides,
  };
}

function createMockConnector(
  overrides: Partial<LiFiConnectorInterface> = {},
): LiFiConnectorInterface {
  return {
    getQuote: vi.fn().mockResolvedValue(createMockQuote()),
    getRoutes: vi.fn().mockResolvedValue([]),
    getChains: vi.fn().mockResolvedValue([]),
    getTokens: vi.fn().mockResolvedValue([]),
    getStatus: vi.fn().mockResolvedValue({
      status: 'DONE',
      substatus: 'COMPLETED',
      receiving: { amount: '980000', token: { address: '0x7bfa7c4f149e7415b73bdedfe609237e29cbf34a' } },
    }),
    getConnections: vi.fn().mockResolvedValue([]),
    getTools: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function createMockApprovalHandler(
  overrides: { handleApproval?: ReturnType<typeof vi.fn> } = {},
): ApprovalHandler {
  return {
    handleApproval: overrides.handleApproval ?? vi.fn().mockResolvedValue(null),
  } as unknown as ApprovalHandler;
}

function createMockTransactionExecutor(
  overrides: { execute?: ReturnType<typeof vi.fn> } = {},
): TransactionExecutor {
  return {
    execute: overrides.execute ?? vi.fn().mockResolvedValue(createMockTxResult()),
  } as unknown as TransactionExecutor;
}

function createMockPreFlightChecker(
  overrides: { runAllChecks?: ReturnType<typeof vi.fn> } = {},
): PreFlightChecker {
  const passResult: PreFlightResult = { passed: true, failures: [] };
  return {
    checkGasCeiling: vi.fn().mockReturnValue(true),
    checkSlippage: vi.fn().mockReturnValue(true),
    checkBridgeTimeout: vi.fn().mockReturnValue(true),
    runAllChecks: overrides.runAllChecks ?? vi.fn().mockReturnValue(passResult),
  } as unknown as PreFlightChecker;
}

const FROM_CHAIN = chainId(8453);
const TO_CHAIN = chainId(8453);
const FROM_TOKEN = tokenAddress('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'); // USDC on Base
const TO_TOKEN = tokenAddress('0x7bfa7c4f149e7415b73bdedfe609237e29cbf34a');   // Morpho vault on Base

function makeComposerAction(overrides: Partial<ComposerAction> = {}): ComposerAction {
  return {
    id: 'composer-1',
    type: 'composer',
    priority: 5,
    createdAt: Date.now(),
    strategyId: 'yield-strategy',
    fromChain: FROM_CHAIN,
    toChain: TO_CHAIN,
    fromToken: FROM_TOKEN,
    toToken: TO_TOKEN,
    amount: 1_000_000n,
    protocol: 'morpho',
    metadata: {},
    ...overrides,
  };
}

const defaultConfig: Partial<ComposerExecutorConfig> = {
  pollIntervalMs: 0, // instant polling for tests
};

function setupBalance(store: Store, amount: bigint = 10_000_000n): void {
  store.setBalance(FROM_CHAIN, FROM_TOKEN, amount, 10.0, 'USDC', 6);
}

describe('ComposerExecutor', () => {
  let store: Store;

  beforeEach(() => {
    Store.getInstance().reset();
    store = Store.getInstance();
  });

  // --- canHandle ---

  describe('canHandle', () => {
    it('returns true for composer action', () => {
      const executor = new ComposerExecutor(
        createMockConnector(), createMockApprovalHandler(),
        createMockTransactionExecutor(), createMockPreFlightChecker(),
        store, defaultConfig,
      );
      expect(executor.canHandle(makeComposerAction())).toBe(true);
    });

    it('returns false for swap action', () => {
      const executor = new ComposerExecutor(
        createMockConnector(), createMockApprovalHandler(),
        createMockTransactionExecutor(), createMockPreFlightChecker(),
        store, defaultConfig,
      );

      const swapAction = {
        id: 'swap-1',
        type: 'swap' as const,
        priority: 1,
        createdAt: Date.now(),
        strategyId: 'test',
        fromChain: chainId(1),
        toChain: chainId(1),
        fromToken: tokenAddress('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'),
        toToken: tokenAddress('0xdac17f958d2ee523a2206206994597c13d831ec7'),
        amount: 100n,
        slippage: 0.005,
        metadata: {},
      } as ExecutorAction;

      expect(executor.canHandle(swapAction)).toBe(false);
    });

    it('returns false for bridge action', () => {
      const executor = new ComposerExecutor(
        createMockConnector(), createMockApprovalHandler(),
        createMockTransactionExecutor(), createMockPreFlightChecker(),
        store, defaultConfig,
      );

      const bridgeAction = {
        id: 'bridge-1',
        type: 'bridge' as const,
        priority: 1,
        createdAt: Date.now(),
        strategyId: 'test',
        fromChain: chainId(1),
        toChain: chainId(42161),
        fromToken: tokenAddress('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'),
        toToken: tokenAddress('0xaf88d065e77c8cc2239327c5edb3a432268e5831'),
        amount: 100n,
        metadata: {},
      } as ExecutorAction;

      expect(executor.canHandle(bridgeAction)).toBe(false);
    });
  });

  // --- Trigger stage ---

  describe('trigger stage', () => {
    it('rejects unsupported protocol', async () => {
      setupBalance(store);
      const executor = new ComposerExecutor(
        createMockConnector(), createMockApprovalHandler(),
        createMockTransactionExecutor(), createMockPreFlightChecker(),
        store, defaultConfig,
      );

      const action = makeComposerAction({ protocol: 'unknown-protocol' });
      const result = await executor.execute(action);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Unsupported protocol');
      expect(result.error).toContain('unknown-protocol');
    });

    it('rejects when insufficient balance', async () => {
      // No balance set up — store has 0
      const executor = new ComposerExecutor(
        createMockConnector(), createMockApprovalHandler(),
        createMockTransactionExecutor(), createMockPreFlightChecker(),
        store, defaultConfig,
      );

      const result = await executor.execute(makeComposerAction());
      expect(result.success).toBe(false);
      expect(result.error).toContain('Insufficient balance');
    });

    it('passes with valid protocol and sufficient balance', async () => {
      setupBalance(store);
      const executor = new ComposerExecutor(
        createMockConnector(), createMockApprovalHandler(),
        createMockTransactionExecutor(), createMockPreFlightChecker(),
        store, defaultConfig,
      );

      const result = await executor.execute(makeComposerAction());
      expect(result.success).toBe(true);
    });
  });

  // --- Full pipeline happy path ---

  describe('stage pipeline happy path', () => {
    it('executes Trigger -> Open -> Manage -> Close with COMPLETED status', async () => {
      setupBalance(store);
      const mockConnector = createMockConnector();
      const mockApproval = createMockApprovalHandler({
        handleApproval: vi.fn().mockResolvedValue('0xapprovaltx'),
      });
      const mockTxExecutor = createMockTransactionExecutor();
      const mockPreFlight = createMockPreFlightChecker();

      const executor = new ComposerExecutor(
        mockConnector, mockApproval, mockTxExecutor,
        mockPreFlight, store, defaultConfig,
      );

      const action = makeComposerAction();
      const result = await executor.execute(action);

      // 1. Quote was requested
      expect(mockConnector.getQuote).toHaveBeenCalledTimes(1);
      const quoteParams = (mockConnector.getQuote as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(quoteParams.fromChain).toBe(action.fromChain);
      expect(quoteParams.toChain).toBe(action.toChain);
      expect(quoteParams.fromToken).toBe(action.fromToken);
      expect(quoteParams.toToken).toBe(action.toToken);
      expect(quoteParams.fromAmount).toBe(action.amount.toString());

      // 2. Pre-flight checks ran
      expect(mockPreFlight.runAllChecks).toHaveBeenCalledTimes(1);

      // 3. Approval was handled
      expect(mockApproval.handleApproval).toHaveBeenCalledTimes(1);

      // 4. Transaction was executed
      expect(mockTxExecutor.execute).toHaveBeenCalledTimes(1);

      // 5. Status was polled
      expect(mockConnector.getStatus).toHaveBeenCalled();

      // 6. Result is successful
      expect(result.success).toBe(true);
      expect(result.txHash).toBeDefined();
      expect(result.transferId).toBeDefined();
      expect(result.error).toBeNull();

      // 7. Metadata includes protocol and status
      expect(result.metadata.status).toBe('DONE');
      expect(result.metadata.substatus).toBe('COMPLETED');
      expect(result.metadata.protocol).toBe('morpho');
      expect(result.metadata.bridge).toBe('lifi-composer');

      // 8. Transfer was completed in store (moved from active to completed)
      const activeTransfers = store.getActiveTransfers();
      expect(activeTransfers).toHaveLength(0);
      const completedTransfers = store.getCompletedTransfers();
      expect(completedTransfers).toHaveLength(1);
      expect(completedTransfers[0].toChain).toBe(action.toChain);
    });
  });

  // --- Open stage ---

  describe('open stage', () => {
    it('rejects when pre-flight checks fail', async () => {
      setupBalance(store);
      const failResult: PreFlightResult = {
        passed: false,
        failures: ['Gas cost $60.00 exceeds ceiling $50'],
      };
      const mockApproval = createMockApprovalHandler();
      const mockTxExecutor = createMockTransactionExecutor();

      const executor = new ComposerExecutor(
        createMockConnector(), mockApproval,
        mockTxExecutor,
        createMockPreFlightChecker({ runAllChecks: vi.fn().mockReturnValue(failResult) }),
        store, defaultConfig,
      );

      const result = await executor.execute(makeComposerAction());
      expect(result.success).toBe(false);
      expect(result.error).toContain('Pre-flight checks failed');
      expect(result.error).toContain('Gas cost');

      // Approval and transaction should NOT have been called
      expect(mockApproval.handleApproval).not.toHaveBeenCalled();
      expect(mockTxExecutor.execute).not.toHaveBeenCalled();

      // No transfer in store
      expect(store.getActiveTransfers()).toHaveLength(0);
    });

    it('retries on execution reverted with fresh quote', async () => {
      setupBalance(store);
      const mockConnector = createMockConnector();
      const mockTxExecutor = createMockTransactionExecutor({
        execute: vi.fn()
          .mockRejectedValueOnce(new Error('execution reverted'))
          .mockResolvedValueOnce(createMockTxResult()),
      });

      const executor = new ComposerExecutor(
        mockConnector, createMockApprovalHandler(), mockTxExecutor,
        createMockPreFlightChecker(), store, defaultConfig,
      );

      const result = await executor.execute(makeComposerAction());
      expect(result.success).toBe(true);
      // Two quotes requested (original + retry)
      expect(mockConnector.getQuote).toHaveBeenCalledTimes(2);
    });

    it('fails permanently after max retry attempts on revert', async () => {
      setupBalance(store);
      const mockTxExecutor = createMockTransactionExecutor({
        execute: vi.fn().mockRejectedValue(new Error('execution reverted')),
      });

      const executor = new ComposerExecutor(
        createMockConnector(), createMockApprovalHandler(), mockTxExecutor,
        createMockPreFlightChecker(), store, defaultConfig,
      );

      const result = await executor.execute(makeComposerAction());
      expect(result.success).toBe(false);
      expect(result.error).toContain('execution reverted');
    });

    it('does not retry non-revert errors', async () => {
      setupBalance(store);
      const mockConnector = createMockConnector();
      const mockTxExecutor = createMockTransactionExecutor({
        execute: vi.fn().mockRejectedValue(new Error('insufficient funds')),
      });

      const executor = new ComposerExecutor(
        mockConnector, createMockApprovalHandler(), mockTxExecutor,
        createMockPreFlightChecker(), store, defaultConfig,
      );

      const result = await executor.execute(makeComposerAction());
      expect(result.success).toBe(false);
      // Only one quote requested (no retry)
      expect(mockConnector.getQuote).toHaveBeenCalledTimes(1);
    });
  });

  // --- Manage stage ---

  describe('manage stage', () => {
    it('handles NOT_FOUND -> PENDING -> DONE transitions', async () => {
      setupBalance(store);
      const mockConnector = createMockConnector({
        getStatus: vi.fn()
          .mockResolvedValueOnce({ status: 'NOT_FOUND' })
          .mockResolvedValueOnce({ status: 'PENDING' })
          .mockResolvedValueOnce({
            status: 'DONE', substatus: 'COMPLETED',
            receiving: { amount: '980000', token: { address: '0x7bfa7c4f149e7415b73bdedfe609237e29cbf34a' } },
          }),
      });

      const executor = new ComposerExecutor(
        mockConnector, createMockApprovalHandler(),
        createMockTransactionExecutor(), createMockPreFlightChecker(),
        store, defaultConfig,
      );

      const result = await executor.execute(makeComposerAction());
      expect(result.success).toBe(true);
      expect(mockConnector.getStatus).toHaveBeenCalledTimes(3);
    });

    it('handles FAILED terminal status from manage', async () => {
      setupBalance(store);
      const mockConnector = createMockConnector({
        getStatus: vi.fn().mockResolvedValue({ status: 'FAILED' }),
      });

      const executor = new ComposerExecutor(
        mockConnector, createMockApprovalHandler(),
        createMockTransactionExecutor(), createMockPreFlightChecker(),
        store, defaultConfig,
      );

      const result = await executor.execute(makeComposerAction());
      expect(result.success).toBe(true);
      expect(result.metadata.status).toBe('FAILED');
    });
  });

  // --- Close stage ---

  describe('close stage', () => {
    it('handles COMPLETED status and updates destination chain balance', async () => {
      setupBalance(store);
      const executor = new ComposerExecutor(
        createMockConnector(), createMockApprovalHandler(),
        createMockTransactionExecutor(), createMockPreFlightChecker(),
        store, defaultConfig,
      );

      const result = await executor.execute(makeComposerAction());
      expect(result.success).toBe(true);
      expect(result.metadata.status).toBe('DONE');
      expect(result.metadata.substatus).toBe('COMPLETED');
      expect(result.metadata.bridge).toBe('lifi-composer');
      expect(result.metadata.protocol).toBe('morpho');

      // Transfer completed in store
      const completed = store.getCompletedTransfers();
      expect(completed).toHaveLength(1);
      expect(completed[0].toAmount).toBe(980000n);
    });

    it('handles PARTIAL status', async () => {
      setupBalance(store);
      const mockConnector = createMockConnector({
        getStatus: vi.fn().mockResolvedValue({
          status: 'DONE', substatus: 'PARTIAL',
          receiving: { amount: '500000', token: { address: '0x7bfa7c4f149e7415b73bdedfe609237e29cbf34a' } },
        }),
      });

      const executor = new ComposerExecutor(
        mockConnector, createMockApprovalHandler(),
        createMockTransactionExecutor(), createMockPreFlightChecker(),
        store, defaultConfig,
      );

      const result = await executor.execute(makeComposerAction());
      expect(result.success).toBe(true);
      expect(result.metadata.substatus).toBe('PARTIAL');

      const completed = store.getCompletedTransfers();
      expect(completed).toHaveLength(1);
      expect(completed[0].toAmount).toBe(500000n);
    });

    it('handles REFUNDED status — restores source chain', async () => {
      setupBalance(store);
      const mockConnector = createMockConnector({
        getStatus: vi.fn().mockResolvedValue({
          status: 'DONE', substatus: 'REFUNDED',
          receiving: { amount: '0' },
        }),
      });

      const executor = new ComposerExecutor(
        mockConnector, createMockApprovalHandler(),
        createMockTransactionExecutor(), createMockPreFlightChecker(),
        store, defaultConfig,
      );

      const result = await executor.execute(makeComposerAction());
      expect(result.success).toBe(true);
      expect(result.metadata.substatus).toBe('REFUNDED');
    });

    it('handles FAILED status — marks transfer as failed', async () => {
      setupBalance(store);
      const mockConnector = createMockConnector({
        getStatus: vi.fn().mockResolvedValue({ status: 'FAILED' }),
      });

      const executor = new ComposerExecutor(
        mockConnector, createMockApprovalHandler(),
        createMockTransactionExecutor(), createMockPreFlightChecker(),
        store, defaultConfig,
      );

      const result = await executor.execute(makeComposerAction());
      expect(result.success).toBe(true);
      expect(result.metadata.status).toBe('FAILED');
    });
  });

  // --- Stage tracking ---

  describe('stage tracking', () => {
    it('tracks current stage through execution', async () => {
      setupBalance(store);
      const executor = new ComposerExecutor(
        createMockConnector(), createMockApprovalHandler(),
        createMockTransactionExecutor(), createMockPreFlightChecker(),
        store, defaultConfig,
      );

      expect(executor.currentStage).toBe(EXECUTOR_STAGES.TRIGGER);
      await executor.execute(makeComposerAction());
      expect(executor.currentStage).toBe(EXECUTOR_STAGES.CLOSE);
    });

    it('sets stage to FAILED on trigger failure', async () => {
      // No balance — trigger will fail
      const executor = new ComposerExecutor(
        createMockConnector(), createMockApprovalHandler(),
        createMockTransactionExecutor(), createMockPreFlightChecker(),
        store, defaultConfig,
      );

      await executor.execute(makeComposerAction());
      expect(executor.currentStage).toBe(EXECUTOR_STAGES.FAILED);
    });

    it('sets stage to FAILED on open failure', async () => {
      setupBalance(store);
      const executor = new ComposerExecutor(
        createMockConnector({
          getQuote: vi.fn().mockRejectedValue(new Error('No route found')),
        }),
        createMockApprovalHandler(),
        createMockTransactionExecutor(), createMockPreFlightChecker(),
        store, defaultConfig,
      );

      await executor.execute(makeComposerAction());
      expect(executor.currentStage).toBe(EXECUTOR_STAGES.FAILED);
    });
  });

  // --- Cross-chain Composer ---

  describe('cross-chain Composer', () => {
    it('works with different from/to chains', async () => {
      const crossChainFromChain = chainId(1);
      const crossChainFromToken = tokenAddress('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
      store.setBalance(crossChainFromChain, crossChainFromToken, 10_000_000n, 10.0, 'USDC', 6);

      const mockConnector = createMockConnector();

      const executor = new ComposerExecutor(
        mockConnector, createMockApprovalHandler(),
        createMockTransactionExecutor(), createMockPreFlightChecker(),
        store, defaultConfig,
      );

      const action = makeComposerAction({
        fromChain: crossChainFromChain,
        toChain: chainId(8453),
        fromToken: crossChainFromToken,
      });

      const result = await executor.execute(action);
      expect(result.success).toBe(true);

      const quoteParams = (mockConnector.getQuote as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(quoteParams.fromChain).toBe(crossChainFromChain);
      expect(quoteParams.toChain).toBe(chainId(8453));
    });
  });

  // --- All supported protocols ---

  describe('supported protocols', () => {
    const protocols = ['aave-v3', 'morpho', 'euler', 'pendle', 'lido', 'etherfi', 'ethena'];

    for (const protocol of protocols) {
      it(`accepts ${protocol} as a supported protocol`, async () => {
        setupBalance(store);
        const executor = new ComposerExecutor(
          createMockConnector(), createMockApprovalHandler(),
          createMockTransactionExecutor(), createMockPreFlightChecker(),
          store, defaultConfig,
        );

        const action = makeComposerAction({ protocol });
        const result = await executor.execute(action);
        expect(result.success).toBe(true);
      });
    }
  });
});
