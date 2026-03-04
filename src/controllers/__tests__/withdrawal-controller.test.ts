import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WithdrawalController } from '../withdrawal-controller.js';
import type { WithdrawalControllerConfig, WithdrawalRequest } from '../withdrawal-controller.js';
import type { HyperliquidConnectorInterface } from '../../connectors/hyperliquid-connector.js';
import { Store } from '../../core/store.js';
import { ActionQueue } from '../../core/action-queue.js';
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

const defaultConfig: Partial<WithdrawalControllerConfig> = {
  tickIntervalMs: 100,
  minWithdrawalAmount: 10_000_000n, // 10 USDC
  marginSafetyBuffer: 0.20,
  maxWithdrawalPerDay: 1_000_000_000n, // 1000 USDC
};

function makeRequest(overrides: Partial<WithdrawalRequest> = {}): WithdrawalRequest {
  return {
    amount: 100_000_000n, // 100 USDC
    targetChainId: CHAINS.ETHEREUM,
    targetToken: USDC_ADDRESSES[CHAINS.ETHEREUM as number],
    reason: 'profit-taking',
    ...overrides,
  };
}

describe('WithdrawalController', () => {
  let store: Store;
  let queue: ActionQueue;

  beforeEach(() => {
    Store.getInstance().reset();
    store = Store.getInstance();
    queue = new ActionQueue();
  });

  describe('evaluateWithdrawal', () => {
    it('approves valid withdrawal within safe limits', async () => {
      const hlConnector = createMockHyperliquidConnector();
      const controller = new WithdrawalController(store, queue, hlConnector, defaultConfig);

      const plan = await controller.evaluateWithdrawal(makeRequest());
      expect(plan).not.toBeNull();
      expect(plan!.amount).toBe(100_000_000n);
      expect(plan!.targetChainId).toBe(CHAINS.ETHEREUM);
    });

    it('rejects when amount below minimum', async () => {
      const hlConnector = createMockHyperliquidConnector();
      const controller = new WithdrawalController(store, queue, hlConnector, defaultConfig);

      const plan = await controller.evaluateWithdrawal(
        makeRequest({ amount: 5_000_000n }), // 5 USDC < 10 USDC min
      );
      expect(plan).toBeNull();
    });

    it('rejects unsupported target chain', async () => {
      const hlConnector = createMockHyperliquidConnector();
      const controller = new WithdrawalController(store, queue, hlConnector, defaultConfig);

      const plan = await controller.evaluateWithdrawal(
        makeRequest({ targetChainId: chainId(99999) }),
      );
      expect(plan).toBeNull();
    });

    it('rejects when amount exceeds safe margin limit', async () => {
      // Set withdrawable to only 100 USDC, but margin used is 80, so safety buffer = 16
      // Safe max = 100 - 16 = 84 USDC; requesting 100 should fail
      const hlConnector = createMockHyperliquidConnector({
        queryBalance: vi.fn().mockResolvedValue({
          totalMarginUsed: 80, totalNtlPos: 200, totalRawUsd: 200, withdrawable: 100,
          crossMarginSummary: { accountValue: 200, totalMarginUsed: 80, totalNtlPos: 200 },
        }),
      });
      const controller = new WithdrawalController(store, queue, hlConnector, defaultConfig);

      const plan = await controller.evaluateWithdrawal(
        makeRequest({ amount: 100_000_000n }), // 100 USDC > 84 USDC safe max
      );
      expect(plan).toBeNull();
    });

    it('enforces daily withdrawal limit', async () => {
      const hlConnector = createMockHyperliquidConnector();
      const controller = new WithdrawalController(store, queue, hlConnector, {
        ...defaultConfig,
        maxWithdrawalPerDay: 150_000_000n, // 150 USDC daily limit
      });

      // First withdrawal of 100 USDC should pass
      const plan1 = await controller.evaluateWithdrawal(makeRequest({ amount: 100_000_000n }));
      expect(plan1).not.toBeNull();

      // Submit the action to update daily counter
      controller.requestWithdrawal(makeRequest({ amount: 100_000_000n }));
      await controller.controlTask();

      // Second withdrawal of 100 USDC should fail (total 200 > 150 limit)
      const plan2 = await controller.evaluateWithdrawal(makeRequest({ amount: 100_000_000n }));
      expect(plan2).toBeNull();
    });
  });

  describe('controlTask', () => {
    it('skips when no pending requests', async () => {
      const hlConnector = createMockHyperliquidConnector();
      const controller = new WithdrawalController(store, queue, hlConnector, defaultConfig);
      await controller.controlTask();

      expect(queue.isEmpty()).toBe(true);
    });

    it('enqueues withdrawal action for valid request', async () => {
      const hlConnector = createMockHyperliquidConnector();
      const controller = new WithdrawalController(store, queue, hlConnector, defaultConfig);

      controller.requestWithdrawal(makeRequest());
      await controller.controlTask();

      expect(queue.isEmpty()).toBe(false);
      const action = queue.dequeue();
      expect(action).toBeDefined();
      expect(action!.type).toBe('withdrawal');
    });

    it('removes invalid request from queue', async () => {
      const hlConnector = createMockHyperliquidConnector();
      const controller = new WithdrawalController(store, queue, hlConnector, defaultConfig);

      controller.requestWithdrawal(makeRequest({ amount: 1n })); // Below minimum
      await controller.controlTask();

      expect(queue.isEmpty()).toBe(true);
      expect(controller.getPendingRequests().length).toBe(0);
    });
  });

  describe('requestWithdrawal', () => {
    it('adds request to pending queue', () => {
      const hlConnector = createMockHyperliquidConnector();
      const controller = new WithdrawalController(store, queue, hlConnector, defaultConfig);

      controller.requestWithdrawal(makeRequest());
      expect(controller.getPendingRequests().length).toBe(1);
    });
  });
});
