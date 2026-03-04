import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WithdrawalExecutor, WITHDRAWAL_PHASES } from './withdrawal-executor.js';
import type { WithdrawalExecutorConfig } from './withdrawal-executor.js';
import type { ApprovalHandler } from './approval-handler.js';
import type { TransactionExecutor, TransactionResult } from './transaction-executor.js';
import type { PreFlightChecker, PreFlightResult } from './pre-flight-checks.js';
import type { LiFiConnectorInterface, QuoteResult } from '../connectors/types.js';
import type { HyperliquidConnectorInterface } from '../connectors/hyperliquid-connector.js';
import { Store } from '../core/store.js';
import type { WithdrawalAction } from '../core/action-types.js';
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
      chainId: 42161,
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
      fromChainId: 42161,
      toChainId: 1,
      fromToken: { address: USDC_ADDRESSES[CHAINS.ARBITRUM as number] },
      toToken: { address: USDC_ADDRESSES[CHAINS.ETHEREUM as number] },
      fromAmount: '1000000',
    },
  };
}

function createMockTxResult(overrides: Partial<TransactionResult> = {}): TransactionResult {
  return {
    txHash: '0xtxhash000000000000000000000000000000000000000000000000000000cd',
    chainId: 42161,
    blockNumber: 200000000n,
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
      receiving: { amount: '990000', token: { address: USDC_ADDRESSES[CHAINS.ETHEREUM as number] } },
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
      totalMarginUsed: 0, totalNtlPos: 0, totalRawUsd: 1000, withdrawable: 1000,
      crossMarginSummary: { accountValue: 1000, totalMarginUsed: 0, totalNtlPos: 0 },
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

const TARGET_CHAIN = CHAINS.ETHEREUM;
const TARGET_TOKEN = USDC_ADDRESSES[TARGET_CHAIN as number];

function makeWithdrawalAction(overrides: Partial<WithdrawalAction> = {}): WithdrawalAction {
  return {
    id: 'withdrawal-1',
    type: 'withdrawal',
    priority: 7,
    createdAt: Date.now(),
    strategyId: 'withdrawal-controller',
    amount: 1_000_000n, // 1 USDC
    targetChainId: TARGET_CHAIN,
    targetToken: TARGET_TOKEN,
    reason: 'profit-taking',
    metadata: {},
    ...overrides,
  };
}

const defaultConfig: Partial<WithdrawalExecutorConfig> = {
  bridgePollIntervalMs: 0,      // instant polling for tests
  withdrawalPollIntervalMs: 0,  // instant for tests
  withdrawalTimeoutMs: 1000,    // 1s timeout for tests
};

describe('WithdrawalExecutor', () => {
  let store: Store;

  beforeEach(() => {
    Store.getInstance().reset();
    store = Store.getInstance();
  });

  describe('canHandle', () => {
    it('returns true for withdrawal action', () => {
      const executor = new WithdrawalExecutor(
        createMockConnector(), createMockHyperliquidConnector(),
        createMockApprovalHandler(), createMockTransactionExecutor(),
        createMockPreFlightChecker(), store, defaultConfig,
      );
      expect(executor.canHandle(makeWithdrawalAction())).toBe(true);
    });

    it('returns false for bridge action', () => {
      const executor = new WithdrawalExecutor(
        createMockConnector(), createMockHyperliquidConnector(),
        createMockApprovalHandler(), createMockTransactionExecutor(),
        createMockPreFlightChecker(), store, defaultConfig,
      );
      expect(executor.canHandle({ ...makeWithdrawalAction(), type: 'bridge' } as any)).toBe(false);
    });
  });

  describe('trigger stage', () => {
    it('rejects zero amount', async () => {
      const executor = new WithdrawalExecutor(
        createMockConnector(), createMockHyperliquidConnector(),
        createMockApprovalHandler(), createMockTransactionExecutor(),
        createMockPreFlightChecker(), store, defaultConfig,
      );

      const result = await executor.execute(makeWithdrawalAction({ amount: 0n }));
      expect(result.success).toBe(false);
      expect(result.error).toContain('positive');
    });

    it('rejects unsupported target chain', async () => {
      const executor = new WithdrawalExecutor(
        createMockConnector(), createMockHyperliquidConnector(),
        createMockApprovalHandler(), createMockTransactionExecutor(),
        createMockPreFlightChecker(), store, defaultConfig,
      );

      const result = await executor.execute(makeWithdrawalAction({ targetChainId: chainId(99999) }));
      expect(result.success).toBe(false);
      expect(result.error).toContain('No USDC address');
    });

    it('passes with valid parameters', async () => {
      const executor = new WithdrawalExecutor(
        createMockConnector(), createMockHyperliquidConnector(),
        createMockApprovalHandler(), createMockTransactionExecutor(),
        createMockPreFlightChecker(), store, defaultConfig,
      );

      const result = await executor.execute(makeWithdrawalAction());
      expect(result.success).toBe(true);
    });
  });

  describe('open stage — Hyperliquid withdrawal', () => {
    it('calls withdrawFromMargin with formatted amount', async () => {
      const mockHl = createMockHyperliquidConnector();
      const executor = new WithdrawalExecutor(
        createMockConnector(), mockHl,
        createMockApprovalHandler(), createMockTransactionExecutor(),
        createMockPreFlightChecker(), store, defaultConfig,
      );

      await executor.execute(makeWithdrawalAction({ amount: 1_500_000n }));
      expect(mockHl.withdrawFromMargin).toHaveBeenCalledWith('1.5');
    });

    it('handles Hyperliquid withdrawal rejection', async () => {
      const mockHl = createMockHyperliquidConnector({
        withdrawFromMargin: vi.fn().mockResolvedValue(false),
      });
      const executor = new WithdrawalExecutor(
        createMockConnector(), mockHl,
        createMockApprovalHandler(), createMockTransactionExecutor(),
        createMockPreFlightChecker(), store, defaultConfig,
      );

      const result = await executor.execute(makeWithdrawalAction());
      expect(result.success).toBe(false);
      expect(result.error).toContain('rejected');
    });

    it('creates InFlightTransfer on successful withdrawal', async () => {
      const executor = new WithdrawalExecutor(
        createMockConnector(), createMockHyperliquidConnector(),
        createMockApprovalHandler(), createMockTransactionExecutor(),
        createMockPreFlightChecker(), store, defaultConfig,
      );

      await executor.execute(makeWithdrawalAction());
      // Verify a completed transfer was recorded
      const completed = store.getCompletedTransfers();
      expect(completed.length).toBeGreaterThan(0);
    });
  });

  describe('manage stage — bridge execution', () => {
    it('handles full happy path: withdrawal → bridge → COMPLETED', async () => {
      const mockConnector = createMockConnector();
      const executor = new WithdrawalExecutor(
        mockConnector, createMockHyperliquidConnector(),
        createMockApprovalHandler(), createMockTransactionExecutor(),
        createMockPreFlightChecker(), store, defaultConfig,
      );

      const result = await executor.execute(makeWithdrawalAction());
      expect(result.success).toBe(true);
      expect(result.metadata.status).toBe('DONE');
      expect(result.metadata.substatus).toBe('COMPLETED');
      expect(mockConnector.getQuote).toHaveBeenCalledTimes(1);
    });

    it('handles FAILED bridge status', async () => {
      const mockConnector = createMockConnector({
        getStatus: vi.fn().mockResolvedValue({ status: 'FAILED' }),
      });

      // Set up Arbitrum balance so the close stage can update it
      store.setBalance(
        CHAINS.ARBITRUM,
        USDC_ADDRESSES[CHAINS.ARBITRUM as number],
        0n, 0, 'USDC', 6,
      );

      const executor = new WithdrawalExecutor(
        mockConnector, createMockHyperliquidConnector(),
        createMockApprovalHandler(), createMockTransactionExecutor(),
        createMockPreFlightChecker(), store, defaultConfig,
      );

      const result = await executor.execute(makeWithdrawalAction());
      expect(result.success).toBe(true);
      expect(result.metadata.status).toBe('FAILED');

      // Verify Arbitrum balance was updated (USDC stays there)
      const arbBalance = store.getBalance(
        CHAINS.ARBITRUM,
        USDC_ADDRESSES[CHAINS.ARBITRUM as number],
      );
      expect(arbBalance).toBeDefined();
      expect(arbBalance!.amount).toBe(1_000_000n); // Withdrawn amount added to Arbitrum
    });

    it('handles REFUNDED bridge status', async () => {
      const mockConnector = createMockConnector({
        getStatus: vi.fn().mockResolvedValue({
          status: 'DONE', substatus: 'REFUNDED',
          receiving: { amount: '0' },
        }),
      });

      const executor = new WithdrawalExecutor(
        mockConnector, createMockHyperliquidConnector(),
        createMockApprovalHandler(), createMockTransactionExecutor(),
        createMockPreFlightChecker(), store, defaultConfig,
      );

      const result = await executor.execute(makeWithdrawalAction());
      expect(result.success).toBe(true);
      expect(result.metadata.substatus).toBe('REFUNDED');
    });

    it('handles PARTIAL bridge status', async () => {
      const mockConnector = createMockConnector({
        getStatus: vi.fn().mockResolvedValue({
          status: 'DONE', substatus: 'PARTIAL',
          receiving: { amount: '500000', token: { address: TARGET_TOKEN as string } },
        }),
      });

      const executor = new WithdrawalExecutor(
        mockConnector, createMockHyperliquidConnector(),
        createMockApprovalHandler(), createMockTransactionExecutor(),
        createMockPreFlightChecker(), store, defaultConfig,
      );

      const result = await executor.execute(makeWithdrawalAction());
      expect(result.success).toBe(true);
      expect(result.metadata.substatus).toBe('PARTIAL');
    });

    it('handles NOT_FOUND → PENDING → DONE transitions', async () => {
      const mockConnector = createMockConnector({
        getStatus: vi.fn()
          .mockResolvedValueOnce({ status: 'NOT_FOUND' })
          .mockResolvedValueOnce({ status: 'PENDING' })
          .mockResolvedValueOnce({
            status: 'DONE', substatus: 'COMPLETED',
            receiving: { amount: '990000', token: { address: TARGET_TOKEN } },
          }),
      });

      const executor = new WithdrawalExecutor(
        mockConnector, createMockHyperliquidConnector(),
        createMockApprovalHandler(), createMockTransactionExecutor(),
        createMockPreFlightChecker(), store, defaultConfig,
      );

      const result = await executor.execute(makeWithdrawalAction());
      expect(result.success).toBe(true);
      expect(mockConnector.getStatus).toHaveBeenCalledTimes(3);
    });
  });

  describe('phase tracking', () => {
    it('tracks phase through successful execution', async () => {
      const executor = new WithdrawalExecutor(
        createMockConnector(), createMockHyperliquidConnector(),
        createMockApprovalHandler(), createMockTransactionExecutor(),
        createMockPreFlightChecker(), store, defaultConfig,
      );

      expect(executor.getPhase()).toBe(WITHDRAWAL_PHASES.TRIGGER);
      await executor.execute(makeWithdrawalAction());
      expect(executor.getPhase()).toBe(WITHDRAWAL_PHASES.BRIDGE_COMPLETE);
    });
  });
});
