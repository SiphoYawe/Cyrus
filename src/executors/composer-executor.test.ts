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
    getStatus: vi.fn().mockResolvedValue({ status: 'DONE' }),
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

function makeComposerAction(overrides: Partial<ComposerAction> = {}): ComposerAction {
  return {
    id: 'composer-1',
    type: 'composer',
    priority: 5,
    createdAt: Date.now(),
    strategyId: 'yield-strategy',
    fromChain: chainId(8453),
    toChain: chainId(8453),
    fromToken: tokenAddress('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'), // USDC on Base
    toToken: tokenAddress('0x7bfa7c4f149e7415b73bdedfe609237e29cbf34a'),   // Morpho vault on Base
    amount: 1_000_000n,
    protocol: 'morpho',
    metadata: {},
    ...overrides,
  };
}

const defaultConfig: ComposerExecutorConfig = {
  enabled: true,
  supportedProtocols: ['aave-v3', 'morpho', 'euler', 'pendle', 'lido', 'etherfi', 'ethena'],
  defaultSlippage: 0.005,
  maxGasCostUsd: 50,
  maxBridgeTimeout: 300,
};

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
        createMockConnector(),
        createMockApprovalHandler(),
        createMockTransactionExecutor(),
        createMockPreFlightChecker(),
        store,
        defaultConfig,
      );

      expect(executor.canHandle(makeComposerAction())).toBe(true);
    });

    it('returns false for swap action', () => {
      const executor = new ComposerExecutor(
        createMockConnector(),
        createMockApprovalHandler(),
        createMockTransactionExecutor(),
        createMockPreFlightChecker(),
        store,
        defaultConfig,
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
      };

      expect(executor.canHandle(swapAction)).toBe(false);
    });

    it('returns false for bridge action', () => {
      const executor = new ComposerExecutor(
        createMockConnector(),
        createMockApprovalHandler(),
        createMockTransactionExecutor(),
        createMockPreFlightChecker(),
        store,
        defaultConfig,
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
      };

      expect(executor.canHandle(bridgeAction)).toBe(false);
    });
  });

  // --- Full happy path ---

  describe('happy path', () => {
    it('executes full flow: quote -> preflight -> approval -> tx -> store', async () => {
      const mockConnector = createMockConnector();
      const mockApproval = createMockApprovalHandler({
        handleApproval: vi.fn().mockResolvedValue('0xapprovaltx'),
      });
      const mockTxExecutor = createMockTransactionExecutor();
      const mockPreFlight = createMockPreFlightChecker();

      const executor = new ComposerExecutor(
        mockConnector,
        mockApproval,
        mockTxExecutor,
        mockPreFlight,
        store,
        defaultConfig,
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

      // 5. Result is successful
      expect(result.success).toBe(true);
      expect(result.txHash).toBeDefined();
      expect(result.transferId).toBeDefined();
      expect(result.error).toBeNull();

      // 6. Metadata includes isComposer and protocol
      expect(result.metadata.isComposer).toBe(true);
      expect(result.metadata.protocol).toBe('morpho');
      expect(result.metadata.tool).toBe('lifi-composer');

      // 7. Transfer was created in store
      const activeTransfers = store.getActiveTransfers();
      expect(activeTransfers).toHaveLength(1);
      expect(activeTransfers[0].amount).toBe(action.amount);
      expect(activeTransfers[0].fromChain).toBe(action.fromChain);
      expect(activeTransfers[0].toChain).toBe(action.toChain);
    });

    it('includes approval tx hash in metadata when approval is needed', async () => {
      const mockApproval = createMockApprovalHandler({
        handleApproval: vi.fn().mockResolvedValue('0xapproval123'),
      });

      const executor = new ComposerExecutor(
        createMockConnector(),
        mockApproval,
        createMockTransactionExecutor(),
        createMockPreFlightChecker(),
        store,
        defaultConfig,
      );

      const result = await executor.execute(makeComposerAction());

      expect(result.success).toBe(true);
      expect(result.metadata.approvalTxHash).toBe('0xapproval123');
    });

    it('works without approval needed', async () => {
      const mockApproval = createMockApprovalHandler({
        handleApproval: vi.fn().mockResolvedValue(null),
      });

      const executor = new ComposerExecutor(
        createMockConnector(),
        mockApproval,
        createMockTransactionExecutor(),
        createMockPreFlightChecker(),
        store,
        defaultConfig,
      );

      const result = await executor.execute(makeComposerAction());

      expect(result.success).toBe(true);
      expect(result.metadata.approvalTxHash).toBeUndefined();
    });
  });

  // --- Disabled config ---

  describe('disabled Composer config', () => {
    it('returns failure when Composer is disabled', async () => {
      const disabledConfig: ComposerExecutorConfig = {
        ...defaultConfig,
        enabled: false,
      };

      const mockConnector = createMockConnector();
      const mockApproval = createMockApprovalHandler();
      const mockTxExecutor = createMockTransactionExecutor();

      const executor = new ComposerExecutor(
        mockConnector,
        mockApproval,
        mockTxExecutor,
        createMockPreFlightChecker(),
        store,
        disabledConfig,
      );

      const action = makeComposerAction();
      const result = await executor.execute(action);

      expect(result.success).toBe(false);
      expect(result.error).toContain('disabled');

      // No calls to connector, approval, or tx executor
      expect(mockConnector.getQuote).not.toHaveBeenCalled();
      expect(mockApproval.handleApproval).not.toHaveBeenCalled();
      expect(mockTxExecutor.execute).not.toHaveBeenCalled();

      // No transfer in store
      expect(store.getActiveTransfers()).toHaveLength(0);
    });
  });

  // --- Unsupported protocol ---

  describe('unsupported protocol', () => {
    it('rejects unsupported protocol', async () => {
      const limitedConfig: ComposerExecutorConfig = {
        ...defaultConfig,
        supportedProtocols: ['aave-v3', 'morpho'],
      };

      const mockConnector = createMockConnector();

      const executor = new ComposerExecutor(
        mockConnector,
        createMockApprovalHandler(),
        createMockTransactionExecutor(),
        createMockPreFlightChecker(),
        store,
        limitedConfig,
      );

      const action = makeComposerAction({ protocol: 'pendle' });
      const result = await executor.execute(action);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Unsupported protocol');
      expect(result.error).toContain('pendle');
      expect(result.metadata.protocol).toBe('pendle');

      // No quote call
      expect(mockConnector.getQuote).not.toHaveBeenCalled();

      // No transfer in store
      expect(store.getActiveTransfers()).toHaveLength(0);
    });
  });

  // --- Pre-flight failure ---

  describe('pre-flight failure', () => {
    it('aborts execution when pre-flight checks fail', async () => {
      const failResult: PreFlightResult = {
        passed: false,
        failures: ['Gas cost $60.00 exceeds ceiling $50'],
      };
      const mockPreFlight = createMockPreFlightChecker({
        runAllChecks: vi.fn().mockReturnValue(failResult),
      });
      const mockTxExecutor = createMockTransactionExecutor();
      const mockApproval = createMockApprovalHandler();

      const executor = new ComposerExecutor(
        createMockConnector(),
        mockApproval,
        mockTxExecutor,
        mockPreFlight,
        store,
        defaultConfig,
      );

      const action = makeComposerAction();
      const result = await executor.execute(action);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Pre-flight checks failed');
      expect(result.error).toContain('Gas cost');
      expect(result.metadata.isComposer).toBe(true);

      // Approval and transaction should NOT have been called
      expect(mockApproval.handleApproval).not.toHaveBeenCalled();
      expect(mockTxExecutor.execute).not.toHaveBeenCalled();

      // No transfer in store
      expect(store.getActiveTransfers()).toHaveLength(0);
    });
  });

  // --- Error handling / failure with fallback ---

  describe('failure with fallback steps', () => {
    it('returns fallback steps when quote fails', async () => {
      const mockConnector = createMockConnector({
        getQuote: vi.fn().mockRejectedValue(new Error('No Composer route found')),
      });

      const executor = new ComposerExecutor(
        mockConnector,
        createMockApprovalHandler(),
        createMockTransactionExecutor(),
        createMockPreFlightChecker(),
        store,
        defaultConfig,
      );

      const action = makeComposerAction();
      const result = await executor.execute(action);

      expect(result.success).toBe(false);
      expect(result.error).toContain('No Composer route found');
      expect(result.metadata.isComposer).toBe(true);
      expect(result.metadata.protocol).toBe('morpho');
      expect(result.metadata.errorType).toBe('Error');
      expect(result.metadata.fallbackSteps).toBeDefined();
      expect(Array.isArray(result.metadata.fallbackSteps)).toBe(true);
      expect((result.metadata.fallbackSteps as string[]).length).toBeGreaterThan(0);

      // No transfer in store
      expect(store.getActiveTransfers()).toHaveLength(0);
    });

    it('returns fallback steps when transaction fails', async () => {
      const mockTxExecutor = createMockTransactionExecutor({
        execute: vi.fn().mockRejectedValue(new Error('Transaction reverted')),
      });

      const executor = new ComposerExecutor(
        createMockConnector(),
        createMockApprovalHandler(),
        mockTxExecutor,
        createMockPreFlightChecker(),
        store,
        defaultConfig,
      );

      const action = makeComposerAction();
      const result = await executor.execute(action);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Transaction reverted');
      expect(result.metadata.fallbackSteps).toBeDefined();
      expect((result.metadata.fallbackSteps as string[])).toEqual(
        expect.arrayContaining([expect.stringContaining('protocol')]),
      );
    });

    it('returns fallback steps when approval fails', async () => {
      const mockApproval = createMockApprovalHandler({
        handleApproval: vi.fn().mockRejectedValue(new Error('Approval rejected by user')),
      });

      const executor = new ComposerExecutor(
        createMockConnector(),
        mockApproval,
        createMockTransactionExecutor(),
        createMockPreFlightChecker(),
        store,
        defaultConfig,
      );

      const action = makeComposerAction();
      const result = await executor.execute(action);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Approval rejected');
      expect(result.metadata.fallbackSteps).toBeDefined();
    });
  });

  // --- Cannot handle wrong action type ---

  describe('wrong action type', () => {
    it('returns failure for non-composer action type', async () => {
      const executor = new ComposerExecutor(
        createMockConnector(),
        createMockApprovalHandler(),
        createMockTransactionExecutor(),
        createMockPreFlightChecker(),
        store,
        defaultConfig,
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

      const result = await executor.execute(swapAction);

      expect(result.success).toBe(false);
      expect(result.error).toContain('cannot handle');
    });
  });

  // --- handleComposerFailure ---

  describe('handleComposerFailure', () => {
    it('produces failure result with fallback steps', () => {
      const executor = new ComposerExecutor(
        createMockConnector(),
        createMockApprovalHandler(),
        createMockTransactionExecutor(),
        createMockPreFlightChecker(),
        store,
        defaultConfig,
      );

      const action = makeComposerAction();
      const error = new Error('Vault is paused');
      const result = executor.handleComposerFailure(action, error);

      expect(result.success).toBe(false);
      expect(result.transferId).toBeNull();
      expect(result.txHash).toBeNull();
      expect(result.error).toBe('Vault is paused');
      expect(result.metadata.isComposer).toBe(true);
      expect(result.metadata.protocol).toBe('morpho');
      expect(result.metadata.errorType).toBe('Error');
      expect(result.metadata.fallbackSteps).toBeDefined();

      const fallbackSteps = result.metadata.fallbackSteps as string[];
      expect(fallbackSteps.length).toBeGreaterThanOrEqual(3);
      expect(fallbackSteps.some((s) => s.includes('swap'))).toBe(true);
      expect(fallbackSteps.some((s) => s.includes('protocol'))).toBe(true);
    });
  });

  // --- Result metadata ---

  describe('result metadata', () => {
    it('includes tool, bridge, protocol, and isComposer in metadata', async () => {
      const executor = new ComposerExecutor(
        createMockConnector(),
        createMockApprovalHandler(),
        createMockTransactionExecutor(),
        createMockPreFlightChecker(),
        store,
        defaultConfig,
      );

      const action = makeComposerAction();
      const result = await executor.execute(action);

      expect(result.metadata.tool).toBe('lifi-composer');
      expect(result.metadata.bridge).toBe('lifi-composer');
      expect(result.metadata.protocol).toBe('morpho');
      expect(result.metadata.isComposer).toBe(true);
      expect(result.metadata.blockNumber).toBeDefined();
      expect(result.metadata.gasUsed).toBeDefined();
    });
  });

  // --- Cross-chain Composer ---

  describe('cross-chain Composer', () => {
    it('works with different from/to chains', async () => {
      const crossChainQuote = createMockQuote();
      // Override action to be cross-chain
      const mockConnector = createMockConnector({
        getQuote: vi.fn().mockResolvedValue({
          ...crossChainQuote,
          action: {
            ...crossChainQuote.action,
            fromChainId: 1,
            toChainId: 8453,
          },
        }),
      });

      const executor = new ComposerExecutor(
        mockConnector,
        createMockApprovalHandler(),
        createMockTransactionExecutor(),
        createMockPreFlightChecker(),
        store,
        defaultConfig,
      );

      const action = makeComposerAction({
        fromChain: chainId(1),
        toChain: chainId(8453),
        fromToken: tokenAddress('0x0000000000000000000000000000000000000000'), // ETH
      });

      const result = await executor.execute(action);

      expect(result.success).toBe(true);
      expect(result.metadata.isComposer).toBe(true);

      const transfers = store.getActiveTransfers();
      expect(transfers).toHaveLength(1);
      expect(transfers[0].fromChain).toBe(chainId(1));
      expect(transfers[0].toChain).toBe(chainId(8453));
    });
  });
});
