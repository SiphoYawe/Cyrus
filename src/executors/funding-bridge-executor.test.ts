import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FundingBridgeExecutor } from './funding-bridge-executor.js';
import type { FundingBridgeExecutorConfig } from './funding-bridge-executor.js';
import type { ApprovalHandler } from './approval-handler.js';
import type { TransactionExecutor, TransactionResult } from './transaction-executor.js';
import type { PreFlightChecker, PreFlightResult } from './pre-flight-checks.js';
import type { LiFiConnectorInterface, QuoteResult } from '../connectors/types.js';
import type { HyperliquidConnectorInterface } from '../connectors/hyperliquid-connector.js';
import { Store } from '../core/store.js';
import type { FundingBridgeAction } from '../core/action-types.js';
import { chainId, tokenAddress } from '../core/types.js';
import { CHAINS, USDC_ADDRESSES } from '../core/constants.js';

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

function createMockHyperliquidConnector(
  overrides: Partial<HyperliquidConnectorInterface> = {},
): HyperliquidConnectorInterface {
  return {
    queryBalance: vi.fn().mockResolvedValue({
      totalMarginUsed: 0, totalNtlPos: 0, totalRawUsd: 0, withdrawable: 0,
      crossMarginSummary: { accountValue: 0, totalMarginUsed: 0, totalNtlPos: 0 },
    }),
    queryPositions: vi.fn().mockResolvedValue([]),
    queryFundingRates: vi.fn().mockResolvedValue(new Map()),
    queryOpenInterest: vi.fn().mockResolvedValue(new Map()),
    queryOrderBook: vi.fn().mockResolvedValue({ coin: '', bids: [], asks: [], timestamp: 0 }),
    placeMarketOrder: vi.fn().mockResolvedValue({ status: 'ok', orderId: 1, filledSize: '0' }),
    placeLimitOrder: vi.fn().mockResolvedValue({ status: 'ok', orderId: 1, filledSize: '0' }),
    cancelOrder: vi.fn().mockResolvedValue(true),
    closePosition: vi.fn().mockResolvedValue({ status: 'ok', orderId: 1, filledSize: '0' }),
    queryOpenOrders: vi.fn().mockResolvedValue([]),
    queryFills: vi.fn().mockResolvedValue([]),
    depositToMargin: vi.fn().mockResolvedValue(true),
    withdrawFromMargin: vi.fn().mockResolvedValue(true),
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

const FROM_CHAIN = CHAINS.ETHEREUM;
const TO_CHAIN = CHAINS.ARBITRUM;
const FROM_TOKEN = USDC_ADDRESSES[FROM_CHAIN as number];
const TO_TOKEN = USDC_ADDRESSES[TO_CHAIN as number];

function makeFundingAction(overrides: Partial<FundingBridgeAction> = {}): FundingBridgeAction {
  return {
    id: 'funding-1',
    type: 'funding_bridge',
    priority: 8,
    createdAt: Date.now(),
    strategyId: 'funding-controller',
    fromChain: FROM_CHAIN,
    toChain: TO_CHAIN,
    fromToken: FROM_TOKEN,
    toToken: TO_TOKEN,
    amount: 5_000_000n, // 5 USDC
    fundingBatchId: 'batch-1',
    triggeringSignalId: 'signal-1',
    depositToHyperliquid: true,
    metadata: {},
    ...overrides,
  };
}

const defaultConfig: Partial<FundingBridgeExecutorConfig> = {
  pollIntervalMs: 0, // instant polling for tests
};

function setupBalance(store: Store, amount: bigint = 10_000_000n): void {
  store.setBalance(FROM_CHAIN, FROM_TOKEN, amount, 10, 'USDC', 6);
}

describe('FundingBridgeExecutor', () => {
  let store: Store;

  beforeEach(() => {
    Store.getInstance().reset();
    store = Store.getInstance();
  });

  describe('canHandle', () => {
    it('returns true for funding_bridge action', () => {
      const executor = new FundingBridgeExecutor(
        createMockConnector(), createMockHyperliquidConnector(),
        createMockApprovalHandler(), createMockTransactionExecutor(),
        createMockPreFlightChecker(), store, defaultConfig,
      );
      expect(executor.canHandle(makeFundingAction())).toBe(true);
    });

    it('returns false for bridge action', () => {
      const executor = new FundingBridgeExecutor(
        createMockConnector(), createMockHyperliquidConnector(),
        createMockApprovalHandler(), createMockTransactionExecutor(),
        createMockPreFlightChecker(), store, defaultConfig,
      );
      const bridgeAction = {
        ...makeFundingAction(),
        type: 'bridge' as const,
      };
      expect(executor.canHandle(bridgeAction as any)).toBe(false);
    });
  });

  describe('trigger stage', () => {
    it('rejects same-chain transfers', async () => {
      setupBalance(store);
      const executor = new FundingBridgeExecutor(
        createMockConnector(), createMockHyperliquidConnector(),
        createMockApprovalHandler(), createMockTransactionExecutor(),
        createMockPreFlightChecker(), store, defaultConfig,
      );

      const result = await executor.execute(makeFundingAction({ toChain: FROM_CHAIN }));
      expect(result.success).toBe(false);
      expect(result.error).toContain('cross-chain');
    });

    it('rejects when insufficient balance', async () => {
      // No balance set up
      const executor = new FundingBridgeExecutor(
        createMockConnector(), createMockHyperliquidConnector(),
        createMockApprovalHandler(), createMockTransactionExecutor(),
        createMockPreFlightChecker(), store, defaultConfig,
      );

      const result = await executor.execute(makeFundingAction());
      expect(result.success).toBe(false);
      expect(result.error).toContain('Insufficient USDC');
    });

    it('passes with sufficient cross-chain balance', async () => {
      setupBalance(store);
      const executor = new FundingBridgeExecutor(
        createMockConnector(), createMockHyperliquidConnector(),
        createMockApprovalHandler(), createMockTransactionExecutor(),
        createMockPreFlightChecker(), store, defaultConfig,
      );

      const result = await executor.execute(makeFundingAction());
      expect(result.success).toBe(true);
    });
  });

  describe('open stage', () => {
    it('executes full pipeline: quote → approve → execute → create transfer', async () => {
      setupBalance(store);
      const mockConnector = createMockConnector();
      const mockApproval = createMockApprovalHandler({
        handleApproval: vi.fn().mockResolvedValue('0xapprovaltx'),
      });
      const mockTxExecutor = createMockTransactionExecutor();

      const executor = new FundingBridgeExecutor(
        mockConnector, createMockHyperliquidConnector(),
        mockApproval, mockTxExecutor,
        createMockPreFlightChecker(), store, defaultConfig,
      );

      const result = await executor.execute(makeFundingAction());
      expect(result.success).toBe(true);
      expect(mockConnector.getQuote).toHaveBeenCalledTimes(1);
      expect(mockApproval.handleApproval).toHaveBeenCalledTimes(1);
      expect(mockTxExecutor.execute).toHaveBeenCalledTimes(1);
    });

    it('rejects when pre-flight checks fail', async () => {
      setupBalance(store);
      const failResult: PreFlightResult = {
        passed: false,
        failures: ['Gas cost $75.00 exceeds ceiling $50'],
      };
      const executor = new FundingBridgeExecutor(
        createMockConnector(), createMockHyperliquidConnector(),
        createMockApprovalHandler(), createMockTransactionExecutor(),
        createMockPreFlightChecker({ runAllChecks: vi.fn().mockReturnValue(failResult) }),
        store, defaultConfig,
      );

      const result = await executor.execute(makeFundingAction());
      expect(result.success).toBe(false);
      expect(result.error).toContain('Pre-flight checks failed');
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
            receiving: { amount: '990000', token: { address: TO_TOKEN } },
          }),
      });

      const executor = new FundingBridgeExecutor(
        mockConnector, createMockHyperliquidConnector(),
        createMockApprovalHandler(), createMockTransactionExecutor(),
        createMockPreFlightChecker(), store, defaultConfig,
      );

      const result = await executor.execute(makeFundingAction());
      expect(result.success).toBe(true);
      expect(mockConnector.getStatus).toHaveBeenCalledTimes(3);
    });

    it('handles FAILED terminal status', async () => {
      setupBalance(store);
      const onFailed = vi.fn();
      const mockConnector = createMockConnector({
        getStatus: vi.fn().mockResolvedValue({ status: 'FAILED' }),
      });

      const executor = new FundingBridgeExecutor(
        mockConnector, createMockHyperliquidConnector(),
        createMockApprovalHandler(), createMockTransactionExecutor(),
        createMockPreFlightChecker(), store, defaultConfig,
        { onFailed },
      );

      const result = await executor.execute(makeFundingAction());
      expect(result.success).toBe(true);
      expect(result.metadata.status).toBe('FAILED');
      expect(onFailed).toHaveBeenCalledWith('batch-1');
    });
  });

  describe('close stage', () => {
    it('deposits USDC to Hyperliquid on COMPLETED', async () => {
      setupBalance(store);
      const mockHl = createMockHyperliquidConnector();
      const onCompleted = vi.fn();

      const executor = new FundingBridgeExecutor(
        createMockConnector(), mockHl,
        createMockApprovalHandler(), createMockTransactionExecutor(),
        createMockPreFlightChecker(), store, defaultConfig,
        { onCompleted },
      );

      const result = await executor.execute(makeFundingAction());
      expect(result.success).toBe(true);
      expect(result.metadata.status).toBe('DONE');
      expect(result.metadata.substatus).toBe('COMPLETED');
      expect(mockHl.depositToMargin).toHaveBeenCalledWith('0.99');
      expect(onCompleted).toHaveBeenCalledWith('batch-1', 990000n);
    });

    it('handles PARTIAL status with correct USDC token', async () => {
      setupBalance(store);
      const mockHl = createMockHyperliquidConnector();
      const onCompleted = vi.fn();
      const mockConnector = createMockConnector({
        getStatus: vi.fn().mockResolvedValue({
          status: 'DONE', substatus: 'PARTIAL',
          receiving: { amount: '500000', token: { address: TO_TOKEN as string } },
        }),
      });

      const executor = new FundingBridgeExecutor(
        mockConnector, mockHl,
        createMockApprovalHandler(), createMockTransactionExecutor(),
        createMockPreFlightChecker(), store, defaultConfig,
        { onCompleted },
      );

      const result = await executor.execute(makeFundingAction());
      expect(result.success).toBe(true);
      expect(result.metadata.substatus).toBe('PARTIAL');
      expect(mockHl.depositToMargin).toHaveBeenCalledWith('0.5');
      expect(onCompleted).toHaveBeenCalledWith('batch-1', 500000n);
    });

    it('skips Hyperliquid deposit on PARTIAL with non-USDC token', async () => {
      setupBalance(store);
      const mockHl = createMockHyperliquidConnector();
      const onFailed = vi.fn();
      const wrongToken = '0xwrongtoken0000000000000000000000000000001';
      const mockConnector = createMockConnector({
        getStatus: vi.fn().mockResolvedValue({
          status: 'DONE', substatus: 'PARTIAL',
          receiving: { amount: '500000', token: { address: wrongToken } },
        }),
      });

      const executor = new FundingBridgeExecutor(
        mockConnector, mockHl,
        createMockApprovalHandler(), createMockTransactionExecutor(),
        createMockPreFlightChecker(), store, defaultConfig,
        { onFailed },
      );

      const result = await executor.execute(makeFundingAction());
      expect(result.success).toBe(true);
      expect(mockHl.depositToMargin).not.toHaveBeenCalled();
      expect(onFailed).toHaveBeenCalledWith('batch-1');
    });

    it('handles REFUNDED status — notifies failure', async () => {
      setupBalance(store);
      const onFailed = vi.fn();
      const mockConnector = createMockConnector({
        getStatus: vi.fn().mockResolvedValue({
          status: 'DONE', substatus: 'REFUNDED',
          receiving: { amount: '0' },
        }),
      });

      const executor = new FundingBridgeExecutor(
        mockConnector, createMockHyperliquidConnector(),
        createMockApprovalHandler(), createMockTransactionExecutor(),
        createMockPreFlightChecker(), store, defaultConfig,
        { onFailed },
      );

      const result = await executor.execute(makeFundingAction());
      expect(result.success).toBe(true);
      expect(result.metadata.substatus).toBe('REFUNDED');
      expect(onFailed).toHaveBeenCalledWith('batch-1');
    });

    it('handles Hyperliquid deposit failure gracefully', async () => {
      setupBalance(store);
      const mockHl = createMockHyperliquidConnector({
        depositToMargin: vi.fn().mockRejectedValue(new Error('Deposit failed')),
      });
      const onFailed = vi.fn();

      const executor = new FundingBridgeExecutor(
        createMockConnector(), mockHl,
        createMockApprovalHandler(), createMockTransactionExecutor(),
        createMockPreFlightChecker(), store, defaultConfig,
        { onFailed },
      );

      const result = await executor.execute(makeFundingAction());
      expect(result.success).toBe(true);
      expect(result.metadata.depositFailed).toBe(true);
      expect(onFailed).toHaveBeenCalledWith('batch-1');
    });

    it('skips deposit when depositToHyperliquid is false', async () => {
      setupBalance(store);
      const mockHl = createMockHyperliquidConnector();

      const executor = new FundingBridgeExecutor(
        createMockConnector(), mockHl,
        createMockApprovalHandler(), createMockTransactionExecutor(),
        createMockPreFlightChecker(), store, defaultConfig,
      );

      const result = await executor.execute(makeFundingAction({ depositToHyperliquid: false }));
      expect(result.success).toBe(true);
      expect(mockHl.depositToMargin).not.toHaveBeenCalled();
    });
  });
});
