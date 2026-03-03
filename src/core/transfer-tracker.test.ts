import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { TransferTracker } from './transfer-tracker.js';
import { Store } from './store.js';
import { ActionQueue } from './action-queue.js';
import { TerminalStatusHandler } from './terminal-handlers.js';
import { StatusPoller } from '../connectors/status-poller.js';
import { chainId, tokenAddress, transferId } from './types.js';
import type { InFlightTransfer, TransferStatus } from './types.js';
import type { LiFiConnectorInterface } from '../connectors/types.js';

function createMockConnector(): LiFiConnectorInterface {
  return {
    getQuote: vi.fn(),
    getRoutes: vi.fn(),
    getChains: vi.fn(),
    getTokens: vi.fn(),
    getStatus: vi.fn(),
    getConnections: vi.fn(),
    getTools: vi.fn(),
  };
}

function createTestTransfer(id: string, overrides: Partial<InFlightTransfer> = {}): InFlightTransfer {
  return {
    id: transferId(id),
    txHash: `0x${id}hash`,
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

const noopSleep = () => Promise.resolve();
// A sleep that yields to the event loop so abort signals can be processed
const yieldSleep = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const DONE_RESPONSE = {
  status: 'DONE',
  substatus: 'COMPLETED',
  receiving: {
    amount: '995000',
    token: {
      address: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
      symbol: 'USDC',
      decimals: 6,
      chainId: 42161,
      name: 'USD Coin',
    },
    chainId: 42161,
  },
};

describe('TransferTracker', () => {
  let store: Store;
  let actionQueue: ActionQueue;
  let terminalHandler: TerminalStatusHandler;
  let mockConnector: ReturnType<typeof createMockConnector>;
  let statusPoller: StatusPoller;
  let tracker: TransferTracker;

  beforeEach(() => {
    Store.getInstance().reset();
    store = Store.getInstance();
    actionQueue = new ActionQueue();
    terminalHandler = new TerminalStatusHandler(store, actionQueue);
    mockConnector = createMockConnector();
    statusPoller = new StatusPoller(mockConnector, { sleep: noopSleep });
    tracker = new TransferTracker(statusPoller, terminalHandler);
  });

  describe('trackTransfer', () => {
    it('tracks a transfer and resolves when terminal status reached', async () => {
      const transfer = createTestTransfer('t1');
      store.restoreTransfer(transfer);

      (mockConnector.getStatus as ReturnType<typeof vi.fn>).mockResolvedValue(DONE_RESPONSE);

      const result = await tracker.trackTransfer(transfer);

      expect(result.status).toBe('completed');
      expect(result.transferId).toBe(transfer.id);
      expect(result.receivedAmount).toBe(995000n);
    });

    it('removes transfer from tracked map after completion', async () => {
      const transfer = createTestTransfer('t1');
      store.restoreTransfer(transfer);

      (mockConnector.getStatus as ReturnType<typeof vi.fn>).mockResolvedValue(DONE_RESPONSE);

      await tracker.trackTransfer(transfer);

      expect(tracker.getActiveCount()).toBe(0);
    });

    it('returns existing promise when tracking same transfer twice', async () => {
      const transfer = createTestTransfer('t1');
      store.restoreTransfer(transfer);

      (mockConnector.getStatus as ReturnType<typeof vi.fn>).mockResolvedValue(DONE_RESPONSE);

      const promise1 = tracker.trackTransfer(transfer);
      const promise2 = tracker.trackTransfer(transfer);

      expect(promise1).toBe(promise2);

      await promise1;
    });

    it('rejects when txHash is null', async () => {
      const transfer = createTestTransfer('t1', { txHash: null });

      await expect(tracker.trackTransfer(transfer)).rejects.toThrow('txHash is null');
    });
  });

  describe('concurrent transfers', () => {
    it('tracks multiple concurrent transfers', async () => {
      const transfer1 = createTestTransfer('t1');
      const transfer2 = createTestTransfer('t2');
      store.restoreTransfer(transfer1);
      store.restoreTransfer(transfer2);

      (mockConnector.getStatus as ReturnType<typeof vi.fn>).mockResolvedValue(DONE_RESPONSE);

      const promise1 = tracker.trackTransfer(transfer1);
      const promise2 = tracker.trackTransfer(transfer2);

      expect(tracker.getActiveCount()).toBe(2);

      const [result1, result2] = await Promise.all([promise1, promise2]);

      expect(result1.status).toBe('completed');
      expect(result2.status).toBe('completed');
      expect(tracker.getActiveCount()).toBe(0);
    });

    it('rejects when max concurrent limit reached', async () => {
      // Use a poller with very short timeout to ensure cleanup
      const shortPoller = new StatusPoller(mockConnector, {
        sleep: noopSleep,
        maxDurationMs: 1,
      });
      const smallTracker = new TransferTracker(shortPoller, terminalHandler, 2);

      // getStatus returns PENDING — the poller will time out quickly because maxDurationMs=1
      (mockConnector.getStatus as ReturnType<typeof vi.fn>).mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve({ status: 'PENDING' }), 5)),
      );

      const t1 = createTestTransfer('t1');
      const t2 = createTestTransfer('t2');
      const t3 = createTestTransfer('t3');
      store.restoreTransfer(t1);
      store.restoreTransfer(t2);
      store.restoreTransfer(t3);

      // Track first two — these are pending, filling up the limit
      const p1 = smallTracker.trackTransfer(t1);
      const p2 = smallTracker.trackTransfer(t2);

      // Third should be rejected
      await expect(smallTracker.trackTransfer(t3)).rejects.toThrow('Max concurrent transfers reached');

      // Let the existing trackers complete via timeout
      await Promise.all([p1, p2]);
    });
  });

  describe('cancelTracking', () => {
    it('cancels tracking for a specific transfer', async () => {
      (mockConnector.getStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
        status: 'PENDING',
      });

      const transfer = createTestTransfer('t1');
      store.restoreTransfer(transfer);

      const fastPoller = new StatusPoller(mockConnector, {
        sleep: yieldSleep,
        maxDurationMs: 60_000,
      });
      const fastTracker = new TransferTracker(fastPoller, terminalHandler);

      const promise = fastTracker.trackTransfer(transfer);

      // Give it a tick to start polling (yieldSleep allows event loop to run)
      await new Promise((resolve) => setTimeout(resolve, 50));

      fastTracker.cancelTracking(transfer.id as string);

      const result = await promise;

      // Should resolve with FAILED due to abort
      expect(result.status).toBe('failed');
    });
  });

  describe('cancelAll', () => {
    it('cancels all active tracking', async () => {
      (mockConnector.getStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
        status: 'PENDING',
      });

      const fastPoller = new StatusPoller(mockConnector, {
        sleep: yieldSleep,
        maxDurationMs: 60_000,
      });
      const fastTracker = new TransferTracker(fastPoller, terminalHandler);

      const t1 = createTestTransfer('t1');
      const t2 = createTestTransfer('t2');
      store.restoreTransfer(t1);
      store.restoreTransfer(t2);

      const p1 = fastTracker.trackTransfer(t1);
      const p2 = fastTracker.trackTransfer(t2);

      // Give a tick for polling to start (yieldSleep allows event loop to run)
      await new Promise((resolve) => setTimeout(resolve, 50));

      fastTracker.cancelAll();

      const [r1, r2] = await Promise.all([p1, p2]);

      expect(r1.status).toBe('failed');
      expect(r2.status).toBe('failed');
    });
  });

  describe('getActiveCount', () => {
    it('returns 0 when no transfers are tracked', () => {
      expect(tracker.getActiveCount()).toBe(0);
    });

    it('increments when transfers are added and decrements after completion', async () => {
      // Return PENDING first, then DONE on second call
      const getStatusMock = mockConnector.getStatus as ReturnType<typeof vi.fn>;
      getStatusMock
        .mockResolvedValueOnce({ status: 'PENDING' })
        .mockResolvedValueOnce(DONE_RESPONSE);

      const transfer = createTestTransfer('t1');
      store.restoreTransfer(transfer);

      const promise = tracker.trackTransfer(transfer);

      // Active count should be 1 immediately after starting
      expect(tracker.getActiveCount()).toBe(1);

      // Wait for completion
      await promise;

      // After completion, count should be 0
      expect(tracker.getActiveCount()).toBe(0);
    });
  });
});
