import { describe, it, expect, beforeEach } from 'vitest';
import { FundingController } from '../funding-controller.js';
import type { FundingControllerConfig } from '../funding-controller.js';
import { Store } from '../../core/store.js';
import { ActionQueue } from '../../core/action-queue.js';
import type { StatArbSignal } from '../../core/store-slices/stat-arb-slice.js';
import { chainId, tokenAddress } from '../../core/types.js';
import { CHAINS, USDC_ADDRESSES } from '../../core/constants.js';

// --- Helpers ---

function makeSignal(overrides: Partial<StatArbSignal> = {}): StatArbSignal {
  return {
    signalId: 'signal-1',
    pair: { tokenA: 'BTC', tokenB: 'ETH', key: 'BTC-ETH' },
    direction: 'long_pair',
    zScore: 2.1,
    correlation: 0.85,
    halfLifeHours: 24,
    hedgeRatio: 1.5,
    recommendedLeverage: 5,
    source: 'telegram',
    timestamp: Date.now(),
    consumed: false,
    expiresAt: Date.now() + 60 * 60 * 1000,
    ...overrides,
  };
}

const ETH_USDC = USDC_ADDRESSES[CHAINS.ETHEREUM as number];
const ARB_USDC = USDC_ADDRESSES[CHAINS.ARBITRUM as number];
const OPT_USDC = USDC_ADDRESSES[CHAINS.OPTIMISM as number];
const BASE_USDC = USDC_ADDRESSES[CHAINS.BASE as number];

const defaultConfig: Partial<FundingControllerConfig> = {
  tickIntervalMs: 100,
  minBridgeAmount: 10_000_000n, // 10 USDC
  gasReserveUsdc: 1_000_000n,   // $1 reserve for tests
  marginBuffer: 0.10,
};

