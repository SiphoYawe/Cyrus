import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SwapExecutor } from './swap-executor.js';
import type { SwapExecutorConfig } from './swap-executor.js';
import type { ApprovalHandler } from './approval-handler.js';
import type { TransactionExecutor, TransactionResult } from './transaction-executor.js';
import type { PreFlightChecker, PreFlightResult } from './pre-flight-checks.js';
import type { LiFiConnectorInterface, QuoteResult } from '../connectors/types.js';
import { Store } from '../core/store.js';
import type { SwapAction, BridgeAction, ExecutorAction } from '../core/action-types.js';
import { chainId, tokenAddress } from '../core/types.js';
import { ApprovalError } from '../utils/errors.js';

// --- Mock factories ---

function createMockQuote(): QuoteResult {
  return {
    transactionRequest: {
      to: '0xdeadbeef00000000000000000000000000000001',
      data: '0x1234',
      value: '0',
      gasLimit: '200000',
      chainId: 1,
    },
    estimate: {
      approvalAddress: '0xspender0000000000000000000000000000000001',
      toAmount: '990000',
      toAmountMin: '985000',
      executionDuration: 30,
      gasCosts: [{ amount: '1000000000000000', amountUSD: '2.50', token: { symbol: 'ETH' } }],
    },
    tool: 'stargate',
    toolDetails: { key: 'stargate', name: 'Stargate', logoURI: '' },
    action: {
      fromChainId: 1,
      toChainId: 42161,
      fromToken: { address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' },
      toToken: { address: '0xaf88d065e77c8cc2239327c5edb3a432268e5831' },
      fromAmount: '1000000',
    },
  };
}

function createMockTxResult(overrides: Partial<TransactionResult> = {}): TransactionResult {
  return {
    txHash: '0xtxhash000000000000000000000000000000000000000000000000000000ab',
    chainId: 1,
    blockNumber: 18000000n,
    gasUsed: 150000n,
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

function makeSwapAction(overrides: Partial<SwapAction> = {}): SwapAction {
  return {
    id: 'swap-1',
    type: 'swap',
    priority: 5,
    createdAt: Date.now(),
    strategyId: 'test-strategy',
    fromChain: chainId(1),
    toChain: chainId(42161),
    fromToken: tokenAddress('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'),
    toToken: tokenAddress('0xaf88d065e77c8cc2239327c5edb3a432268e5831'),
    amount: 1_000_000n,
    slippage: 0.005,
    metadata: {},
    ...overrides,
  };
}

function makeBridgeAction(overrides: Partial<BridgeAction> = {}): BridgeAction {
  return {
    id: 'bridge-1',
    type: 'bridge',
    priority: 3,
    createdAt: Date.now(),
    strategyId: 'test-strategy',
    fromChain: chainId(1),
    toChain: chainId(42161),
    fromToken: tokenAddress('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'),
    toToken: tokenAddress('0xaf88d065e77c8cc2239327c5edb3a432268e5831'),
    amount: 5_000_000n,
    metadata: {},
    ...overrides,
  };
}

const defaultConfig: SwapExecutorConfig = {
  maxGasCostUsd: 50,
  defaultSlippage: 0.005,
  maxBridgeTimeout: 300,
};

describe('SwapExecutor', () => {
  let store: Store;

  beforeEach(() => {
    Store.getInstance().reset();
    store = Store.getInstance();
  });

  // --- canHandle ---

  describe('canHandle', () => {
    it('returns true for swap action', () => {
      const executor = new SwapExecutor(
        createMockConnector(),
        createMockApprovalHandler(),
        createMockTransactionExecutor(),
        createMockPreFlightChecker(),
        store,
        defaultConfig,
      );

      expect(executor.canHandle(makeSwapAction())).toBe(true);
    });

    it('returns true for bridge action', () => {
      const executor = new SwapExecutor(
        createMockConnector(),
        createMockApprovalHandler(),
        createMockTransactionExecutor(),
        createMockPreFlightChecker(),
        store,
        defaultConfig,
      );

      expect(executor.canHandle(makeBridgeAction())).toBe(true);
    });

    it('returns false for unsupported action type', () => {
      const executor = new SwapExecutor(
        createMockConnector(),
        createMockApprovalHandler(),
        createMockTransactionExecutor(),
        createMockPreFlightChecker(),
        store,
        defaultConfig,
      );

      const composerAction = {
        id: 'composer-1',
        type: 'composer' as const,
        priority: 1,
        createdAt: Date.now(),
        strategyId: 'test',
        fromChain: chainId(1),
        toChain: chainId(1),
        fromToken: tokenAddress('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'),
        toToken: tokenAddress('0xdac17f958d2ee523a2206206994597c13d831ec7'),
        amount: 100n,
        protocol: 'aave-v3',
        metadata: {},
      };

      expect(executor.canHandle(composerAction)).toBe(false);
    });
  });

  // --- Full happy path ---

  describe('happy path', () => {
    it('executes full flow: quote → preflight → approval → tx → store', async () => {
      const mockConnector = createMockConnector();
      const mockApproval = createMockApprovalHandler({
        handleApproval: vi.fn().mockResolvedValue('0xapprovaltx'),
      });
      const mockTxExecutor = createMockTransactionExecutor();
      const mockPreFlight = createMockPreFlightChecker();

      const executor = new SwapExecutor(
        mockConnector,
        mockApproval,
        mockTxExecutor,
        mockPreFlight,
        store,
        defaultConfig,
      );

      const action = makeSwapAction();
      const result = await executor.execute(action);

      // 1. Quote was requested
      expect(mockConnector.getQuote).toHaveBeenCalledTimes(1);
      const quoteParams = (mockConnector.getQuote as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(quoteParams.fromChain).toBe(action.fromChain);
      expect(quoteParams.toChain).toBe(action.toChain);
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

      // 6. Transfer was created in store
      const activeTransfers = store.getActiveTransfers();
      expect(activeTransfers).toHaveLength(1);
      expect(activeTransfers[0].bridge).toBe('stargate');
      expect(activeTransfers[0].amount).toBe(action.amount);
    });

    it('works with bridge action type', async () => {
      const executor = new SwapExecutor(
        createMockConnector(),
        createMockApprovalHandler(),
        createMockTransactionExecutor(),
        createMockPreFlightChecker(),
        store,
        defaultConfig,
      );

      const action = makeBridgeAction();
      const result = await executor.execute(action);

      expect(result.success).toBe(true);
      expect(store.getActiveTransfers()).toHaveLength(1);
    });
  });

  // --- Pre-flight failure aborts ---

  describe('pre-flight failure', () => {
    it('aborts execution when pre-flight checks fail', async () => {
      const failResult: PreFlightResult = {
        passed: false,
        failures: ['Gas cost $75.00 exceeds ceiling $50'],
      };
      const mockPreFlight = createMockPreFlightChecker({
        runAllChecks: vi.fn().mockReturnValue(failResult),
      });
      const mockTxExecutor = createMockTransactionExecutor();
      const mockApproval = createMockApprovalHandler();

      const executor = new SwapExecutor(
        createMockConnector(),
        mockApproval,
        mockTxExecutor,
        mockPreFlight,
        store,
        defaultConfig,
      );

      const action = makeSwapAction();
      const result = await executor.execute(action);

      // Execution should fail
      expect(result.success).toBe(false);
      expect(result.error).toContain('Pre-flight checks failed');
      expect(result.error).toContain('Gas cost');

      // Approval and transaction should NOT have been called
      expect(mockApproval.handleApproval).not.toHaveBeenCalled();
      expect(mockTxExecutor.execute).not.toHaveBeenCalled();

      // No transfer should be in store
      expect(store.getActiveTransfers()).toHaveLength(0);
    });
  });

  // --- Approval error handled ---

  describe('approval error', () => {
    it('returns failure result when approval throws', async () => {
      const mockApproval = createMockApprovalHandler({
        handleApproval: vi.fn().mockRejectedValue(
          new ApprovalError({
            token: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
            spender: '0xspender',
            amount: '1000000',
          }),
        ),
      });
      const mockTxExecutor = createMockTransactionExecutor();

      const executor = new SwapExecutor(
        createMockConnector(),
        mockApproval,
        mockTxExecutor,
        createMockPreFlightChecker(),
        store,
        defaultConfig,
      );

      const action = makeSwapAction();
      const result = await executor.execute(action);

      // Execution should fail with approval error
      expect(result.success).toBe(false);
      expect(result.error).toContain('approval failed');
      expect(result.metadata.errorType).toBe('ApprovalError');

      // Transaction should NOT have been called
      expect(mockTxExecutor.execute).not.toHaveBeenCalled();

      // No transfer in store
      expect(store.getActiveTransfers()).toHaveLength(0);
    });
  });

  // --- Transaction error handled ---

  describe('transaction error', () => {
    it('returns failure result when transaction throws', async () => {
      const mockTxExecutor = createMockTransactionExecutor({
        execute: vi.fn().mockRejectedValue(new Error('Transaction reverted')),
      });

      const executor = new SwapExecutor(
        createMockConnector(),
        createMockApprovalHandler(),
        mockTxExecutor,
        createMockPreFlightChecker(),
        store,
        defaultConfig,
      );

      const action = makeSwapAction();
      const result = await executor.execute(action);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Transaction reverted');

      // No transfer in store
      expect(store.getActiveTransfers()).toHaveLength(0);
    });
  });

  // --- Quote error handled ---

  describe('quote error', () => {
    it('returns failure result when quote fails', async () => {
      const mockConnector = createMockConnector({
        getQuote: vi.fn().mockRejectedValue(new Error('No route found')),
      });

      const executor = new SwapExecutor(
        mockConnector,
        createMockApprovalHandler(),
        createMockTransactionExecutor(),
        createMockPreFlightChecker(),
        store,
        defaultConfig,
      );

      const action = makeSwapAction();
      const result = await executor.execute(action);

      expect(result.success).toBe(false);
      expect(result.error).toContain('No route found');
    });
  });

  // --- Metadata in result ---

  describe('result metadata', () => {
    it('includes tool, bridge, and gas info in metadata', async () => {
      const executor = new SwapExecutor(
        createMockConnector(),
        createMockApprovalHandler(),
        createMockTransactionExecutor(),
        createMockPreFlightChecker(),
        store,
        defaultConfig,
      );

      const action = makeSwapAction();
      const result = await executor.execute(action);

      expect(result.metadata.tool).toBe('stargate');
      expect(result.metadata.bridge).toBe('stargate');
      expect(result.metadata.blockNumber).toBeDefined();
      expect(result.metadata.gasUsed).toBeDefined();
    });
  });
});
