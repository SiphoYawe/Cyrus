import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OnChainIndexer } from '../on-chain-indexer.js';
import { Store } from '../../core/store.js';
import { chainId, tokenAddress } from '../../core/types.js';
import type { ConcreteOnChainEvent } from '../on-chain-types.js';

const CHAIN_ETH = chainId(1);
const CHAIN_ARB = chainId(42161);
const CHAIN_OP = chainId(10);
const USDC = tokenAddress('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
const WETH = tokenAddress('0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2');

function createIndexer(overrides: Record<string, unknown> = {}): OnChainIndexer {
  return new OnChainIndexer({
    monitoredChains: [CHAIN_ETH, CHAIN_ARB],
    monitoredProtocols: ['aave-v3', 'morpho'],
    whaleThresholdUsd: 50_000,
    tvlChangeThresholdPercent: 5,
    pollIntervalMs: 1000,
    maxEventRetention: 100,
    ...overrides,
  });
}

describe('OnChainIndexer', () => {
  beforeEach(() => {
    const store = Store.getInstance();
    store.reset();
  });

  describe('initialization', () => {
    it('initializes with correct config and monitored chains', () => {
      const indexer = createIndexer();
      expect(indexer).toBeDefined();
      expect(indexer.getEventCount()).toBe(0);
      expect(indexer.isRunning()).toBe(false);
    });
  });

  describe('TVL monitoring', () => {
    it('emits TvlChangeEvent when change exceeds threshold (>5%)', async () => {
      const indexer = createIndexer();
      const emitted: ConcreteOnChainEvent[] = [];
      indexer.events.on('event', (e: ConcreteOnChainEvent) => emitted.push(e));

      // First tick: set baseline TVL
      indexer.fetchProtocolTvl = vi.fn().mockResolvedValue(1_000_000);
      await indexer.controlTask();

      // Second tick: TVL drops 10% — should trigger
      indexer.fetchProtocolTvl = vi.fn().mockResolvedValue(900_000);
      await indexer.controlTask();

      const tvlEvents = emitted.filter((e) => e.type === 'tvl_change');
      expect(tvlEvents.length).toBeGreaterThan(0);
      const evt = tvlEvents[0]!;
      expect(evt.type).toBe('tvl_change');
      if (evt.type === 'tvl_change') {
        expect(evt.oldTvl).toBe(1_000_000);
        expect(evt.newTvl).toBe(900_000);
        expect(evt.changePercent).toBeCloseTo(-10, 1);
      }
    });

    it('does not emit event when TVL change is below threshold', async () => {
      const indexer = createIndexer();
      const emitted: ConcreteOnChainEvent[] = [];
      indexer.events.on('event', (e: ConcreteOnChainEvent) => emitted.push(e));

      // Baseline
      indexer.fetchProtocolTvl = vi.fn().mockResolvedValue(1_000_000);
      await indexer.controlTask();

      // 2% change — below 5% threshold
      indexer.fetchProtocolTvl = vi.fn().mockResolvedValue(980_000);
      await indexer.controlTask();

      const tvlEvents = emitted.filter((e) => e.type === 'tvl_change');
      expect(tvlEvents.length).toBe(0);
    });
  });

  describe('whale monitoring', () => {
    it('emits WhaleTradeEvent for trades above $50k threshold', async () => {
      const indexer = createIndexer();
      const emitted: ConcreteOnChainEvent[] = [];
      indexer.events.on('event', (e: ConcreteOnChainEvent) => emitted.push(e));

      indexer.fetchWhaleTransactions = vi.fn().mockResolvedValue([
        {
          txHash: '0xabc123',
          wallet: '0x28c6c06298d514db089934071355e5743bf21d60',
          token: USDC as string,
          amount: 100_000_000000n,
          amountUsd: 100_000,
          direction: 'buy',
          dex: 'uniswap-v3',
        },
      ]);

      await indexer.controlTask();

      const whaleEvents = emitted.filter((e) => e.type === 'whale_trade');
      expect(whaleEvents.length).toBe(1);
      const evt = whaleEvents[0]!;
      if (evt.type === 'whale_trade') {
        expect(evt.walletLabel).toBe('Binance Hot Wallet');
        expect(evt.direction).toBe('buy');
        expect(evt.amountUsd).toBe(100_000);
        expect(evt.dex).toBe('uniswap-v3');
      }
    });

    it('filters out trades below threshold', async () => {
      const indexer = createIndexer();
      const emitted: ConcreteOnChainEvent[] = [];
      indexer.events.on('event', (e: ConcreteOnChainEvent) => emitted.push(e));

      indexer.fetchWhaleTransactions = vi.fn().mockResolvedValue([
        {
          txHash: '0xsmall',
          wallet: '0x1234',
          token: USDC as string,
          amount: 10_000_000000n,
          amountUsd: 10_000, // Below 50k threshold
          direction: 'sell',
          dex: 'sushiswap',
        },
      ]);

      await indexer.controlTask();

      const whaleEvents = emitted.filter((e) => e.type === 'whale_trade');
      expect(whaleEvents.length).toBe(0);
    });

    it('deduplicates by transaction hash', async () => {
      const indexer = createIndexer();
      const emitted: ConcreteOnChainEvent[] = [];
      indexer.events.on('event', (e: ConcreteOnChainEvent) => emitted.push(e));

      const trade = {
        txHash: '0xdup',
        wallet: '0x1234',
        token: USDC as string,
        amount: 100_000_000000n,
        amountUsd: 100_000,
        direction: 'buy' as const,
        dex: 'uniswap-v3',
      };

      indexer.fetchWhaleTransactions = vi.fn().mockResolvedValue([trade]);

      await indexer.controlTask();
      await indexer.controlTask(); // Same tx hash again

      const whaleEvents = emitted.filter((e) => e.type === 'whale_trade');
      expect(whaleEvents.length).toBe(1);
    });
  });

  describe('liquidity monitoring', () => {
    it('emits LiquidityChangeEvent for add/remove events', async () => {
      const indexer = createIndexer();
      const emitted: ConcreteOnChainEvent[] = [];
      indexer.events.on('event', (e: ConcreteOnChainEvent) => emitted.push(e));

      indexer.fetchLiquidityEvents = vi.fn().mockResolvedValue([
        {
          poolAddress: '0xpool1',
          token0: USDC as string,
          token1: WETH as string,
          amount: 500_000_000000n,
          amountUsd: 500_000,
          direction: 'add',
        },
      ]);

      await indexer.controlTask();

      const liqEvents = emitted.filter((e) => e.type === 'liquidity_change');
      // One event per monitored chain (2 chains configured)
      expect(liqEvents.length).toBe(2);
      for (const evt of liqEvents) {
        if (evt.type === 'liquidity_change') {
          expect(evt.direction).toBe('add');
          expect(evt.poolAddress).toBe('0xpool1');
        }
      }
    });
  });

  describe('gas tracking', () => {
    it('populates GasPriceMap for all monitored chains', async () => {
      const indexer = createIndexer();

      indexer.fetchGasPrice = vi.fn()
        .mockResolvedValueOnce({ gasPriceGwei: 30, baseFeeGwei: 25, priorityFeeGwei: 5 })
        .mockResolvedValueOnce({ gasPriceGwei: 0.1, baseFeeGwei: 0.08, priorityFeeGwei: 0.02 });

      await indexer.controlTask();

      const ethGas = indexer.getGasPrice(CHAIN_ETH);
      expect(ethGas).toBeDefined();
      expect(ethGas!.gasPriceGwei).toBe(30);

      const arbGas = indexer.getGasPrice(CHAIN_ARB);
      expect(arbGas).toBeDefined();
      expect(arbGas!.gasPriceGwei).toBe(0.1);
    });

    it('emits GasUpdateEvent when gas changes >20%', async () => {
      const indexer = createIndexer();
      const emitted: ConcreteOnChainEvent[] = [];
      indexer.events.on('event', (e: ConcreteOnChainEvent) => emitted.push(e));

      // First tick — baseline
      indexer.fetchGasPrice = vi.fn()
        .mockResolvedValue({ gasPriceGwei: 30, baseFeeGwei: 25, priorityFeeGwei: 5 });
      await indexer.controlTask();

      // Second tick — gas jumps 50%
      indexer.fetchGasPrice = vi.fn()
        .mockResolvedValue({ gasPriceGwei: 45, baseFeeGwei: 38, priorityFeeGwei: 7 });
      await indexer.controlTask();

      const gasEvents = emitted.filter((e) => e.type === 'gas_update');
      expect(gasEvents.length).toBeGreaterThan(0);
    });

    it('getOptimalChain returns chain with lowest gas', async () => {
      const indexer = createIndexer();

      indexer.fetchGasPrice = vi.fn()
        .mockResolvedValueOnce({ gasPriceGwei: 30, baseFeeGwei: 25, priorityFeeGwei: 5 })
        .mockResolvedValueOnce({ gasPriceGwei: 0.1, baseFeeGwei: 0.08, priorityFeeGwei: 0.02 });

      await indexer.controlTask();

      const optimal = indexer.getOptimalChain();
      expect(optimal).toBe(CHAIN_ARB); // Arbitrum has lower gas
    });
  });

  describe('flow pattern detection', () => {
    it('emits FlowPatternEvent for accumulation pattern (buy > 2x sell)', async () => {
      const indexer = createIndexer();
      const emitted: ConcreteOnChainEvent[] = [];
      indexer.events.on('event', (e: ConcreteOnChainEvent) => emitted.push(e));

      const now = Date.now();
      // Add flow entries: heavy buying
      for (let i = 0; i < 30; i++) {
        indexer.addFlowEntry(CHAIN_ETH, USDC, {
          timestamp: now - (i * 1000),
          direction: 'buy',
          volumeUsd: 10_000,
        });
      }
      // Few sells
      for (let i = 0; i < 5; i++) {
        indexer.addFlowEntry(CHAIN_ETH, USDC, {
          timestamp: now - (i * 1000),
          direction: 'sell',
          volumeUsd: 5_000,
        });
      }

      await indexer.controlTask();

      const flowEvents = emitted.filter((e) => e.type === 'flow_pattern');
      expect(flowEvents.length).toBe(1);
      if (flowEvents[0]!.type === 'flow_pattern') {
        expect(flowEvents[0]!.patternType).toBe('accumulation');
        expect(flowEvents[0]!.buyCount).toBe(30);
        expect(flowEvents[0]!.sellCount).toBe(5);
        expect(flowEvents[0]!.confidenceScore).toBeGreaterThanOrEqual(0.6);
      }
    });

    it('emits FlowPatternEvent for distribution pattern (sell > 2x buy)', async () => {
      const indexer = createIndexer();
      const emitted: ConcreteOnChainEvent[] = [];
      indexer.events.on('event', (e: ConcreteOnChainEvent) => emitted.push(e));

      const now = Date.now();
      // Heavy selling
      for (let i = 0; i < 30; i++) {
        indexer.addFlowEntry(CHAIN_ETH, WETH, {
          timestamp: now - (i * 1000),
          direction: 'sell',
          volumeUsd: 10_000,
        });
      }
      // Few buys
      for (let i = 0; i < 5; i++) {
        indexer.addFlowEntry(CHAIN_ETH, WETH, {
          timestamp: now - (i * 1000),
          direction: 'buy',
          volumeUsd: 5_000,
        });
      }

      await indexer.controlTask();

      const flowEvents = emitted.filter((e) => e.type === 'flow_pattern');
      expect(flowEvents.length).toBe(1);
      if (flowEvents[0]!.type === 'flow_pattern') {
        expect(flowEvents[0]!.patternType).toBe('distribution');
      }
    });

    it('does not emit event with low transaction count (<10)', async () => {
      const indexer = createIndexer();
      const emitted: ConcreteOnChainEvent[] = [];
      indexer.events.on('event', (e: ConcreteOnChainEvent) => emitted.push(e));

      const now = Date.now();
      // Only 5 transactions — below minimum
      for (let i = 0; i < 5; i++) {
        indexer.addFlowEntry(CHAIN_ETH, USDC, {
          timestamp: now - (i * 1000),
          direction: 'buy',
          volumeUsd: 100_000,
        });
      }

      await indexer.controlTask();

      const flowEvents = emitted.filter((e) => e.type === 'flow_pattern');
      expect(flowEvents.length).toBe(0);
    });
  });

  describe('queryEvents', () => {
    it('filters by type correctly', async () => {
      const indexer = createIndexer();

      // Add mixed events via fetchGasPrice and fetchWhaleTransactions
      indexer.fetchGasPrice = vi.fn()
        .mockResolvedValue({ gasPriceGwei: 30, baseFeeGwei: 25, priorityFeeGwei: 5 });
      indexer.fetchWhaleTransactions = vi.fn().mockResolvedValue([
        {
          txHash: '0xw1',
          wallet: '0x1234',
          token: USDC as string,
          amount: 100_000n,
          amountUsd: 100_000,
          direction: 'buy',
          dex: 'uniswap',
        },
      ]);
      await indexer.controlTask();

      // Set baseline gas, then spike to emit gas event
      indexer.fetchGasPrice = vi.fn()
        .mockResolvedValue({ gasPriceGwei: 60, baseFeeGwei: 50, priorityFeeGwei: 10 });
      await indexer.controlTask();

      const whaleOnly = indexer.queryEvents({ type: 'whale_trade' });
      for (const e of whaleOnly) {
        expect(e.type).toBe('whale_trade');
      }
    });

    it('filters by chain correctly', async () => {
      const indexer = createIndexer();

      indexer.fetchWhaleTransactions = vi.fn().mockResolvedValue([
        {
          txHash: '0xchain1',
          wallet: '0x1234',
          token: USDC as string,
          amount: 100_000n,
          amountUsd: 100_000,
          direction: 'buy',
          dex: 'uniswap',
        },
      ]);
      await indexer.controlTask();

      const ethOnly = indexer.queryEvents({ chain: CHAIN_ETH });
      for (const e of ethOnly) {
        expect(e.chain).toBe(CHAIN_ETH);
      }
    });

    it('filters by token correctly', async () => {
      const indexer = createIndexer();

      indexer.fetchWhaleTransactions = vi.fn().mockResolvedValue([
        {
          txHash: '0xt1',
          wallet: '0x1234',
          token: USDC as string,
          amount: 100_000n,
          amountUsd: 100_000,
          direction: 'buy',
          dex: 'uniswap',
        },
        {
          txHash: '0xt2',
          wallet: '0x5678',
          token: WETH as string,
          amount: 50n,
          amountUsd: 125_000,
          direction: 'sell',
          dex: 'curve',
        },
      ]);
      await indexer.controlTask();

      const usdcOnly = indexer.queryEvents({ token: USDC });
      expect(usdcOnly.length).toBeGreaterThan(0);
      for (const e of usdcOnly) {
        if ('token' in e) {
          expect((e as { token: string }).token).toBe(USDC);
        }
      }
    });

    it('filters by time range correctly', async () => {
      const indexer = createIndexer();

      indexer.fetchWhaleTransactions = vi.fn().mockResolvedValue([
        {
          txHash: '0xtime1',
          wallet: '0x1234',
          token: USDC as string,
          amount: 100_000n,
          amountUsd: 100_000,
          direction: 'buy',
          dex: 'uniswap',
        },
      ]);

      const before = Date.now();
      await indexer.controlTask();
      const after = Date.now();

      const inRange = indexer.queryEvents({ fromTimestamp: before, toTimestamp: after });
      expect(inRange.length).toBeGreaterThan(0);

      const outOfRange = indexer.queryEvents({ fromTimestamp: after + 10000 });
      expect(outOfRange.length).toBe(0);
    });

    it('combines multiple filters with AND logic', async () => {
      const indexer = createIndexer();

      indexer.fetchWhaleTransactions = vi.fn().mockResolvedValue([
        {
          txHash: '0xand1',
          wallet: '0x1234',
          token: USDC as string,
          amount: 100_000n,
          amountUsd: 100_000,
          direction: 'buy',
          dex: 'uniswap',
        },
      ]);
      await indexer.controlTask();

      const combined = indexer.queryEvents({
        type: 'whale_trade',
        chain: CHAIN_ETH,
        token: USDC,
      });
      expect(combined.length).toBeGreaterThan(0);

      // Wrong chain should yield empty
      const wrong = indexer.queryEvents({
        type: 'whale_trade',
        chain: CHAIN_OP, // Not monitored in this indexer setup
      });
      expect(wrong.length).toBe(0);
    });
  });

  describe('getLatestEvents', () => {
    it('returns correct count sorted by timestamp descending', async () => {
      const indexer = createIndexer();

      indexer.fetchWhaleTransactions = vi.fn().mockResolvedValue([
        { txHash: '0x1', wallet: '0x1', token: USDC as string, amount: 100n, amountUsd: 100_000, direction: 'buy', dex: 'uni' },
        { txHash: '0x2', wallet: '0x2', token: WETH as string, amount: 200n, amountUsd: 200_000, direction: 'sell', dex: 'sushi' },
        { txHash: '0x3', wallet: '0x3', token: USDC as string, amount: 300n, amountUsd: 300_000, direction: 'buy', dex: 'curve' },
      ]);
      await indexer.controlTask();

      const latest = indexer.getLatestEvents(2);
      expect(latest.length).toBe(2);
      // Should be sorted descending
      expect(latest[0]!.timestamp).toBeGreaterThanOrEqual(latest[1]!.timestamp);
    });
  });

  describe('ring buffer', () => {
    it('prunes oldest events when maxEventRetention exceeded', async () => {
      const indexer = createIndexer({ maxEventRetention: 5 });

      // Generate more than 5 events
      const whaleEntries = Array.from({ length: 8 }, (_, i) => ({
        txHash: `0xoverflow${i}`,
        wallet: '0x1234',
        token: USDC as string,
        amount: BigInt(100_000 + i),
        amountUsd: 100_000 + i,
        direction: 'buy' as const,
        dex: 'uniswap',
      }));

      indexer.fetchWhaleTransactions = vi.fn().mockResolvedValue(whaleEntries);
      await indexer.controlTask();

      // Should be capped at 5
      expect(indexer.getEventCount()).toBeLessThanOrEqual(5);
    });
  });

  describe('store reset', () => {
    it('clears all indexed events, gas price map, and TVL snapshots', async () => {
      const indexer = createIndexer();

      indexer.fetchGasPrice = vi.fn()
        .mockResolvedValue({ gasPriceGwei: 30, baseFeeGwei: 25, priorityFeeGwei: 5 });
      indexer.fetchProtocolTvl = vi.fn().mockResolvedValue(1_000_000);
      await indexer.controlTask();

      expect(indexer.getEventCount()).toBeGreaterThanOrEqual(0);
      expect(indexer.getGasPrice(CHAIN_ETH)).toBeDefined();

      indexer.resetState();

      expect(indexer.getEventCount()).toBe(0);
      expect(indexer.getGasPrice(CHAIN_ETH)).toBeUndefined();
    });
  });

  describe('controlTask resilience', () => {
    it('runs all monitoring subroutines in parallel via Promise.allSettled()', async () => {
      const indexer = createIndexer();

      indexer.fetchProtocolTvl = vi.fn().mockResolvedValue(1_000_000);
      indexer.fetchWhaleTransactions = vi.fn().mockResolvedValue([]);
      indexer.fetchLiquidityEvents = vi.fn().mockResolvedValue([]);
      indexer.fetchGasPrice = vi.fn()
        .mockResolvedValue({ gasPriceGwei: 30, baseFeeGwei: 25, priorityFeeGwei: 5 });

      await indexer.controlTask();

      expect(indexer.fetchProtocolTvl).toHaveBeenCalled();
      expect(indexer.fetchWhaleTransactions).toHaveBeenCalled();
      expect(indexer.fetchLiquidityEvents).toHaveBeenCalled();
      expect(indexer.fetchGasPrice).toHaveBeenCalled();
    });

    it('individual subroutine failure does not crash the entire tick', async () => {
      const indexer = createIndexer();

      indexer.fetchProtocolTvl = vi.fn().mockRejectedValue(new Error('TVL API down'));
      indexer.fetchWhaleTransactions = vi.fn().mockRejectedValue(new Error('Explorer down'));
      indexer.fetchLiquidityEvents = vi.fn().mockResolvedValue([]);
      indexer.fetchGasPrice = vi.fn()
        .mockResolvedValue({ gasPriceGwei: 30, baseFeeGwei: 25, priorityFeeGwei: 5 });

      // Should not throw
      await expect(indexer.controlTask()).resolves.not.toThrow();

      // Gas should still have been populated
      expect(indexer.getGasPrice(CHAIN_ETH)).toBeDefined();
    });
  });
});
