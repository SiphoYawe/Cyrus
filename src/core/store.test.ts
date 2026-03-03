import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Store } from './store.js';
import { chainId, tokenAddress, transferId } from './types.js';
import type { BalanceEntry, InFlightTransfer, CompletedTransfer, Position, PriceEntry } from './types.js';

describe('Store', () => {
  let store: Store;

  beforeEach(() => {
    // Always reset before each test
    Store.getInstance().reset();
    store = Store.getInstance();
  });

  // --- Singleton ---

  describe('singleton', () => {
    it('returns the same instance on multiple calls', () => {
      const a = Store.getInstance();
      const b = Store.getInstance();
      expect(a).toBe(b);
    });

    it('returns a new instance after reset()', () => {
      const a = Store.getInstance();
      a.reset();
      const b = Store.getInstance();
      // After reset, the old singleton is cleared; getInstance creates a fresh one
      expect(b).not.toBe(a);
    });
  });

  // --- Reset ---

  describe('reset()', () => {
    it('clears all slices', () => {
      const chain = chainId(1);
      const token = tokenAddress('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');

      store.setBalance(chain, token, 1000n, 1000, 'USDC', 6);
      store.createTransfer({
        txHash: '0xabc',
        fromChain: chain,
        toChain: chainId(42161),
        fromToken: token,
        toToken: token,
        amount: 100n,
        bridge: 'stargate',
        quoteData: {},
      });

      store.reset();
      const newStore = Store.getInstance();

      expect(newStore.getAllBalances()).toHaveLength(0);
      expect(newStore.getActiveTransfers()).toHaveLength(0);
      expect(newStore.getCompletedTransfers()).toHaveLength(0);
    });

    it('removes event listeners', () => {
      const listener = vi.fn();
      store.emitter.on('balance.updated', listener);

      store.reset();

      // After reset, the emitter's listeners should be removed
      // But the store instance is now null, so we get a fresh one
      const newStore = Store.getInstance();
      newStore.setBalance(
        chainId(1),
        tokenAddress('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'),
        100n,
        100,
        'USDC',
        6,
      );

      // The old listener should NOT have been called after reset
      expect(listener).not.toHaveBeenCalled();
    });
  });

  // --- Balances ---

  describe('balances', () => {
    const chain = chainId(1);
    const token = tokenAddress('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');

    it('sets and gets balance with composite key', () => {
      store.setBalance(chain, token, 5000000n, 5.0, 'USDC', 6);

      const balance = store.getBalance(chain, token);
      expect(balance).toBeDefined();
      expect(balance!.chainId).toBe(chain);
      expect(balance!.tokenAddress).toBe(token);
      expect(balance!.amount).toBe(5000000n);
      expect(balance!.usdValue).toBe(5.0);
      expect(balance!.symbol).toBe('USDC');
      expect(balance!.decimals).toBe(6);
    });

    it('returns undefined for non-existent balance', () => {
      expect(store.getBalance(chain, token)).toBeUndefined();
    });

    it('overwrites existing balance', () => {
      store.setBalance(chain, token, 1000n, 1.0, 'USDC', 6);
      store.setBalance(chain, token, 2000n, 2.0, 'USDC', 6);

      const balance = store.getBalance(chain, token);
      expect(balance!.amount).toBe(2000n);
      expect(balance!.usdValue).toBe(2.0);
    });

    it('getAllBalances returns all entries', () => {
      const token2 = tokenAddress('0xdac17f958d2ee523a2206206994597c13d831ec7');
      store.setBalance(chain, token, 1000n, 1.0, 'USDC', 6);
      store.setBalance(chain, token2, 2000n, 2.0, 'USDT', 6);

      expect(store.getAllBalances()).toHaveLength(2);
    });

    it('getBalancesByChain filters by chainId', () => {
      const chain2 = chainId(42161);
      store.setBalance(chain, token, 1000n, 1.0, 'USDC', 6);
      store.setBalance(chain2, token, 2000n, 2.0, 'USDC', 6);

      const chainBalances = store.getBalancesByChain(chain);
      expect(chainBalances).toHaveLength(1);
      expect(chainBalances[0].chainId).toBe(chain);
    });
  });

  // --- Available balance deduction ---

  describe('getAvailableBalance', () => {
    const chain = chainId(1);
    const token = tokenAddress('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');

    it('returns full balance when no in-flight transfers', () => {
      store.setBalance(chain, token, 10000n, 10.0, 'USDC', 6);
      expect(store.getAvailableBalance(chain, token)).toBe(10000n);
    });

    it('deducts in-flight transfer amounts', () => {
      store.setBalance(chain, token, 10000n, 10.0, 'USDC', 6);

      store.createTransfer({
        txHash: '0xabc',
        fromChain: chain,
        toChain: chainId(42161),
        fromToken: token,
        toToken: token,
        amount: 3000n,
        bridge: 'stargate',
        quoteData: {},
      });

      expect(store.getAvailableBalance(chain, token)).toBe(7000n);
    });

    it('returns 0n when in-flight exceeds balance', () => {
      store.setBalance(chain, token, 1000n, 1.0, 'USDC', 6);

      store.createTransfer({
        txHash: '0xabc',
        fromChain: chain,
        toChain: chainId(42161),
        fromToken: token,
        toToken: token,
        amount: 5000n,
        bridge: 'stargate',
        quoteData: {},
      });

      expect(store.getAvailableBalance(chain, token)).toBe(0n);
    });

    it('returns 0n when no balance entry exists', () => {
      expect(store.getAvailableBalance(chain, token)).toBe(0n);
    });
  });

  // --- Transfers lifecycle ---

  describe('transfer lifecycle', () => {
    const fromChain = chainId(1);
    const toChain = chainId(42161);
    const fromToken = tokenAddress('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
    const toToken = tokenAddress('0xaf88d065e77c8cc2239327c5edb3a432268e5831');

    it('creates a transfer with generated UUID', () => {
      const transfer = store.createTransfer({
        txHash: '0xabc',
        fromChain,
        toChain,
        fromToken,
        toToken,
        amount: 1000n,
        bridge: 'stargate',
        quoteData: { route: 'test' },
      });

      expect(transfer.id).toBeDefined();
      expect(typeof transfer.id).toBe('string');
      expect(transfer.id.length).toBeGreaterThan(0);
      expect(transfer.status).toBe('in_flight');
      expect(transfer.amount).toBe(1000n);
      expect(transfer.bridge).toBe('stargate');
      expect(transfer.recovered).toBe(false);
    });

    it('getActiveTransfers returns in-flight transfers', () => {
      store.createTransfer({
        txHash: '0xabc',
        fromChain,
        toChain,
        fromToken,
        toToken,
        amount: 1000n,
        bridge: 'stargate',
        quoteData: {},
      });

      const active = store.getActiveTransfers();
      expect(active).toHaveLength(1);
      expect(active[0].status).toBe('in_flight');
    });

    it('updateTransferStatus changes status', () => {
      const transfer = store.createTransfer({
        txHash: '0xabc',
        fromChain,
        toChain,
        fromToken,
        toToken,
        amount: 1000n,
        bridge: 'stargate',
        quoteData: {},
      });

      store.updateTransferStatus(transfer.id, 'pending');

      const updated = store.getTransfer(transfer.id);
      expect(updated!.status).toBe('pending');
      expect(updated!.updatedAt).toBeGreaterThanOrEqual(transfer.createdAt);
    });

    it('updateTransferStatus can update txHash via metadata', () => {
      const transfer = store.createTransfer({
        txHash: null,
        fromChain,
        toChain,
        fromToken,
        toToken,
        amount: 1000n,
        bridge: 'stargate',
        quoteData: {},
      });

      store.updateTransferStatus(transfer.id, 'in_flight', { txHash: '0xnewhash' });

      const updated = store.getTransfer(transfer.id);
      expect(updated!.txHash).toBe('0xnewhash');
    });

    it('updateTransferStatus silently ignores non-existent transfer', () => {
      // Should not throw
      store.updateTransferStatus(transferId('nonexistent'), 'failed');
    });

    it('completeTransfer moves from active to completed', () => {
      const transfer = store.createTransfer({
        txHash: '0xabc',
        fromChain,
        toChain,
        fromToken,
        toToken,
        amount: 1000n,
        bridge: 'stargate',
        quoteData: {},
      });

      store.completeTransfer(transfer.id, 990n, toToken, toChain);

      expect(store.getActiveTransfers()).toHaveLength(0);
      expect(store.getCompletedTransfers()).toHaveLength(1);

      const completed = store.getCompletedTransfers()[0];
      expect(completed.id).toBe(transfer.id);
      expect(completed.fromAmount).toBe(1000n);
      expect(completed.toAmount).toBe(990n);
      expect(completed.status).toBe('completed');
    });

    it('completeTransfer with 0 received marks as failed', () => {
      const transfer = store.createTransfer({
        txHash: '0xabc',
        fromChain,
        toChain,
        fromToken,
        toToken,
        amount: 1000n,
        bridge: 'stargate',
        quoteData: {},
      });

      store.completeTransfer(transfer.id, 0n, toToken, toChain);

      const completed = store.getCompletedTransfers()[0];
      expect(completed.status).toBe('failed');
    });

    it('completeTransfer silently ignores non-existent transfer', () => {
      // Should not throw
      store.completeTransfer(transferId('nonexistent'), 100n, toToken, toChain);
    });

    it('getInFlightByChainAndToken filters correctly', () => {
      store.createTransfer({
        txHash: '0x1',
        fromChain,
        toChain,
        fromToken,
        toToken,
        amount: 100n,
        bridge: 'stargate',
        quoteData: {},
      });

      store.createTransfer({
        txHash: '0x2',
        fromChain: toChain, // different chain
        toChain: fromChain,
        fromToken: toToken,
        toToken: fromToken,
        amount: 200n,
        bridge: 'hop',
        quoteData: {},
      });

      const filtered = store.getInFlightByChainAndToken(fromChain, fromToken);
      expect(filtered).toHaveLength(1);
      expect(filtered[0].txHash).toBe('0x1');
    });
  });

  // --- Events ---

  describe('events', () => {
    it('emits balance.updated on setBalance', () => {
      const listener = vi.fn();
      store.emitter.on('balance.updated', listener);

      const chain = chainId(1);
      const token = tokenAddress('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
      store.setBalance(chain, token, 1000n, 1.0, 'USDC', 6);

      expect(listener).toHaveBeenCalledTimes(1);
      const emitted = listener.mock.calls[0][0] as BalanceEntry;
      expect(emitted.amount).toBe(1000n);
      expect(emitted.chainId).toBe(chain);
    });

    it('emits transfer.created on createTransfer', () => {
      const listener = vi.fn();
      store.emitter.on('transfer.created', listener);

      store.createTransfer({
        txHash: '0xabc',
        fromChain: chainId(1),
        toChain: chainId(42161),
        fromToken: tokenAddress('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'),
        toToken: tokenAddress('0xaf88d065e77c8cc2239327c5edb3a432268e5831'),
        amount: 500n,
        bridge: 'stargate',
        quoteData: {},
      });

      expect(listener).toHaveBeenCalledTimes(1);
      const emitted = listener.mock.calls[0][0] as InFlightTransfer;
      expect(emitted.amount).toBe(500n);
    });

    it('emits transfer.updated on updateTransferStatus', () => {
      const listener = vi.fn();
      store.emitter.on('transfer.updated', listener);

      const transfer = store.createTransfer({
        txHash: '0xabc',
        fromChain: chainId(1),
        toChain: chainId(42161),
        fromToken: tokenAddress('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'),
        toToken: tokenAddress('0xaf88d065e77c8cc2239327c5edb3a432268e5831'),
        amount: 500n,
        bridge: 'stargate',
        quoteData: {},
      });

      store.updateTransferStatus(transfer.id, 'pending');

      expect(listener).toHaveBeenCalledTimes(1);
      const emitted = listener.mock.calls[0][0] as InFlightTransfer;
      expect(emitted.status).toBe('pending');
    });

    it('emits transfer.completed on completeTransfer', () => {
      const listener = vi.fn();
      store.emitter.on('transfer.completed', listener);

      const transfer = store.createTransfer({
        txHash: '0xabc',
        fromChain: chainId(1),
        toChain: chainId(42161),
        fromToken: tokenAddress('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'),
        toToken: tokenAddress('0xaf88d065e77c8cc2239327c5edb3a432268e5831'),
        amount: 500n,
        bridge: 'stargate',
        quoteData: {},
      });

      const toToken = tokenAddress('0xaf88d065e77c8cc2239327c5edb3a432268e5831');
      const toChain = chainId(42161);
      store.completeTransfer(transfer.id, 490n, toToken, toChain);

      expect(listener).toHaveBeenCalledTimes(1);
      const emitted = listener.mock.calls[0][0] as CompletedTransfer;
      expect(emitted.toAmount).toBe(490n);
      expect(emitted.status).toBe('completed');
    });

    it('emits price.updated on setPrice', () => {
      const listener = vi.fn();
      store.emitter.on('price.updated', listener);

      const chain = chainId(1);
      const token = tokenAddress('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
      store.setPrice(chain, token, 1.0);

      expect(listener).toHaveBeenCalledTimes(1);
      const emitted = listener.mock.calls[0][0] as PriceEntry;
      expect(emitted.priceUsd).toBe(1.0);
    });

    it('emits position.updated on setPosition', () => {
      const listener = vi.fn();
      store.emitter.on('position.updated', listener);

      const position: Position = {
        id: 'pos-1',
        strategyId: 'strat-1',
        chainId: chainId(1),
        tokenAddress: tokenAddress('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'),
        entryPrice: 1.0,
        currentPrice: 1.05,
        amount: 1000n,
        enteredAt: Date.now(),
        pnlUsd: 50,
        pnlPercent: 5,
      };

      store.setPosition(position);

      expect(listener).toHaveBeenCalledTimes(1);
    });
  });

  // --- Positions ---

  describe('positions', () => {
    it('sets and gets a position', () => {
      const position: Position = {
        id: 'pos-1',
        strategyId: 'strat-1',
        chainId: chainId(1),
        tokenAddress: tokenAddress('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'),
        entryPrice: 1.0,
        currentPrice: 1.05,
        amount: 1000n,
        enteredAt: Date.now(),
        pnlUsd: 50,
        pnlPercent: 5,
      };

      store.setPosition(position);
      expect(store.getPosition('pos-1')).toEqual(position);
    });

    it('returns undefined for non-existent position', () => {
      expect(store.getPosition('nonexistent')).toBeUndefined();
    });

    it('getAllPositions returns all entries', () => {
      store.setPosition({
        id: 'pos-1',
        strategyId: 'strat-1',
        chainId: chainId(1),
        tokenAddress: tokenAddress('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'),
        entryPrice: 1.0,
        currentPrice: 1.0,
        amount: 100n,
        enteredAt: Date.now(),
        pnlUsd: 0,
        pnlPercent: 0,
      });

      store.setPosition({
        id: 'pos-2',
        strategyId: 'strat-2',
        chainId: chainId(42161),
        tokenAddress: tokenAddress('0xaf88d065e77c8cc2239327c5edb3a432268e5831'),
        entryPrice: 2.0,
        currentPrice: 2.1,
        amount: 200n,
        enteredAt: Date.now(),
        pnlUsd: 10,
        pnlPercent: 5,
      });

      expect(store.getAllPositions()).toHaveLength(2);
    });
  });

  // --- Prices ---

  describe('prices', () => {
    it('sets and gets a price', () => {
      const chain = chainId(1);
      const token = tokenAddress('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');

      store.setPrice(chain, token, 1.001);

      const price = store.getPrice(chain, token);
      expect(price).toBeDefined();
      expect(price!.priceUsd).toBe(1.001);
      expect(price!.chainId).toBe(chain);
    });

    it('returns undefined for non-existent price', () => {
      expect(
        store.getPrice(chainId(1), tokenAddress('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48')),
      ).toBeUndefined();
    });
  });

  // --- Trades ---

  describe('trades', () => {
    it('adds and retrieves a trade', () => {
      const trade = {
        id: 'trade-1',
        strategyId: 'strat-1',
        fromChain: chainId(1),
        toChain: chainId(42161),
        fromToken: tokenAddress('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'),
        toToken: tokenAddress('0xaf88d065e77c8cc2239327c5edb3a432268e5831'),
        fromAmount: 1000n,
        toAmount: 995n,
        pnlUsd: -0.5,
        executedAt: Date.now(),
      };

      store.addTrade(trade);
      expect(store.getTrade('trade-1')).toEqual(trade);
    });

    it('getAllTrades returns all entries', () => {
      store.addTrade({
        id: 'trade-1',
        strategyId: 'strat-1',
        fromChain: chainId(1),
        toChain: chainId(42161),
        fromToken: tokenAddress('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'),
        toToken: tokenAddress('0xaf88d065e77c8cc2239327c5edb3a432268e5831'),
        fromAmount: 1000n,
        toAmount: 995n,
        pnlUsd: -0.5,
        executedAt: Date.now(),
      });

      expect(store.getAllTrades()).toHaveLength(1);
    });
  });

  // --- Restore ---

  describe('restoreTransfer', () => {
    it('restores a transfer into active transfers', () => {
      const transfer: InFlightTransfer = {
        id: transferId('restored-1'),
        txHash: '0xabc',
        fromChain: chainId(1),
        toChain: chainId(42161),
        fromToken: tokenAddress('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'),
        toToken: tokenAddress('0xaf88d065e77c8cc2239327c5edb3a432268e5831'),
        amount: 1000n,
        bridge: 'stargate',
        status: 'in_flight',
        quoteData: {},
        createdAt: Date.now() - 60000,
        updatedAt: Date.now() - 60000,
        recovered: true,
      };

      store.restoreTransfer(transfer);

      const active = store.getActiveTransfers();
      expect(active).toHaveLength(1);
      expect(active[0].id).toBe('restored-1');
      expect(active[0].recovered).toBe(true);
    });
  });
});
