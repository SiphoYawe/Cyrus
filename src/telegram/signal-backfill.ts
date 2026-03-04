// Signal Backfill on Startup — fetches recent messages, parses, filters, stores

import { createLogger } from '../utils/logger.js';
import { AgentPearParser } from './agent-pear-parser.js';
import { Store } from '../core/store.js';
import { createPairKey } from '../core/store-slices/stat-arb-slice.js';
import type { StatArbSignal } from '../core/store-slices/stat-arb-slice.js';
import type { AgentPearParseResult } from './types.js';
import type {
  TeleprotoClient,
  TeleprotoEntity,
  TeleprotoMessage,
} from './telegram-client.js';

const logger = createLogger('signal-backfill');

export interface BackfillConfig {
  readonly backfillCount: number;
  readonly signalExpiryMinutes: number;
}

export interface BackfillResult {
  readonly totalFetched: number;
  readonly parsed: number;
  readonly stored: number;
  readonly expired: number;
  readonly closedPairs: number;
  readonly errors: number;
}

const DEFAULT_BACKFILL_CONFIG: BackfillConfig = {
  backfillCount: 50,
  signalExpiryMinutes: 60,
};

export interface BackfillDeps {
  client: TeleprotoClient;
  channelEntity: TeleprotoEntity;
  parser: AgentPearParser;
  store: Store;
  processedMessageIds: Set<number>;
  logMessageToDb?: (
    telegramMessageId: number,
    rawText: string,
    parseResult: AgentPearParseResult,
    source: 'realtime' | 'backfill' | 'poll',
    timestampSec: number,
  ) => void;
}

