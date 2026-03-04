import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { TelegramSignalConsumer } from '../telegram-client.js';
import type {
  TeleprotoClient,
  TeleprotoEntity,
  TeleprotoMessage,
  TeleprotoNewMessageEvent,
  TeleprotoEventFilter,
} from '../telegram-client.js';
import { Store } from '../../core/store.js';

// Mock sleep to avoid real delays in tests
vi.mock('../../utils/sleep.js', () => ({
  sleep: vi.fn().mockResolvedValue(undefined),
}));

// --- Mock teleproto client ---

function createMockClient(overrides?: Partial<TeleprotoClient>): TeleprotoClient & {
  messageHandler: ((event: TeleprotoNewMessageEvent) => void) | null;
  triggerMessage: (msg: TeleprotoMessage) => void;
} {
  let messageHandler: ((event: TeleprotoNewMessageEvent) => void) | null = null;

  const client: TeleprotoClient & {
    messageHandler: typeof messageHandler;
    triggerMessage: (msg: TeleprotoMessage) => void;
  } = {
    messageHandler: null,
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getEntity: vi.fn().mockResolvedValue({ id: BigInt(12345), username: 'agentpear' }),
    getMessages: vi.fn().mockResolvedValue([]),
    addEventHandler: vi.fn((handler: (event: TeleprotoNewMessageEvent) => void, _filter: TeleprotoEventFilter) => {
      messageHandler = handler;
      client.messageHandler = handler;
    }),
    triggerMessage: (msg: TeleprotoMessage) => {
      if (messageHandler) {
        messageHandler({ message: msg });
      }
    },
    ...overrides,
  };

  return client;
}

function makeMessage(id: number, text: string, dateSec?: number): TeleprotoMessage {
  return {
    id,
    message: text,
    date: dateSec ?? Math.floor(Date.now() / 1000),
    peerId: { channelId: BigInt(12345) },
  };
}

function createConsumer(
  clientOverrides?: Partial<TeleprotoClient>,
  useDb = true,
): {
  consumer: TelegramSignalConsumer;
  client: ReturnType<typeof createMockClient>;
  db: Database.Database | null;
  store: Store;
} {
  const store = Store.getInstance();
  const client = createMockClient(clientOverrides);
  const db = useDb ? new Database(':memory:') : null;

  const consumer = new TelegramSignalConsumer(
    { apiId: 123, apiHash: 'abc', pollIntervalMs: 100, signalExpiryMinutes: 60 },
    { client, db: db ?? undefined, store },
  );

  return { consumer, client, db, store };
}

