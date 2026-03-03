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
import { EXECUTOR_STAGES } from './base-executor.js';

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
    getStatus: vi.fn().mockResolvedValue({
      status: 'DONE',
      substatus: 'COMPLETED',
      receiving: { amount: '990000', token: { address: '0xaf88d065e77c8cc2239327c5edb3a432268e5831' } },
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

const FROM_CHAIN = chainId(1);
const TO_CHAIN = chainId(42161);
const FROM_TOKEN = tokenAddress('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
const TO_TOKEN = tokenAddress('0xaf88d065e77c8cc2239327c5edb3a432268e5831');

function makeSwapAction(overrides: Partial<SwapAction> = {}): SwapAction {
  return {
    id: 'swap-1',
    type: 'swap',
    priority: 5,
    createdAt: Date.now(),
    strategyId: 'test-strategy',
    fromChain: FROM_CHAIN,
    toChain: TO_CHAIN,
    fromToken: FROM_TOKEN,
    toToken: TO_TOKEN,
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
    fromChain: FROM_CHAIN,
    toChain: TO_CHAIN,
    fromToken: FROM_TOKEN,
    toToken: TO_TOKEN,
    amount: 5_000_000n,
    metadata: {},
    ...overrides,
  };
}

const defaultConfig: SwapExecutorConfig = {
  maxGasCostUsd: 50,
  defaultSlippage: 0.005,
  maxBridgeTimeout: 300,
  pollIntervalMs: 0, // instant polling for tests
};

function setupBalance(store: Store, amount: bigint = 10_000_000n): void {
  store.setBalance(FROM_CHAIN, FROM_TOKEN, amount, 10.0, 'USDC', 6);
}

describe('SwapExecutor', () => {
  let store: Store;

  beforeEach(() => {
    Store.getInstance().reset();
    store = Store.getInstance();
  });

  describe('canHandle', () => {
    it('returns true for swap action', () => {
      const executor = new SwapExecutor(
        createMockConnector(), createMockApprovalHandler(),
        createMockTransactionExecutor(), createMockPreFlightChecker(),
        store, defaultConfig,
      );
      expect(executor.canHandle(makeSwapAction())).toBe(true);
    });

    it('returns true for bridge action', () => {
      const executor = new SwapExecutor(
        createMockConnector(), createMockApprovalHandler(),
        createMockTransactionExecutor(), createMockPreFlightChecker(),
        store, defaultConfig,
      );
      expect(executor.canHandle(makeBridgeAction())).toBe(true);
    });

    it('returns false for unsupported action type', () => {
      const executor = new SwapExecutor(
        createMockConnector(), createMockApprovalHandler(),
        createMockTransactionExecutor(), createMockPreFlightChecker(),
        store, defaultConfig,
      );
      const composerAction = {
        id: 'c-1', type: 'composer' as const, priority: 1, createdAt: Date.now(),
        strategyId: 'test', fromChain: FROM_CHAIN, toChain: FROM_CHAIN,
        fromToken: FROM_TOKEN, toToken: TO_TOKEN, amount: 100n, protocol: 'aave-v3', metadata: {},
      };
      expect(executor.canHandle(composerAction)).toBe(false);
    });
  });

  describe('stage pipeline happy path', () => {
    it('executes Trigger → Open → Manage → Close with COMPLETED status', async () => {
      setupBalance(store);
      const mockConnector = createMockConnector();
      const mockApproval = createMockApprovalHandler({
        handleApproval: vi.fn().mockResolvedValue('0xapprovaltx'),
      });
      const mockTxExecutor = createMockTransactionExecutor();

      const executor = new SwapExecutor(
        mockConnector, mockApproval, mockTxExecutor,
        createMockPreFlightChecker(), store, defaultConfig,
      );

      const action = makeSwapAction();
      const result = await executor.execute(action);

      expect(result.success).toBe(true);
      expect(mockConnector.getQuote).toHaveBeenCalledTimes(1);
      expect(mockApproval.handleApproval).toHaveBeenCalledTimes(1);
      expect(mockTxExecutor.execute).toHaveBeenCalledTimes(1);
      expect(mockConnector.getStatus).toHaveBeenCalled();
      expect(result.metadata.status).toBe('DONE');
      expect(result.metadata.tool).toBe('stargate');
    });

    it('works with bridge action type', async () => {
      setupBalance(store, 50_000_000n);
      const executor = new SwapExecutor(
        createMockConnector(), createMockApprovalHandler(),
        createMockTransactionExecutor(), createMockPreFlightChecker(),
        store, defaultConfig,
      );

      const result = await executor.execute(makeBridgeAction());
      expect(result.success).toBe(true);
    });
  });

  describe('trigger stage', () => {
    it('rejects when insufficient balance', async () => {
      // Don't set up balance — store has 0
      const executor = new SwapExecutor(
        createMockConnector(), createMockApprovalHandler(),
        createMockTransactionExecutor(), createMockPreFlightChecker(),
        store, defaultConfig,
      );

      const result = await executor.execute(makeSwapAction());
      expect(result.success).toBe(false);
      expect(result.error).toContain('Insufficient balance');
    });
  });

  describe('open stage', () => {
    it('rejects when pre-flight checks fail', async () => {
      setupBalance(store);
      const failResult: PreFlightResult = {
        passed: false,
        failures: ['Gas cost $75.00 exceeds ceiling $50'],
      };
      const executor = new SwapExecutor(
        createMockConnector(), createMockApprovalHandler(),
        createMockTransactionExecutor(),
        createMockPreFlightChecker({ runAllChecks: vi.fn().mockReturnValue(failResult) }),
        store, defaultConfig,
      );

      const result = await executor.execute(makeSwapAction());
      expect(result.success).toBe(false);
      expect(result.error).toContain('Pre-flight checks failed');
    });

    it('fails when approval throws', async () => {
      setupBalance(store);
      const executor = new SwapExecutor(
        createMockConnector(),
        createMockApprovalHandler({
          handleApproval: vi.fn().mockRejectedValue(
            new ApprovalError({ token: '0xabc', spender: '0xspender', amount: '1000000' }),
          ),
        }),
        createMockTransactionExecutor(), createMockPreFlightChecker(),
        store, defaultConfig,
      );

      const result = await executor.execute(makeSwapAction());
      expect(result.success).toBe(false);
      expect(result.error).toContain('approval failed');
    });

    it('retries on execution reverted with fresh quote', async () => {
      setupBalance(store);
      const mockConnector = createMockConnector();
      const mockTxExecutor = createMockTransactionExecutor({
        execute: vi.fn()
          .mockRejectedValueOnce(new Error('execution reverted'))
          .mockResolvedValueOnce(createMockTxResult()),
      });

      const executor = new SwapExecutor(
        mockConnector, createMockApprovalHandler(), mockTxExecutor,
        createMockPreFlightChecker(), store, defaultConfig,
      );

      const result = await executor.execute(makeSwapAction());
      expect(result.success).toBe(true);
      // Two quotes requested (original + retry)
      expect(mockConnector.getQuote).toHaveBeenCalledTimes(2);
    });

    it('fails permanently after max retry attempts', async () => {
      setupBalance(store);
      const mockTxExecutor = createMockTransactionExecutor({
        execute: vi.fn().mockRejectedValue(new Error('execution reverted')),
      });

      const executor = new SwapExecutor(
        createMockConnector(), createMockApprovalHandler(), mockTxExecutor,
        createMockPreFlightChecker(), store, defaultConfig,
      );

      const result = await executor.execute(makeSwapAction());
      expect(result.success).toBe(false);
      expect(result.error).toContain('execution reverted');
    });

    it('does not retry non-revert errors', async () => {
      setupBalance(store);
      const mockConnector = createMockConnector();
      const mockTxExecutor = createMockTransactionExecutor({
        execute: vi.fn().mockRejectedValue(new Error('insufficient funds')),
      });

      const executor = new SwapExecutor(
        mockConnector, createMockApprovalHandler(), mockTxExecutor,
        createMockPreFlightChecker(), store, defaultConfig,
      );

      const result = await executor.execute(makeSwapAction());
      expect(result.success).toBe(false);
      // Only one quote requested (no retry)
      expect(mockConnector.getQuote).toHaveBeenCalledTimes(1);
    });
  });

  describe('manage stage', () => {
    it('handles NOT_FOUND → PENDING → DONE transitions', async () => {
      setupBalance(store);
      const mockConnector = createMockConnector({
        getStatus: vi.fn()
          .mockResolvedValueOnce({ status: 'NOT_FOUND' })
          .mockResolvedValueOnce({ status: 'PENDING' })
          .mockResolvedValueOnce({
            status: 'DONE', substatus: 'COMPLETED',
            receiving: { amount: '990000', token: { address: '0xaf88d065e77c8cc2239327c5edb3a432268e5831' } },
          }),
      });

      const executor = new SwapExecutor(
        mockConnector, createMockApprovalHandler(),
        createMockTransactionExecutor(), createMockPreFlightChecker(),
        store, defaultConfig,
      );

      const result = await executor.execute(makeSwapAction());
      expect(result.success).toBe(true);
      expect(mockConnector.getStatus).toHaveBeenCalledTimes(3);
    });
  });

  describe('close stage', () => {
    it('handles PARTIAL status', async () => {
      setupBalance(store);
      const mockConnector = createMockConnector({
        getStatus: vi.fn().mockResolvedValue({
          status: 'DONE', substatus: 'PARTIAL',
          receiving: { amount: '500000', token: { address: '0xaf88d065e77c8cc2239327c5edb3a432268e5831' } },
        }),
      });

      const executor = new SwapExecutor(
        mockConnector, createMockApprovalHandler(),
        createMockTransactionExecutor(), createMockPreFlightChecker(),
        store, defaultConfig,
      );

      const result = await executor.execute(makeSwapAction());
      expect(result.success).toBe(true);
      expect(result.metadata.substatus).toBe('PARTIAL');
    });

    it('handles REFUNDED status', async () => {
      setupBalance(store);
      const mockConnector = createMockConnector({
        getStatus: vi.fn().mockResolvedValue({
          status: 'DONE', substatus: 'REFUNDED',
          receiving: { amount: '0' },
        }),
      });

      const executor = new SwapExecutor(
        mockConnector, createMockApprovalHandler(),
        createMockTransactionExecutor(), createMockPreFlightChecker(),
        store, defaultConfig,
      );

      const result = await executor.execute(makeSwapAction());
      expect(result.success).toBe(true);
      expect(result.metadata.substatus).toBe('REFUNDED');
    });

    it('handles FAILED status', async () => {
      setupBalance(store);
      const mockConnector = createMockConnector({
        getStatus: vi.fn().mockResolvedValue({ status: 'FAILED' }),
      });

      const executor = new SwapExecutor(
        mockConnector, createMockApprovalHandler(),
        createMockTransactionExecutor(), createMockPreFlightChecker(),
        store, defaultConfig,
      );

      const result = await executor.execute(makeSwapAction());
      expect(result.success).toBe(true);
      expect(result.metadata.status).toBe('FAILED');
    });
  });

  describe('stage tracking', () => {
    it('tracks current stage through execution', async () => {
      setupBalance(store);
      const executor = new SwapExecutor(
        createMockConnector(), createMockApprovalHandler(),
        createMockTransactionExecutor(), createMockPreFlightChecker(),
        store, defaultConfig,
      );

      expect(executor.currentStage).toBe(EXECUTOR_STAGES.TRIGGER);
      await executor.execute(makeSwapAction());
      expect(executor.currentStage).toBe(EXECUTOR_STAGES.CLOSE);
    });
  });
});