export async function backfillOnStartup(
  deps: BackfillDeps,
  config: Partial<BackfillConfig> = {},
): Promise<BackfillResult> {
  const cfg: BackfillConfig = { ...DEFAULT_BACKFILL_CONFIG, ...config };
  const result = {
    totalFetched: 0,
    parsed: 0,
    stored: 0,
    expired: 0,
    closedPairs: 0,
    errors: 0,
  };

  try {
    // Fetch messages
    const messages = await deps.client.getMessages(deps.channelEntity, {
      limit: cfg.backfillCount,
    });

    if (!messages || messages.length === 0) {
      logger.info('Backfill: no messages found in channel');
      return result;
    }

    result.totalFetched = messages.length;

    // Sort oldest first for chronological processing
    const sorted = [...messages].sort((a, b) => a.date - b.date);

    const expiryThreshold = Date.now() - cfg.signalExpiryMinutes * 60 * 1000;

    // Track open signals and close signals in this batch for pair matching
    const openSignals = new Map<string, { signal: StatArbSignal; messageId: number }>();
    const closeSignals = new Map<string, { reason: string; zScore: number; timestamp: number }>();

    for (const msg of sorted) {
      try {
        if (!msg.message) continue;

        // Add to dedup set
        deps.processedMessageIds.add(msg.id);

        const parseResult = deps.parser.parse(msg.message);

        // Audit log
        if (deps.logMessageToDb) {
          deps.logMessageToDb(msg.id, msg.message, parseResult, 'backfill', msg.date);
        }

        if (!parseResult) continue;
        result.parsed++;

        const messageTimestamp = msg.date * 1000;

        // Check expiry
        if (messageTimestamp < expiryThreshold) {
          result.expired++;
          logger.debug({ messageId: msg.id, age: Date.now() - messageTimestamp }, 'Backfill: signal expired');
          continue;
        }

        if (parseResult.type === 'open') {
          const signal = parseResult.signal;
          const [tokenA, tokenB] = signal.pair.split('/');
          const pairKey = createPairKey(tokenA, tokenB);

          const halfLifeHours = parseHalfLifeToHours(signal.halfLife);

          const statArbSignal: StatArbSignal = {
            signalId: `telegram-backfill-${msg.id}`,
            pair: { tokenA, tokenB, key: pairKey },
            direction: signal.direction,
            zScore: signal.zScore,
            correlation: signal.correlation,
            halfLifeHours,
            hedgeRatio: 1.0,
            recommendedLeverage: signal.leverage,
            source: 'telegram',
            timestamp: messageTimestamp,
            consumed: false,
            expiresAt: messageTimestamp + cfg.signalExpiryMinutes * 60 * 1000,
          };

          openSignals.set(pairKey, { signal: statArbSignal, messageId: msg.id });
        } else if (parseResult.type === 'close') {
          const signal = parseResult.signal;
          const [tokenA, tokenB] = signal.pair.split('/');
          const pairKey = createPairKey(tokenA, tokenB);

          closeSignals.set(pairKey, {
            reason: signal.reason,
            zScore: signal.exitZScore,
            timestamp: messageTimestamp,
          });
        }
      } catch (err) {
        result.errors++;
        logger.warn({ error: err, messageId: msg.id }, 'Backfill: error processing message');
      }
    }

    // Process open signals: check if they have a matching close in the same batch
    for (const [pairKey, { signal }] of openSignals) {
      const closeMatch = closeSignals.get(pairKey);

      if (closeMatch && closeMatch.timestamp > signal.timestamp) {
        // Open+close pair found in same batch — mark as closed
        const closedSignal: StatArbSignal = { ...signal, consumed: true };

        // Check for existing position to close
        const existingPosition = deps.store.getActivePositionByPairKey(pairKey);
        if (existingPosition) {
          deps.store.emitter.emit('stat_arb_exit_signal', {
            signalId: `telegram-backfill-close-${pairKey}`,
            positionId: existingPosition.positionId,
            pair: existingPosition.pair,
            reason: closeMatch.reason === 'mean_reversion' ? 'mean_reversion' as const : 'telegram_close' as const,
            zScore: closeMatch.zScore,
            elapsedHours: (Date.now() - existingPosition.openTimestamp) / 3600000,
            halfLifeHours: existingPosition.halfLifeHours,
            timestamp: closeMatch.timestamp,
          });
        }

        result.closedPairs++;
        // Store as consumed so it's visible but not actionable
        storeSignalIdempotent(deps.store, closedSignal);
        result.stored++;
      } else {
        // No close match — store as actionable
        storeSignalIdempotent(deps.store, signal);
        result.stored++;
      }
    }

    // Process close signals that didn't match an open in this batch
    for (const [pairKey, closeData] of closeSignals) {
      if (openSignals.has(pairKey)) continue; // Already handled above

      const existingPosition = deps.store.getActivePositionByPairKey(pairKey);
      if (existingPosition) {
        deps.store.emitter.emit('stat_arb_exit_signal', {
          signalId: `telegram-backfill-close-${pairKey}`,
          positionId: existingPosition.positionId,
          pair: existingPosition.pair,
          reason: closeData.reason === 'mean_reversion' ? 'mean_reversion' as const : 'telegram_close' as const,
          zScore: closeData.zScore,
          elapsedHours: (Date.now() - existingPosition.openTimestamp) / 3600000,
          halfLifeHours: existingPosition.halfLifeHours,
          timestamp: closeData.timestamp,
        });
        result.closedPairs++;
      } else {
        logger.debug({ pairKey }, 'Backfill: close signal with no matching open position, skipping');
      }
    }

    logger.info(
      {
        stored: result.stored,
        totalFetched: result.totalFetched,
        expired: result.expired,
        closedPairs: result.closedPairs,
        errors: result.errors,
      },
      `Backfill complete: ${result.stored} signals stored from ${result.totalFetched} messages (${result.expired} expired, ${result.closedPairs} already closed)`,
    );
  } catch (err) {
    logger.error({ error: err }, 'Backfill failed');
    result.errors++;
  }

  return result;
}

// --- Helpers ---

function storeSignalIdempotent(store: Store, signal: StatArbSignal): void {
  const existing = store.getSignalByPairKey(signal.pair.key);

  if (existing) {
    // If existing is newer, keep it
    if (existing.timestamp > signal.timestamp) return;
  }

  store.addStatArbSignal(signal);
}

function parseHalfLifeToHours(halfLife: string): number {
  const match = halfLife.match(/^(\d+(?:\.\d+)?)\s*([dh])$/i);
  if (!match) return 24;
  const value = parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  return unit === 'd' ? value * 24 : value;
}
