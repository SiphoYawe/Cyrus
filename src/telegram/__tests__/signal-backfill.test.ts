import { describe, it, expect, beforeEach, vi } from 'vitest';
import { backfillOnStartup } from '../signal-backfill.js';
import type { BackfillDeps } from '../signal-backfill.js';
import { AgentPearParser } from '../agent-pear-parser.js';
import { Store } from '../../core/store.js';
import type { TeleprotoClient, TeleprotoEntity, TeleprotoMessage } from '../telegram-client.js';

function makeMessage(id: number, text: string, dateSec?: number): TeleprotoMessage {
  return {
    id,
    message: text,
    date: dateSec ?? Math.floor(Date.now() / 1000),
    peerId: { channelId: BigInt(12345) },
  };
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function createDeps(messages: TeleprotoMessage[] = []): BackfillDeps & { store: Store; logFn: ReturnType<typeof vi.fn> } {
  const store = Store.getInstance();
  const logFn = vi.fn();
  return {
    client: {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      isConnected: vi.fn().mockReturnValue(true),
      getEntity: vi.fn().mockResolvedValue({ id: BigInt(12345) }),
      getMessages: vi.fn().mockResolvedValue(messages),
      addEventHandler: vi.fn(),
    },
    channelEntity: { id: BigInt(12345), username: 'agentpear' },
    parser: new AgentPearParser(),
    store,
    processedMessageIds: new Set<number>(),
    logMessageToDb: logFn,
    logFn,
  };
}

describe('backfillOnStartup', () => {
  beforeEach(() => {
    Store.getInstance().reset();
    vi.clearAllMocks();
  });

  it('fetches last 50 messages from channel history (AC1)', async () => {
    const deps = createDeps([]);
    await backfillOnStartup(deps, { backfillCount: 50 });
    expect(deps.client.getMessages).toHaveBeenCalledWith(
      deps.channelEntity,
      { limit: 50 },
    );
  });

  it('processes messages in chronological order (AC2)', async () => {
    const processOrder: number[] = [];
    const deps = createDeps([
      makeMessage(3, 'msg 3', nowSec() - 30),
      makeMessage(1, 'msg 1', nowSec() - 50),
      makeMessage(2, 'msg 2', nowSec() - 40),
    ]);

    const originalLog = deps.logMessageToDb!;
    deps.logMessageToDb = (msgId, text, result, source, ts) => {
      processOrder.push(msgId);
      originalLog(msgId, text, result, source, ts);
    };

    await backfillOnStartup(deps);

    // Should be sorted oldest first: 1, 2, 3
    expect(processOrder).toEqual([1, 2, 3]);
  });

  it('parses, normalizes, and stores open signals with original timestamps (AC2)', async () => {
    const signalTime = nowSec() - 300; // 5 minutes ago
    const deps = createDeps([
      makeMessage(10, 'ETC/NEAR Z-score: -2.0 Correlation: 0.85 Half-life: 1d Leverage: 18', signalTime),
    ]);

    const result = await backfillOnStartup(deps);

    expect(result.stored).toBe(1);
    const signals = deps.store.getAllStatArbSignals();
    expect(signals).toHaveLength(1);
    expect(signals[0].timestamp).toBe(signalTime * 1000);
    expect(signals[0].source).toBe('telegram');
  });

  it('discards expired signals (AC3)', async () => {
    const twoHoursAgo = nowSec() - 7200;
    const deps = createDeps([
      makeMessage(11, 'ETC/NEAR Z-score: -2.0 Correlation: 0.85 Half-life: 1d Leverage: 18', twoHoursAgo),
    ]);

    const result = await backfillOnStartup(deps, { signalExpiryMinutes: 60 });

    expect(result.expired).toBe(1);
    expect(result.stored).toBe(0);
    expect(deps.store.getAllStatArbSignals()).toHaveLength(0);
  });

  it('skips non-signal messages (parse returns null)', async () => {
    const deps = createDeps([
      makeMessage(12, 'Just some random text'),
    ]);

    const result = await backfillOnStartup(deps);

    expect(result.parsed).toBe(0);
    expect(result.stored).toBe(0);
  });

  it('handles open+close pair in same batch: marks open as consumed (AC4)', async () => {
    const t1 = nowSec() - 600; // 10 min ago: open
    const t2 = nowSec() - 300; // 5 min ago: close

    const deps = createDeps([
      makeMessage(20, 'ETC/NEAR Z-score: -2.0 Correlation: 0.85 Half-life: 1d Leverage: 18', t1),
      makeMessage(21, 'Closing due to mean reversion ETC/NEAR Z-score: 0.42', t2),
    ]);

    const result = await backfillOnStartup(deps);

    expect(result.closedPairs).toBe(1);
    expect(result.stored).toBe(1);
    const signals = deps.store.getAllStatArbSignals();
    expect(signals).toHaveLength(1);
    expect(signals[0].consumed).toBe(true);
  });

  it('close signal with no matching open is logged and skipped (AC4)', async () => {
    const deps = createDeps([
      makeMessage(22, 'Closing due to mean reversion BTC/ETH Z-score: 0.3', nowSec() - 300),
    ]);

    const result = await backfillOnStartup(deps);

    expect(result.closedPairs).toBe(0);
    expect(result.stored).toBe(0);
  });

  it('close signal matching existing open position emits exit signal (AC4)', async () => {
    const deps = createDeps([
      makeMessage(23, 'Closing due to mean reversion ETC/NEAR Z-score: 0.42', nowSec() - 300),
    ]);

    // Pre-create an active position
    deps.store.openStatArbPosition({
      positionId: 'pos-1',
      pair: { tokenA: 'ETC', tokenB: 'NEAR', key: 'ETC-NEAR' },
      direction: 'long_pair',
      hedgeRatio: 1.0,
      leverage: 18,
      legA: { symbol: 'ETC', side: 'long', size: 100, entryPrice: 20, currentPrice: 20, unrealizedPnl: 0, funding: 0 },
      legB: { symbol: 'NEAR', side: 'short', size: 100, entryPrice: 5, currentPrice: 5, unrealizedPnl: 0, funding: 0 },
      openTimestamp: Date.now() - 7200000,
      halfLifeHours: 36,
      combinedPnl: 0,
      accumulatedFunding: 0,
      marginUsed: 200,
      status: 'active',
      signalSource: 'telegram',
    });

    const exitListener = vi.fn();
    deps.store.emitter.on('stat_arb_exit_signal', exitListener);

    const result = await backfillOnStartup(deps);

    expect(result.closedPairs).toBe(1);
    expect(exitListener).toHaveBeenCalledTimes(1);
  });

  it('logs backfill messages to SQLite with source "backfill" (AC5)', async () => {
    const deps = createDeps([
      makeMessage(30, 'some message', nowSec() - 60),
    ]);

    await backfillOnStartup(deps);

    expect(deps.logFn).toHaveBeenCalledWith(
      30,
      'some message',
      null,
      'backfill',
      expect.any(Number),
    );
  });

  it('idempotent: running twice does not create duplicate signals (AC6)', async () => {
    const signalMsg = makeMessage(40, 'ETC/NEAR Z-score: -2.0 Correlation: 0.85 Half-life: 1d Leverage: 18', nowSec() - 300);

    // First run
    const deps1 = createDeps([signalMsg]);
    await backfillOnStartup(deps1);
    expect(deps1.store.getAllStatArbSignals()).toHaveLength(1);

    // Second run (same store, new dedup set)
    const deps2 = {
      ...deps1,
      processedMessageIds: new Set<number>(),
      client: {
        ...deps1.client,
        getMessages: vi.fn().mockResolvedValue([signalMsg]),
      },
    };
    await backfillOnStartup(deps2);

    // Should still have only 1 signal (idempotent by pair key)
    expect(deps1.store.getAllStatArbSignals()).toHaveLength(1);
  });

  it('newer signal replaces older signal for same pair (AC6)', async () => {
    const deps = createDeps([
      makeMessage(50, 'ETC/NEAR Z-score: -2.0 Correlation: 0.85 Half-life: 1d Leverage: 18', nowSec() - 600),
    ]);

    await backfillOnStartup(deps);
    const firstTimestamp = deps.store.getAllStatArbSignals()[0].timestamp;

    // Second run with newer signal
    const newerTime = nowSec() - 60;
    const deps2 = {
      ...deps,
      processedMessageIds: new Set<number>(),
      client: {
        ...deps.client,
        getMessages: vi.fn().mockResolvedValue([
          makeMessage(51, 'ETC/NEAR Z-score: -2.5 Correlation: 0.87 Half-life: 1d Leverage: 18', newerTime),
        ]),
      },
    };
    await backfillOnStartup(deps2);

    const signals = deps.store.getAllStatArbSignals();
    expect(signals).toHaveLength(1);
    expect(signals[0].timestamp).toBe(newerTime * 1000);
  });

  it('empty channel returns zero-count result', async () => {
    const deps = createDeps([]);
    const result = await backfillOnStartup(deps);

    expect(result.totalFetched).toBe(0);
    expect(result.stored).toBe(0);
  });

  it('individual message error does not stop remaining messages', async () => {
    const parser = new AgentPearParser();
    const originalParse = parser.parse.bind(parser);
    let callCount = 0;
    vi.spyOn(parser, 'parse').mockImplementation((text: string) => {
      callCount++;
      if (callCount === 1) throw new Error('parse explosion');
      return originalParse(text);
    });

    const deps = createDeps([
      makeMessage(60, 'ETC/NEAR Z-score: -2.0 Correlation: 0.85 Half-life: 1d Leverage: 18', nowSec() - 300),
      makeMessage(61, 'SOL/AVAX Z-score: -1.8 Correlation: 0.88 Half-life: 2d Leverage: 9', nowSec() - 200),
    ]);
    deps.parser = parser;

    const result = await backfillOnStartup(deps);

    expect(result.errors).toBe(1);
    expect(result.stored).toBe(1); // Second message still processed
  });

  it('complete backfill failure returns gracefully', async () => {
    const deps = createDeps([]);
    deps.client.getMessages = vi.fn().mockRejectedValue(new Error('network error'));

    const result = await backfillOnStartup(deps);

    expect(result.errors).toBe(1);
    expect(result.totalFetched).toBe(0);
  });

  it('result contains correct counts', async () => {
    const deps = createDeps([
      makeMessage(70, 'ETC/NEAR Z-score: -2.0 Correlation: 0.85 Half-life: 1d Leverage: 18', nowSec() - 300),
      makeMessage(71, 'random text', nowSec() - 250),
      makeMessage(72, 'SOL/AVAX Z-score: -1.8 Correlation: 0.88 Half-life: 2d Leverage: 9', nowSec() - 7200),
    ]);

    const result = await backfillOnStartup(deps);

    expect(result.totalFetched).toBe(3);
    expect(result.parsed).toBe(2); // 2 signals parsed (one expired)
    expect(result.stored).toBe(1); // Only 1 stored (second expired)
    expect(result.expired).toBe(1);
    expect(result.errors).toBe(0);
  });

  it('adds message IDs to dedup set after backfill', async () => {
    const dedupSet = new Set<number>();
    const deps = createDeps([
      makeMessage(80, 'some text', nowSec() - 300),
      makeMessage(81, 'more text', nowSec() - 200),
    ]);
    deps.processedMessageIds = dedupSet;

    await backfillOnStartup(deps);

    expect(dedupSet.has(80)).toBe(true);
    expect(dedupSet.has(81)).toBe(true);
  });
});
