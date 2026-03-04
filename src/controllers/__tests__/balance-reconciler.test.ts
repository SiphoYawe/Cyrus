import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BalanceReconciler } from '../balance-reconciler.js';
import type {
  BalanceReconcilerConfig,
  EvmBalanceFetcher,
  ReconciliationNotifier,
} from '../balance-reconciler.js';
import type { HyperliquidConnectorInterface } from '../../connectors/hyperliquid-connector.js';
import { Store } from '../../core/store.js';
import { chainId, tokenAddress } from '../../core/types.js';
import { CHAINS, USDC_ADDRESSES } from '../../core/constants.js';

// --- Mock factories ---

function createMockHyperliquidConnector(
  overrides: Partial<HyperliquidConnectorInterface> = {},
): HyperliquidConnectorInterface {
  return {
    queryBalance: vi.fn().mockResolvedValue({
      totalMarginUsed: 200, totalNtlPos: 500, totalRawUsd: 1000, withdrawable: 800,
      crossMarginSummary: { accountValue: 1000, totalMarginUsed: 200, totalNtlPos: 500 },
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

function createMockEvmFetcher(
  overrides: Partial<EvmBalanceFetcher> = {},
): EvmBalanceFetcher {
  return {
    fetchUsdcBalance: vi.fn().mockResolvedValue(1_000_000n), // 1 USDC default
    ...overrides,
  };
}

function createMockNotifier(): ReconciliationNotifier & { broadcast: ReturnType<typeof vi.fn> } {
  return { broadcast: vi.fn() };
}

const WALLET_ADDRESS = '0xwallet0000000000000000000000000000000001';

const defaultConfig: Partial<BalanceReconcilerConfig> = {
  trackedChains: [CHAINS.ETHEREUM, CHAINS.ARBITRUM],
  reconcileIntervalTicks: 1,
  timeoutMs: 5000,
  discrepancyThreshold: 0.01, // 1%
};

describe('BalanceReconciler', () => {
  let store: Store;

  beforeEach(() => {
    Store.getInstance().reset();
    store = Store.getInstance();
  });

  describe('reconcile interval', () => {
    it('runs on every tick when interval is 1', async () => {
      const fetcher = createMockEvmFetcher();
      const reconciler = new BalanceReconciler(
        store, createMockHyperliquidConnector(), fetcher,
        WALLET_ADDRESS, defaultConfig,
      );

      // Set store balances to match so no discrepancy
      for (const chain of defaultConfig.trackedChains!) {
        const addr = USDC_ADDRESSES[chain as number];
        if (addr) store.setBalance(chain, addr, 1_000_000n, 1, 'USDC', 6);
      }

      const report = await reconciler.reconcile();
      expect(report).not.toBeNull();
      expect(reconciler.getTickCount()).toBe(1);
    });

    it('skips non-interval ticks', async () => {
      const fetcher = createMockEvmFetcher();
      const reconciler = new BalanceReconciler(
        store, createMockHyperliquidConnector(), fetcher,
        WALLET_ADDRESS, { ...defaultConfig, reconcileIntervalTicks: 3 },
      );

      // Tick 1 — skip
      const r1 = await reconciler.reconcile();
      expect(r1).toBeNull();

      // Tick 2 — skip
      const r2 = await reconciler.reconcile();
      expect(r2).toBeNull();

      // Tick 3 — run
      const r3 = await reconciler.reconcile();
      expect(r3).not.toBeNull();
      expect(reconciler.getTickCount()).toBe(3);
    });
  });

  describe('EVM chain reconciliation', () => {
    it('detects no discrepancy when balances match', async () => {
      const ethUsdc = USDC_ADDRESSES[CHAINS.ETHEREUM as number];
      const arbUsdc = USDC_ADDRESSES[CHAINS.ARBITRUM as number];
      store.setBalance(CHAINS.ETHEREUM, ethUsdc, 1_000_000n, 1, 'USDC', 6);
      store.setBalance(CHAINS.ARBITRUM, arbUsdc, 1_000_000n, 1, 'USDC', 6);

      const fetcher = createMockEvmFetcher({
        fetchUsdcBalance: vi.fn().mockResolvedValue(1_000_000n),
      });
      // HL returns 1 USDC (matching Arbitrum store balance) to avoid HL discrepancy
      const hlConnector = createMockHyperliquidConnector({
        queryBalance: vi.fn().mockResolvedValue({
          totalMarginUsed: 0, totalNtlPos: 0, totalRawUsd: 1, withdrawable: 1,
          crossMarginSummary: { accountValue: 1, totalMarginUsed: 0, totalNtlPos: 0 },
        }),
      });
      const reconciler = new BalanceReconciler(
        store, hlConnector, fetcher,
        WALLET_ADDRESS, defaultConfig,
      );

      const report = await reconciler.reconcile();
      expect(report).not.toBeNull();
      expect(report!.discrepancies.length).toBe(0);
    });

    it('detects discrepancy above threshold', async () => {
      const ethUsdc = USDC_ADDRESSES[CHAINS.ETHEREUM as number];
      const arbUsdc = USDC_ADDRESSES[CHAINS.ARBITRUM as number];
      // Store has 1 USDC, on-chain has 1.5 USDC → 50% discrepancy → above 1% threshold
      store.setBalance(CHAINS.ETHEREUM, ethUsdc, 1_000_000n, 1, 'USDC', 6);
      store.setBalance(CHAINS.ARBITRUM, arbUsdc, 1_000_000n, 1, 'USDC', 6);

      const fetcher = createMockEvmFetcher({
        fetchUsdcBalance: vi.fn().mockImplementation(async (chain) => {
          if (chain === CHAINS.ETHEREUM) return 1_500_000n; // 50% more
          return 1_000_000n; // match
        }),
      });

      const reconciler = new BalanceReconciler(
        store, createMockHyperliquidConnector(), fetcher,
        WALLET_ADDRESS, defaultConfig,
      );

      const report = await reconciler.reconcile();
      expect(report).not.toBeNull();
      const evmDiscrepancies = report!.discrepancies.filter((d) => d.venue === 'evm');
      expect(evmDiscrepancies.length).toBe(1);
      expect(evmDiscrepancies[0].chainId).toBe(CHAINS.ETHEREUM);
      expect(evmDiscrepancies[0].delta).toBe(500_000n);
    });

    it('ignores discrepancy within threshold', async () => {
      const ethUsdc = USDC_ADDRESSES[CHAINS.ETHEREUM as number];
      const arbUsdc = USDC_ADDRESSES[CHAINS.ARBITRUM as number];
      // 0.5% difference (within 1% threshold)
      store.setBalance(CHAINS.ETHEREUM, ethUsdc, 1_000_000n, 1, 'USDC', 6);
      store.setBalance(CHAINS.ARBITRUM, arbUsdc, 1_000_000n, 1, 'USDC', 6);

      const fetcher = createMockEvmFetcher({
        fetchUsdcBalance: vi.fn().mockImplementation(async (chain) => {
          if (chain === CHAINS.ETHEREUM) return 1_005_000n; // 0.5% more
          return 1_000_000n;
        }),
      });

      // HL returns 1 USDC to match Arbitrum store balance
      const hlConnector = createMockHyperliquidConnector({
        queryBalance: vi.fn().mockResolvedValue({
          totalMarginUsed: 0, totalNtlPos: 0, totalRawUsd: 1, withdrawable: 1,
          crossMarginSummary: { accountValue: 1, totalMarginUsed: 0, totalNtlPos: 0 },
        }),
      });

      const reconciler = new BalanceReconciler(
        store, hlConnector, fetcher,
        WALLET_ADDRESS, defaultConfig,
      );

      const report = await reconciler.reconcile();
      expect(report).not.toBeNull();
      expect(report!.discrepancies.length).toBe(0);
    });

    it('skips chains where EVM fetch fails', async () => {
      const arbUsdc = USDC_ADDRESSES[CHAINS.ARBITRUM as number];
      store.setBalance(CHAINS.ARBITRUM, arbUsdc, 1_000_000n, 1, 'USDC', 6);

      const fetcher = createMockEvmFetcher({
        fetchUsdcBalance: vi.fn().mockImplementation(async (chain) => {
          if (chain === CHAINS.ETHEREUM) throw new Error('RPC timeout');
          return 1_000_000n;
        }),
      });

      const reconciler = new BalanceReconciler(
        store, createMockHyperliquidConnector(), fetcher,
        WALLET_ADDRESS, defaultConfig,
      );

      const report = await reconciler.reconcile();
      expect(report).not.toBeNull();
      expect(fetcher.fetchUsdcBalance).toHaveBeenCalledTimes(2);
      // Ethereum failed so only Arbitrum EVM + HL reconciled (2 chains, not 3)
      expect(report!.chainsReconciled).toBe(2); // Arbitrum EVM + Hyperliquid
    });
  });

  describe('Hyperliquid reconciliation', () => {
    it('includes Hyperliquid value in totalPortfolioValue', async () => {
      const arbUsdc = USDC_ADDRESSES[CHAINS.ARBITRUM as number];
      store.setBalance(CHAINS.ARBITRUM, arbUsdc, 1_000_000_000n, 1000, 'USDC', 6);

      const hlConnector = createMockHyperliquidConnector({
        queryBalance: vi.fn().mockResolvedValue({
          totalMarginUsed: 0, totalNtlPos: 0, totalRawUsd: 500, withdrawable: 500,
          crossMarginSummary: { accountValue: 500, totalMarginUsed: 0, totalNtlPos: 0 },
        }),
      });

      const fetcher = createMockEvmFetcher({
        fetchUsdcBalance: vi.fn().mockResolvedValue(1_000_000n),
      });

      const reconciler = new BalanceReconciler(
        store, hlConnector, fetcher,
        WALLET_ADDRESS, { ...defaultConfig, trackedChains: [CHAINS.ETHEREUM] },
      );

      store.setBalance(CHAINS.ETHEREUM, USDC_ADDRESSES[CHAINS.ETHEREUM as number], 1_000_000n, 1, 'USDC', 6);

      const report = await reconciler.reconcile();
      expect(report).not.toBeNull();
      // EVM: 1_000_000 + HL: 500 * 1_000_000 = 500_000_000
      expect(report!.totalPortfolioValue).toBe(1_000_000n + 500_000_000n);
    });

    it('skips Hyperliquid when queryBalance fails', async () => {
      const hlConnector = createMockHyperliquidConnector({
        queryBalance: vi.fn().mockRejectedValue(new Error('HL API down')),
      });

      const fetcher = createMockEvmFetcher({
        fetchUsdcBalance: vi.fn().mockResolvedValue(1_000_000n),
      });

      for (const chain of defaultConfig.trackedChains!) {
        const addr = USDC_ADDRESSES[chain as number];
        if (addr) store.setBalance(chain, addr, 1_000_000n, 1, 'USDC', 6);
      }

      const reconciler = new BalanceReconciler(
        store, hlConnector, fetcher,
        WALLET_ADDRESS, defaultConfig,
      );

      const report = await reconciler.reconcile();
      expect(report).not.toBeNull();
      expect(report!.chainsSkipped).toBe(1);
    });

    it('includes unrealizedPnl in Hyperliquid value', async () => {
      const hlConnector = createMockHyperliquidConnector({
        queryBalance: vi.fn().mockResolvedValue({
          totalMarginUsed: 100, totalNtlPos: 300, totalRawUsd: 1000, withdrawable: 500,
          crossMarginSummary: { accountValue: 800, totalMarginUsed: 100, totalNtlPos: 300 },
        }),
        queryPositions: vi.fn().mockResolvedValue([
          { unrealizedPnl: '50.5' },
          { unrealizedPnl: '-10.0' },
        ]),
      });

      // accountValue=800, unrealizedPnl=40.5 → total=840.5 → 840_500_000n
      const arbUsdc = USDC_ADDRESSES[CHAINS.ARBITRUM as number];
      store.setBalance(CHAINS.ARBITRUM, arbUsdc, 840_500_000n, 840.5, 'USDC', 6);

      const fetcher = createMockEvmFetcher({
        fetchUsdcBalance: vi.fn().mockResolvedValue(840_500_000n),
      });

      const reconciler = new BalanceReconciler(
        store, hlConnector, fetcher,
        WALLET_ADDRESS, { ...defaultConfig, trackedChains: [] },
      );

      const report = await reconciler.reconcile();
      expect(report).not.toBeNull();
      // 800 + 40.5 = 840.5 → 840_500_000n
      expect(report!.totalPortfolioValue).toBe(840_500_000n);
    });
  });

  describe('discrepancy handling', () => {
    it('corrects store balance to on-chain truth', async () => {
      const ethUsdc = USDC_ADDRESSES[CHAINS.ETHEREUM as number];
      // Store: 1 USDC, on-chain: 2 USDC
      store.setBalance(CHAINS.ETHEREUM, ethUsdc, 1_000_000n, 1, 'USDC', 6);

      const fetcher = createMockEvmFetcher({
        fetchUsdcBalance: vi.fn().mockImplementation(async (chain) => {
          if (chain === CHAINS.ETHEREUM) return 2_000_000n;
          return 0n;
        }),
      });

      const reconciler = new BalanceReconciler(
        store, createMockHyperliquidConnector(), fetcher,
        WALLET_ADDRESS, { ...defaultConfig, trackedChains: [CHAINS.ETHEREUM] },
      );

      await reconciler.reconcile();

      // Store should now reflect on-chain truth
      const updated = store.getBalance(CHAINS.ETHEREUM, ethUsdc);
      expect(updated).toBeDefined();
      expect(updated!.amount).toBe(2_000_000n);
    });

    it('sends WebSocket notification on discrepancy', async () => {
      const ethUsdc = USDC_ADDRESSES[CHAINS.ETHEREUM as number];
      store.setBalance(CHAINS.ETHEREUM, ethUsdc, 1_000_000n, 1, 'USDC', 6);

      const fetcher = createMockEvmFetcher({
        fetchUsdcBalance: vi.fn().mockImplementation(async (chain) => {
          if (chain === CHAINS.ETHEREUM) return 2_000_000n;
          return 0n;
        }),
      });

      // Zero-value HL to isolate EVM discrepancy
      const hlConnector = createMockHyperliquidConnector({
        queryBalance: vi.fn().mockResolvedValue({
          totalMarginUsed: 0, totalNtlPos: 0, totalRawUsd: 0, withdrawable: 0,
          crossMarginSummary: { accountValue: 0, totalMarginUsed: 0, totalNtlPos: 0 },
        }),
      });

      const notifier = createMockNotifier();
      const reconciler = new BalanceReconciler(
        store, hlConnector, fetcher,
        WALLET_ADDRESS, { ...defaultConfig, trackedChains: [CHAINS.ETHEREUM] },
        notifier,
      );

      await reconciler.reconcile();

      expect(notifier.broadcast).toHaveBeenCalledTimes(1);
      const envelope = notifier.broadcast.mock.calls[0][0];
      expect(envelope.event).toBe('balance_discrepancy');
      expect(envelope.data).toHaveLength(1);
    });

    it('does not notify when no discrepancy', async () => {
      const ethUsdc = USDC_ADDRESSES[CHAINS.ETHEREUM as number];
      store.setBalance(CHAINS.ETHEREUM, ethUsdc, 1_000_000n, 1, 'USDC', 6);

      const fetcher = createMockEvmFetcher({
        fetchUsdcBalance: vi.fn().mockResolvedValue(1_000_000n),
      });

      // Zero-value HL so no HL discrepancy
      const hlConnector = createMockHyperliquidConnector({
        queryBalance: vi.fn().mockResolvedValue({
          totalMarginUsed: 0, totalNtlPos: 0, totalRawUsd: 0, withdrawable: 0,
          crossMarginSummary: { accountValue: 0, totalMarginUsed: 0, totalNtlPos: 0 },
        }),
      });

      const notifier = createMockNotifier();
      const reconciler = new BalanceReconciler(
        store, hlConnector, fetcher,
        WALLET_ADDRESS, { ...defaultConfig, trackedChains: [CHAINS.ETHEREUM] },
        notifier,
      );

      await reconciler.reconcile();
      expect(notifier.broadcast).not.toHaveBeenCalled();
    });
  });

  describe('in-flight exclusion', () => {
    it('excludes in-flight transfer amounts from comparison', async () => {
      const ethUsdc = USDC_ADDRESSES[CHAINS.ETHEREUM as number];
      // Store has 2 USDC, on-chain has 1 USDC
      // But 1 USDC is in-flight FROM Ethereum → adjusted store = 2 - 1 = 1 → matches on-chain
      store.setBalance(CHAINS.ETHEREUM, ethUsdc, 2_000_000n, 2, 'USDC', 6);

      // Create an in-flight transfer from Ethereum
      store.createTransfer({
        txHash: '0xinflight',
        fromChain: CHAINS.ETHEREUM,
        toChain: CHAINS.ARBITRUM,
        fromToken: ethUsdc,
        toToken: USDC_ADDRESSES[CHAINS.ARBITRUM as number],
        amount: 1_000_000n,
        bridge: 'stargate',
        quoteData: {},
      });

      const fetcher = createMockEvmFetcher({
        fetchUsdcBalance: vi.fn().mockImplementation(async (chain) => {
          if (chain === CHAINS.ETHEREUM) return 1_000_000n;
          return 0n;
        }),
      });

      const reconciler = new BalanceReconciler(
        store, createMockHyperliquidConnector(), fetcher,
        WALLET_ADDRESS, { ...defaultConfig, trackedChains: [CHAINS.ETHEREUM] },
      );

      const report = await reconciler.reconcile();
      expect(report).not.toBeNull();
      // In-flight deduction makes adjusted store match on-chain → no discrepancy
      const evmDisc = report!.discrepancies.filter((d) => d.venue === 'evm');
      expect(evmDisc.length).toBe(0);
    });
  });

  describe('timeout', () => {
    it('returns null when reconciliation times out', async () => {
      const fetcher = createMockEvmFetcher({
        fetchUsdcBalance: vi.fn().mockImplementation(
          () => new Promise((resolve) => setTimeout(() => resolve(1_000_000n), 200)),
        ),
      });

      const reconciler = new BalanceReconciler(
        store, createMockHyperliquidConnector(), fetcher,
        WALLET_ADDRESS, { ...defaultConfig, timeoutMs: 50 },
      );

      const report = await reconciler.reconcile();
      expect(report).toBeNull();
    });
  });

  describe('report accessors', () => {
    it('stores last report and timestamp', async () => {
      for (const chain of defaultConfig.trackedChains!) {
        const addr = USDC_ADDRESSES[chain as number];
        if (addr) store.setBalance(chain, addr, 1_000_000n, 1, 'USDC', 6);
      }

      const reconciler = new BalanceReconciler(
        store, createMockHyperliquidConnector(),
        createMockEvmFetcher(), WALLET_ADDRESS, defaultConfig,
      );

      expect(reconciler.getLastReport()).toBeNull();
      expect(reconciler.getLastReconciliationTimestamp()).toBe(0);

      await reconciler.reconcile();

      expect(reconciler.getLastReport()).not.toBeNull();
      expect(reconciler.getLastReconciliationTimestamp()).toBeGreaterThan(0);
    });

    it('tracks largestDiscrepancyPct in report', async () => {
      const ethUsdc = USDC_ADDRESSES[CHAINS.ETHEREUM as number];
      const arbUsdc = USDC_ADDRESSES[CHAINS.ARBITRUM as number];
      store.setBalance(CHAINS.ETHEREUM, ethUsdc, 1_000_000n, 1, 'USDC', 6);
      store.setBalance(CHAINS.ARBITRUM, arbUsdc, 1_000_000n, 1, 'USDC', 6);

      const fetcher = createMockEvmFetcher({
        fetchUsdcBalance: vi.fn().mockImplementation(async (chain) => {
          if (chain === CHAINS.ETHEREUM) return 1_200_000n; // 20% more
          if (chain === CHAINS.ARBITRUM) return 1_100_000n; // ~10% more
          return 1_000_000n;
        }),
      });

      const reconciler = new BalanceReconciler(
        store, createMockHyperliquidConnector(), fetcher,
        WALLET_ADDRESS, defaultConfig,
      );

      const report = await reconciler.reconcile();
      expect(report).not.toBeNull();
      // Largest discrepancy should be ~16.67% (200_000/1_200_000 * 100)
      expect(report!.largestDiscrepancyPct).toBeGreaterThan(10);
    });
  });

  describe('config validation', () => {
    it('throws when reconcileIntervalTicks is 0', () => {
      expect(() => new BalanceReconciler(
        store, createMockHyperliquidConnector(), createMockEvmFetcher(),
        WALLET_ADDRESS, { ...defaultConfig, reconcileIntervalTicks: 0 },
      )).toThrow('reconcileIntervalTicks must be >= 1');
    });

    it('throws when reconcileIntervalTicks is negative', () => {
      expect(() => new BalanceReconciler(
        store, createMockHyperliquidConnector(), createMockEvmFetcher(),
        WALLET_ADDRESS, { ...defaultConfig, reconcileIntervalTicks: -1 },
      )).toThrow('reconcileIntervalTicks must be >= 1');
    });
  });
});
