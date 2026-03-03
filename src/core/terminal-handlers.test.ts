import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TerminalStatusHandler } from './terminal-handlers.js';
import { Store } from './store.js';
import { ActionQueue } from './action-queue.js';
import { chainId, tokenAddress, transferId } from './types.js';
import type { InFlightTransfer, TransferStatus } from './types.js';
import type { StatusUpdate } from '../connectors/status-parser.js';

function createTestTransfer(overrides: Partial<InFlightTransfer> = {}): InFlightTransfer {
  return {
    id: transferId('test-transfer-1'),
    txHash: '0xabc123',
    fromChain: chainId(1),
    toChain: chainId(42161),
    fromToken: tokenAddress('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'),
    toToken: tokenAddress('0xaf88d065e77c8cc2239327c5edb3a432268e5831'),
    amount: 1000000n,
    bridge: 'stargate',
    status: 'in_flight' as TransferStatus,
    quoteData: {},
    createdAt: Date.now(),
    updatedAt: Date.now(),
    recovered: false,
    ...overrides,
  };
}

describe('TerminalStatusHandler', () => {
  let store: Store;
  let actionQueue: ActionQueue;
  let handler: TerminalStatusHandler;

  beforeEach(() => {
    Store.getInstance().reset();
    store = Store.getInstance();
    actionQueue = new ActionQueue();
    handler = new TerminalStatusHandler(store, actionQueue);
  });

  describe('handleTerminalStatus dispatch', () => {
    it('dispatches DONE/COMPLETED to handleCompleted', () => {
      const transfer = createTestTransfer();
      store.restoreTransfer(transfer);

      const status: StatusUpdate = {
        status: 'DONE',
        substatus: 'COMPLETED',
        receiving: {
          amount: '995000',
          token: {
            address: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
            symbol: 'USDC',
            decimals: 6,
            chainId: 42161,
          },
          chainId: 42161,
        },
      };

      const result = handler.handleTerminalStatus(transfer, status);
      expect(result.status).toBe('completed');
    });

    it('dispatches DONE/PARTIAL to handlePartial', () => {
      const transfer = createTestTransfer();
      store.restoreTransfer(transfer);

      const status: StatusUpdate = {
        status: 'DONE',
        substatus: 'PARTIAL',
        receiving: {
          amount: '500000',
          token: {
            address: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
            symbol: 'USDC',
            decimals: 6,
            chainId: 42161,
          },
          chainId: 42161,
        },
      };

      const result = handler.handleTerminalStatus(transfer, status);
      expect(result.status).toBe('partial');
    });

    it('dispatches DONE/REFUNDED to handleRefunded', () => {
      const transfer = createTestTransfer();
      store.restoreTransfer(transfer);

      const status: StatusUpdate = {
        status: 'DONE',
        substatus: 'REFUNDED',
      };

      const result = handler.handleTerminalStatus(transfer, status);
      expect(result.status).toBe('refunded');
    });

    it('dispatches FAILED to handleFailed', () => {
      const transfer = createTestTransfer();
      store.restoreTransfer(transfer);

      const status: StatusUpdate = {
        status: 'FAILED',
      };

      const result = handler.handleTerminalStatus(transfer, status);
      expect(result.status).toBe('failed');
    });

    it('treats DONE without substatus as completed', () => {
      const transfer = createTestTransfer();
      store.restoreTransfer(transfer);

      const status: StatusUpdate = {
        status: 'DONE',
        receiving: {
          amount: '990000',
          token: {
            address: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
            symbol: 'USDC',
            decimals: 6,
            chainId: 42161,
          },
          chainId: 42161,
        },
      };

      const result = handler.handleTerminalStatus(transfer, status);
      expect(result.status).toBe('completed');
    });
  });

  describe('COMPLETED handler', () => {
    it('updates destination balance in store', () => {
      const transfer = createTestTransfer();
      store.restoreTransfer(transfer);

      const status: StatusUpdate = {
        status: 'DONE',
        substatus: 'COMPLETED',
        receiving: {
          amount: '995000',
          token: {
            address: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
            symbol: 'USDC',
            decimals: 6,
            chainId: 42161,
          },
          chainId: 42161,
        },
      };

      handler.handleTerminalStatus(transfer, status);

      const balance = store.getBalance(
        chainId(42161),
        tokenAddress('0xaf88d065e77c8cc2239327c5edb3a432268e5831'),
      );
      expect(balance).toBeDefined();
      expect(balance!.amount).toBe(995000n);
      expect(balance!.symbol).toBe('USDC');
      expect(balance!.decimals).toBe(6);
    });

    it('adds to existing balance on destination chain', () => {
      const destChain = chainId(42161);
      const destToken = tokenAddress('0xaf88d065e77c8cc2239327c5edb3a432268e5831');
      store.setBalance(destChain, destToken, 500000n, 0.5, 'USDC', 6);

      const transfer = createTestTransfer();
      store.restoreTransfer(transfer);

      const status: StatusUpdate = {
        status: 'DONE',
        substatus: 'COMPLETED',
        receiving: {
          amount: '995000',
          token: { address: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', symbol: 'USDC', decimals: 6, chainId: 42161 },
          chainId: 42161,
        },
      };

      handler.handleTerminalStatus(transfer, status);

      const balance = store.getBalance(destChain, destToken);
      expect(balance!.amount).toBe(1495000n); // 500000 + 995000
    });

    it('moves transfer from active to completed in store', () => {
      const transfer = createTestTransfer();
      store.restoreTransfer(transfer);

      const status: StatusUpdate = {
        status: 'DONE',
        substatus: 'COMPLETED',
        receiving: {
          amount: '995000',
          token: { address: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', symbol: 'USDC', decimals: 6, chainId: 42161 },
          chainId: 42161,
        },
      };

      handler.handleTerminalStatus(transfer, status);

      expect(store.getActiveTransfers()).toHaveLength(0);
      expect(store.getCompletedTransfers()).toHaveLength(1);
    });

    it('returns correct TransferResult', () => {
      const transfer = createTestTransfer();
      store.restoreTransfer(transfer);

      const status: StatusUpdate = {
        status: 'DONE',
        substatus: 'COMPLETED',
        receiving: {
          amount: '995000',
          token: { address: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', symbol: 'USDC', decimals: 6, chainId: 42161 },
          chainId: 42161,
        },
      };

      const result = handler.handleTerminalStatus(transfer, status);

      expect(result.transferId).toBe(transfer.id);
      expect(result.status).toBe('completed');
      expect(result.receivedAmount).toBe(995000n);
      expect(result.receivedToken).toBe(tokenAddress('0xaf88d065e77c8cc2239327c5edb3a432268e5831'));
      expect(result.receivedChain).toBe(chainId(42161));
    });

    it('uses transfer defaults when receiving info is missing', () => {
      const transfer = createTestTransfer();
      store.restoreTransfer(transfer);

      const status: StatusUpdate = {
        status: 'DONE',
        substatus: 'COMPLETED',
      };

      const result = handler.handleTerminalStatus(transfer, status);

      expect(result.status).toBe('completed');
      expect(result.receivedAmount).toBe(0n);
      expect(result.receivedToken).toBe(transfer.toToken);
      expect(result.receivedChain).toBe(transfer.toChain);
    });
  });

  describe('PARTIAL handler', () => {
    it('updates balance with actual received amount', () => {
      const transfer = createTestTransfer();
      store.restoreTransfer(transfer);

      const status: StatusUpdate = {
        status: 'DONE',
        substatus: 'PARTIAL',
        receiving: {
          amount: '500000',
          token: { address: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', symbol: 'USDC', decimals: 6, chainId: 42161 },
          chainId: 42161,
        },
      };

      handler.handleTerminalStatus(transfer, status);

      const balance = store.getBalance(
        chainId(42161),
        tokenAddress('0xaf88d065e77c8cc2239327c5edb3a432268e5831'),
      );
      expect(balance!.amount).toBe(500000n);
    });

    it('creates follow-up swap action when actionQueue is provided', () => {
      const transfer = createTestTransfer();
      store.restoreTransfer(transfer);

      const status: StatusUpdate = {
        status: 'DONE',
        substatus: 'PARTIAL',
        receiving: {
          amount: '500000',
          token: { address: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', symbol: 'USDC', decimals: 6, chainId: 42161 },
          chainId: 42161,
        },
      };

      handler.handleTerminalStatus(transfer, status);

      expect(actionQueue.size()).toBe(1);
      const action = actionQueue.dequeue()!;
      expect(action.type).toBe('swap');
      expect((action as any).amount).toBe(500000n);
      expect((action as any).metadata.reason).toBe('partial-fill-recovery');
      expect((action as any).metadata.originalTransferId).toBe(transfer.id);
    });

    it('does not create follow-up action when actionQueue is not provided', () => {
      const handlerWithoutQueue = new TerminalStatusHandler(store);
      const transfer = createTestTransfer();
      store.restoreTransfer(transfer);

      const status: StatusUpdate = {
        status: 'DONE',
        substatus: 'PARTIAL',
        receiving: {
          amount: '500000',
          token: { address: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', symbol: 'USDC', decimals: 6, chainId: 42161 },
          chainId: 42161,
        },
      };

      // Should not throw
      const result = handlerWithoutQueue.handleTerminalStatus(transfer, status);
      expect(result.status).toBe('partial');
    });

    it('does not create follow-up action for 0 received amount', () => {
      const transfer = createTestTransfer();
      store.restoreTransfer(transfer);

      const status: StatusUpdate = {
        status: 'DONE',
        substatus: 'PARTIAL',
        // no receiving info → 0n received
      };

      handler.handleTerminalStatus(transfer, status);

      expect(actionQueue.size()).toBe(0);
    });

    it('returns partial TransferResult', () => {
      const transfer = createTestTransfer();
      store.restoreTransfer(transfer);

      const status: StatusUpdate = {
        status: 'DONE',
        substatus: 'PARTIAL',
        receiving: {
          amount: '500000',
          token: { address: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', symbol: 'USDC', decimals: 6, chainId: 42161 },
          chainId: 42161,
        },
      };

      const result = handler.handleTerminalStatus(transfer, status);

      expect(result.status).toBe('partial');
      expect(result.receivedAmount).toBe(500000n);
    });
  });

  describe('REFUNDED handler', () => {
    it('restores source chain balance', () => {
      const fromChainVal = chainId(1);
      const fromTokenVal = tokenAddress('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');

      // Set initial balance
      store.setBalance(fromChainVal, fromTokenVal, 5000000n, 5.0, 'USDC', 6);

      const transfer = createTestTransfer({ amount: 1000000n });
      store.restoreTransfer(transfer);

      const status: StatusUpdate = {
        status: 'DONE',
        substatus: 'REFUNDED',
      };

      handler.handleTerminalStatus(transfer, status);

      const balance = store.getBalance(fromChainVal, fromTokenVal);
      expect(balance!.amount).toBe(6000000n); // 5000000 + 1000000 restored
    });

    it('restores balance even when no prior balance entry exists', () => {
      const transfer = createTestTransfer({ amount: 1000000n });
      store.restoreTransfer(transfer);

      const status: StatusUpdate = {
        status: 'DONE',
        substatus: 'REFUNDED',
      };

      handler.handleTerminalStatus(transfer, status);

      const balance = store.getBalance(
        chainId(1),
        tokenAddress('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'),
      );
      expect(balance!.amount).toBe(1000000n);
    });

    it('completes transfer in store', () => {
      const transfer = createTestTransfer();
      store.restoreTransfer(transfer);

      const status: StatusUpdate = {
        status: 'DONE',
        substatus: 'REFUNDED',
      };

      handler.handleTerminalStatus(transfer, status);

      expect(store.getActiveTransfers()).toHaveLength(0);
      expect(store.getCompletedTransfers()).toHaveLength(1);
    });

    it('returns refunded TransferResult with source chain info', () => {
      const transfer = createTestTransfer();
      store.restoreTransfer(transfer);

      const status: StatusUpdate = {
        status: 'DONE',
        substatus: 'REFUNDED',
      };

      const result = handler.handleTerminalStatus(transfer, status);

      expect(result.status).toBe('refunded');
      expect(result.receivedAmount).toBe(0n);
      expect(result.receivedToken).toBe(transfer.fromToken);
      expect(result.receivedChain).toBe(transfer.fromChain);
    });
  });

  describe('FAILED handler', () => {
    it('completes transfer with 0 received in store', () => {
      const transfer = createTestTransfer();
      store.restoreTransfer(transfer);

      const status: StatusUpdate = {
        status: 'FAILED',
        substatusMessage: 'Transaction reverted',
      };

      handler.handleTerminalStatus(transfer, status);

      expect(store.getActiveTransfers()).toHaveLength(0);
      const completed = store.getCompletedTransfers();
      expect(completed).toHaveLength(1);
      expect(completed[0].status).toBe('failed');
    });

    it('returns failed TransferResult with null fields', () => {
      const transfer = createTestTransfer();
      store.restoreTransfer(transfer);

      const status: StatusUpdate = {
        status: 'FAILED',
      };

      const result = handler.handleTerminalStatus(transfer, status);

      expect(result.transferId).toBe(transfer.id);
      expect(result.status).toBe('failed');
      expect(result.receivedAmount).toBeNull();
      expect(result.receivedToken).toBeNull();
      expect(result.receivedChain).toBeNull();
    });
  });
});