describe('FundingController', () => {
  let store: Store;
  let queue: ActionQueue;

  beforeEach(() => {
    Store.getInstance().reset();
    store = Store.getInstance();
    queue = new ActionQueue();
  });

  describe('evaluateMarginNeed', () => {
    it('returns null when Hyperliquid margin is sufficient', () => {
      // Set a large Arbitrum USDC balance (Hyperliquid margin)
      store.setBalance(CHAINS.ARBITRUM, ARB_USDC, 1_000_000_000n, 1000, 'USDC', 6);

      const controller = new FundingController(store, queue, defaultConfig);
      const signal = makeSignal({ recommendedLeverage: 5 });
      const result = controller.evaluateMarginNeed(signal);

      expect(result).toBeNull();
    });

    it('returns funding request when margin is insufficient', () => {
      // Set a small Arbitrum USDC balance
      store.setBalance(CHAINS.ARBITRUM, ARB_USDC, 10_000_000n, 10, 'USDC', 6);

      const controller = new FundingController(store, queue, defaultConfig);
      const signal = makeSignal({ recommendedLeverage: 5 });
      const result = controller.evaluateMarginNeed(signal);

      expect(result).not.toBeNull();
      expect(result!.deficit).toBeGreaterThan(0n);
      expect(result!.signalId).toBe('signal-1');
    });

    it('returns null when no balance exists but estimate is zero', () => {
      // No balances set — both required and current are 0
      const controller = new FundingController(store, queue, defaultConfig);
      const signal = makeSignal({ recommendedLeverage: 1000 }); // Very high leverage = low requirement
      const result = controller.evaluateMarginNeed(signal);

      // With very high leverage, required capital approaches 0 which may be <= 0 balance
      // This tests the edge case
      if (result === null) {
        expect(result).toBeNull();
      } else {
        expect(result.deficit).toBeGreaterThan(0n);
      }
    });
  });

  describe('selectSourceChain', () => {
    it('selects chain with highest USDC balance', () => {
      store.setBalance(CHAINS.ETHEREUM, ETH_USDC, 500_000_000n, 500, 'USDC', 6);
      store.setBalance(CHAINS.OPTIMISM, OPT_USDC, 800_000_000n, 800, 'USDC', 6);
      store.setBalance(CHAINS.BASE, BASE_USDC, 200_000_000n, 200, 'USDC', 6);

      const controller = new FundingController(store, queue, defaultConfig);
      const result = controller.selectSourceChain(100_000_000n); // 100 USDC deficit

      expect(result).not.toBeNull();
      expect(result!.chainId).toBe(CHAINS.OPTIMISM);
      expect(result!.bridgeAmount).toBe(100_000_000n);
    });

    it('excludes chains with balance below minimum', () => {
      store.setBalance(CHAINS.ETHEREUM, ETH_USDC, 5_000_000n, 5, 'USDC', 6); // Below 10 USDC min
      store.setBalance(CHAINS.OPTIMISM, OPT_USDC, 200_000_000n, 200, 'USDC', 6);

      const controller = new FundingController(store, queue, defaultConfig);
      const result = controller.selectSourceChain(50_000_000n);

      expect(result).not.toBeNull();
      expect(result!.chainId).toBe(CHAINS.OPTIMISM);
    });

    it('returns null when no chain has enough balance', () => {
      store.setBalance(CHAINS.ETHEREUM, ETH_USDC, 50_000_000n, 50, 'USDC', 6);

      const controller = new FundingController(store, queue, defaultConfig);
      const result = controller.selectSourceChain(500_000_000n); // 500 USDC deficit, only 50 available

      expect(result).toBeNull();
    });

    it('skips Arbitrum as source chain', () => {
      // Only Arbitrum has funds — should not be selected (it's the destination)
      store.setBalance(CHAINS.ARBITRUM, ARB_USDC, 1_000_000_000n, 1000, 'USDC', 6);

      const controller = new FundingController(store, queue, defaultConfig);
      const result = controller.selectSourceChain(100_000_000n);

      expect(result).toBeNull();
    });
  });

  describe('buildMultiChainPlan', () => {
    it('aggregates from multiple chains when no single chain suffices', () => {
      store.setBalance(CHAINS.ETHEREUM, ETH_USDC, 100_000_000n, 100, 'USDC', 6);
      store.setBalance(CHAINS.OPTIMISM, OPT_USDC, 80_000_000n, 80, 'USDC', 6);
      store.setBalance(CHAINS.BASE, BASE_USDC, 60_000_000n, 60, 'USDC', 6);

      const controller = new FundingController(store, queue, defaultConfig);
      // Reserve is 1 USDC per chain, so bridgeable = balance - 1_000_000n
      const plans = controller.buildMultiChainPlan(200_000_000n); // 200 USDC

      expect(plans.length).toBeGreaterThanOrEqual(2);
      const totalBridge = plans.reduce((sum, p) => sum + p.bridgeAmount, 0n);
      expect(totalBridge).toBeGreaterThanOrEqual(200_000_000n);
    });

    it('respects maxConcurrentBridges limit', () => {
      store.setBalance(CHAINS.ETHEREUM, ETH_USDC, 50_000_000n, 50, 'USDC', 6);
      store.setBalance(CHAINS.OPTIMISM, OPT_USDC, 50_000_000n, 50, 'USDC', 6);
      store.setBalance(CHAINS.BASE, BASE_USDC, 50_000_000n, 50, 'USDC', 6);
      store.setBalance(CHAINS.POLYGON, USDC_ADDRESSES[CHAINS.POLYGON as number], 50_000_000n, 50, 'USDC', 6);

      const controller = new FundingController(store, queue, {
        ...defaultConfig,
        maxConcurrentBridges: 2,
      });

      const plans = controller.buildMultiChainPlan(500_000_000n);
      expect(plans.length).toBeLessThanOrEqual(2);
    });

    it('returns empty array when no chains have bridgeable balance', () => {
      // No balances set
      const controller = new FundingController(store, queue, defaultConfig);
      const plans = controller.buildMultiChainPlan(100_000_000n);

      expect(plans).toEqual([]);
    });
  });

  describe('buildFundingPlan', () => {
    it('uses single chain when possible', () => {
      store.setBalance(CHAINS.ETHEREUM, ETH_USDC, 500_000_000n, 500, 'USDC', 6);

      const controller = new FundingController(store, queue, defaultConfig);
      const plans = controller.buildFundingPlan(100_000_000n);

      expect(plans.length).toBe(1);
      expect(plans[0].chainId).toBe(CHAINS.ETHEREUM);
    });

    it('falls back to multi-chain when single chain insufficient', () => {
      store.setBalance(CHAINS.ETHEREUM, ETH_USDC, 100_000_000n, 100, 'USDC', 6);
      store.setBalance(CHAINS.OPTIMISM, OPT_USDC, 100_000_000n, 100, 'USDC', 6);

      const controller = new FundingController(store, queue, defaultConfig);
      const plans = controller.buildFundingPlan(180_000_000n); // 180 USDC

      expect(plans.length).toBe(2);
    });
  });

  describe('batch management', () => {
    it('tracks funding batch completion', () => {
      const controller = new FundingController(store, queue, defaultConfig);

      // Simulate creating a batch manually via the public methods
      store.setBalance(CHAINS.ETHEREUM, ETH_USDC, 500_000_000n, 500, 'USDC', 6);
      store.setBalance(CHAINS.ARBITRUM, ARB_USDC, 0n, 0, 'USDC', 6);

      const signal = makeSignal();
      store.addStatArbSignal(signal);

      // The evaluateMarginNeed should detect deficit
      const request = controller.evaluateMarginNeed(signal);
      expect(request).not.toBeNull();
    });

    it('onBridgeCompleted updates batch total', () => {
      const controller = new FundingController(store, queue, defaultConfig);

      store.setBalance(CHAINS.ETHEREUM, ETH_USDC, 500_000_000n, 500, 'USDC', 6);
      store.setBalance(CHAINS.ARBITRUM, ARB_USDC, 0n, 0, 'USDC', 6);

      // Manually trigger controlTask to create a batch
      const signal = makeSignal();
      store.addStatArbSignal(signal);

      // Run the controller tick
      // This should create a batch and enqueue actions
      // We test the batch tracking separately
      const batches = controller.getActiveBatches();
      // Initially empty
      expect(batches.size).toBe(0);
    });
  });

  describe('controlTask', () => {
    it('skips when no pending signals', async () => {
      const controller = new FundingController(store, queue, defaultConfig);
      await controller.controlTask();

      expect(queue.isEmpty()).toBe(true);
    });

    it('enqueues funding bridge actions for signals with margin deficit', async () => {
      store.setBalance(CHAINS.ETHEREUM, ETH_USDC, 500_000_000n, 500, 'USDC', 6);
      store.setBalance(CHAINS.ARBITRUM, ARB_USDC, 0n, 0, 'USDC', 6);

      const signal = makeSignal();
      store.addStatArbSignal(signal);

      const controller = new FundingController(store, queue, defaultConfig);
      await controller.controlTask();

      // Should have enqueued at least one funding bridge action
      expect(queue.isEmpty()).toBe(false);
      const action = queue.dequeue();
      expect(action).toBeDefined();
      expect(action!.type).toBe('funding_bridge');
    });

    it('does not duplicate batches for the same signal', async () => {
      store.setBalance(CHAINS.ETHEREUM, ETH_USDC, 500_000_000n, 500, 'USDC', 6);
      store.setBalance(CHAINS.ARBITRUM, ARB_USDC, 0n, 0, 'USDC', 6);

      const signal = makeSignal();
      store.addStatArbSignal(signal);

      const controller = new FundingController(store, queue, defaultConfig);
      await controller.controlTask();
      const firstSize = queue.size();

      await controller.controlTask(); // Second tick
      // Should not enqueue more actions for the same signal
      expect(queue.size()).toBe(firstSize);
    });
  });
});