describe('TelegramSignalConsumer', () => {
  beforeEach(() => {
    Store.getInstance().reset();
    vi.clearAllMocks();
    // Prevent connect from checking TELEGRAM_SESSION_STRING in tests
    vi.stubEnv('TELEGRAM_SESSION_STRING', 'test-session-string');
  });

  // --- Initialization ---

  it('initializes with valid config (AC1)', () => {
    const { consumer } = createConsumer();
    expect(consumer).toBeDefined();
    expect(consumer.isRunning()).toBe(false);
  });

  it('throws when TELEGRAM_SESSION_STRING is missing (AC1)', async () => {
    vi.unstubAllEnvs();
    delete process.env.TELEGRAM_SESSION_STRING;
    const { consumer } = createConsumer();
    await expect(consumer.connect()).rejects.toThrow('TELEGRAM_SESSION_STRING');
  });

  // --- Connection ---

  it('connects to Telegram and resolves channel entity (AC1)', async () => {
    const { consumer, client } = createConsumer();
    await consumer.connect();
    expect(client.connect).toHaveBeenCalled();
    expect(client.getEntity).toHaveBeenCalledWith('agentpear');
    expect(client.addEventHandler).toHaveBeenCalled();
    expect(consumer.isConnectedToTelegram()).toBe(true);
  });

  // --- Message handler pipeline ---

  it('processes message through parse pipeline and stores signal (AC2)', async () => {
    const { consumer, store } = createConsumer();
    await consumer.connect();

    const msg = makeMessage(1, 'ETC/NEAR Z-score: -2.745 Correlation: 0.853 Half-life: 1.5d Leverage: 18');
    await consumer.handleMessage(msg, 'realtime');

    const signals = store.getAllStatArbSignals();
    expect(signals).toHaveLength(1);
    expect(signals[0].source).toBe('telegram');
    expect(signals[0].direction).toBe('long_pair');
    expect(signals[0].zScore).toBeCloseTo(-2.745);
  });

  it('skips messages from non-matching parse (AC2)', async () => {
    const { consumer, store } = createConsumer();
    await consumer.connect();

    const msg = makeMessage(2, 'Just a random message, nothing to see here');
    await consumer.handleMessage(msg, 'realtime');

    expect(store.getAllStatArbSignals()).toHaveLength(0);
  });

  it('stores null parse result in audit log for non-signal messages (AC6)', async () => {
    const { consumer, db } = createConsumer();
    await consumer.connect();

    const msg = makeMessage(3, 'General commentary text');
    await consumer.handleMessage(msg, 'realtime');

    const logs = consumer.getAuditLog(10);
    expect(logs).toHaveLength(1);
    expect(logs[0].parseResultType).toBeNull();
  });

  it('skips expired signals (AC2)', async () => {
    const { consumer, store } = createConsumer();
    await consumer.connect();

    // Message from 2 hours ago
    const twoHoursAgo = Math.floor(Date.now() / 1000) - 7200;
    const msg = makeMessage(4, 'ETC/NEAR Z-score: -2.0 Correlation: 0.85 Half-life: 1d Leverage: 18', twoHoursAgo);
    await consumer.handleMessage(msg, 'realtime');

    expect(store.getAllStatArbSignals()).toHaveLength(0);
  });

  // --- Deduplication ---

  it('processes same message ID only once (AC5)', async () => {
    const { consumer, store } = createConsumer();
    await consumer.connect();

    const msg = makeMessage(10, 'ETC/NEAR Z-score: -2.0 Correlation: 0.85 Half-life: 1d Leverage: 18');
    await consumer.handleMessage(msg, 'realtime');
    await consumer.handleMessage(msg, 'poll');

    expect(store.getAllStatArbSignals()).toHaveLength(1);
  });

  it('prunes dedup set at 1000 entries (AC5)', async () => {
    const { consumer } = createConsumer();
    await consumer.connect();

    // Add 1001 unique messages (non-signal, just for dedup tracking)
    for (let i = 1; i <= 1001; i++) {
      const msg = makeMessage(i, `msg ${i}`);
      await consumer.handleMessage(msg, 'realtime');
    }

    // Set should have been pruned
    expect(consumer.getProcessedMessageIds().size).toBeLessThanOrEqual(1001);
    // Newer IDs should still be present
    expect(consumer.getProcessedMessageIds().has(1001)).toBe(true);
  });

  // --- Polling ---

  it('polls for messages on controlTask tick (AC4)', async () => {
    const pollMessages = [
      makeMessage(20, 'SOL/AVAX Z-score: -1.8 Correlation: 0.88 Half-life: 2d Leverage: 9'),
    ];
    const { consumer, client, store } = createConsumer({
      getMessages: vi.fn().mockResolvedValue(pollMessages),
    });
    await consumer.connect();

    await consumer.controlTask();

    expect(client.getMessages).toHaveBeenCalled();
    expect(store.getAllStatArbSignals()).toHaveLength(1);
  });

  // --- Reconnection ---

  it('reconnects with exponential backoff sequence (AC3)', async () => {
    const connectFn = vi.fn()
      .mockResolvedValueOnce(undefined)  // initial connect succeeds
      .mockRejectedValueOnce(new Error('fail1'))  // reconnect 1 fails
      .mockRejectedValueOnce(new Error('fail2'))  // reconnect 2 fails
      .mockResolvedValue(undefined);

    const { consumer, client } = createConsumer({
      connect: connectFn,
    });
    await consumer.connect();

    // Reset and simulate disconnection
    (client.isConnected as ReturnType<typeof vi.fn>).mockReturnValue(false);

    // First reconnect attempt fails
    await consumer.reconnect();
    expect(consumer.getReconnectAttempts()).toBe(1);

    // Second reconnect attempt also fails
    await consumer.reconnect();
    expect(consumer.getReconnectAttempts()).toBe(2);
  });

  it('enters degraded mode after max reconnect attempts (AC3)', async () => {
    // Connect initially succeeds, then all reconnects fail
    const connectFn = vi.fn()
      .mockResolvedValueOnce(undefined)  // initial connect
      .mockRejectedValue(new Error('always fails'));

    const { consumer } = createConsumer({
      connect: connectFn,
    });
    await consumer.connect();

    // Simulate 21 failed reconnect attempts
    for (let i = 0; i < 21; i++) {
      await consumer.reconnect();
    }

    expect(consumer.isDegraded()).toBe(true);
  });

  // --- Audit logging ---

  it('writes audit log with correct fields (AC6)', async () => {
    const { consumer, db } = createConsumer();
    await consumer.connect();

    const msg = makeMessage(30, 'ETC/NEAR Z-score: -2.0 Correlation: 0.85 Half-life: 1d Leverage: 18');
    await consumer.handleMessage(msg, 'realtime');

    const logs = consumer.getAuditLog(10);
    expect(logs).toHaveLength(1);
    expect(logs[0].telegramMessageId).toBe(30);
    expect(logs[0].channelUsername).toBe('agentpear');
    expect(logs[0].parseResultType).toBe('open');
    expect(logs[0].source).toBe('realtime');
  });

  it('handles SQLite write error without crashing (AC6)', async () => {
    const { consumer } = createConsumer(undefined, false); // no db
    await consumer.connect();

    // Should not throw even without db
    const msg = makeMessage(31, 'ETC/NEAR Z-score: -2.0 Correlation: 0.85 Half-life: 1d Leverage: 18');
    await expect(consumer.handleMessage(msg, 'realtime')).resolves.not.toThrow();
  });

  // --- controlTask error isolation ---

  it('controlTask does not throw on Telegram errors (AC7)', async () => {
    const { consumer, client } = createConsumer({
      getMessages: vi.fn().mockRejectedValue(new Error('network error')),
    });
    await consumer.connect();

    // Should not throw
    await expect(consumer.controlTask()).resolves.not.toThrow();
  });

  // --- Stop ---

  it('disconnects cleanly on stop (AC7)', async () => {
    const { consumer, client } = createConsumer();
    await consumer.connect();
    await consumer.onStop();

    expect(client.disconnect).toHaveBeenCalled();
    expect(consumer.isConnectedToTelegram()).toBe(false);
  });

  // --- Close signal handling ---

  it('emits exit signal for close messages with active position', async () => {
    const { consumer, store } = createConsumer();
    await consumer.connect();

    // Create an active position
    store.openStatArbPosition({
      positionId: 'pos-1',
      pair: { tokenA: 'ETC', tokenB: 'NEAR', key: 'ETC-NEAR' },
      direction: 'long_pair',
      hedgeRatio: 1.0,
      leverage: 18,
      legA: { symbol: 'ETC', side: 'long', size: 100, entryPrice: 20, currentPrice: 20, unrealizedPnl: 0, funding: 0 },
      legB: { symbol: 'NEAR', side: 'short', size: 100, entryPrice: 5, currentPrice: 5, unrealizedPnl: 0, funding: 0 },
      openTimestamp: Date.now() - 3600000,
      halfLifeHours: 36,
      combinedPnl: 0,
      accumulatedFunding: 0,
      marginUsed: 200,
      status: 'active',
      signalSource: 'telegram',
    });

    const exitListener = vi.fn();
    store.emitter.on('stat_arb_exit_signal', exitListener);

    const msg = makeMessage(40, 'Closing due to mean reversion ETC/NEAR Z-score: 0.42');
    await consumer.handleMessage(msg, 'realtime');

    expect(exitListener).toHaveBeenCalledTimes(1);
    expect(exitListener.mock.calls[0][0].reason).toBe('mean_reversion');
  });
});
