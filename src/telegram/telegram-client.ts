// TelegramSignalConsumer — RunnableBase that connects to Telegram via MTProto
// and receives Agent Pear signals in real-time with polling fallback.

import type Database from 'better-sqlite3';
import { RunnableBase } from '../core/runnable-base.js';
import { Store } from '../core/store.js';
import { createLogger } from '../utils/logger.js';
import { sleep } from '../utils/sleep.js';
import { AgentPearParser } from './agent-pear-parser.js';
import type {
  TelegramClientConfig,
  TelegramAuditEntry,
  AgentPearParseResult,
} from './types.js';
import type { StatArbSignal } from '../core/store-slices/stat-arb-slice.js';
import { createPairKey } from '../core/store-slices/stat-arb-slice.js';

const logger = createLogger('telegram-client');

// Default signal expiry: 60 minutes
const DEFAULT_SIGNAL_EXPIRY_MINUTES = 60;
const DEFAULT_POLL_INTERVAL_MS = 60_000;
const DEFAULT_RECONNECT_MAX_MS = 30_000;
const MAX_RECONNECT_ATTEMPTS = 20;
const DEDUP_SET_MAX = 1000;
const DEDUP_SET_PRUNE = 500;

// --- Teleproto abstraction for testability ---

export interface TeleprotoClient {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  getEntity(username: string): Promise<TeleprotoEntity>;
  getMessages(entity: TeleprotoEntity, options: { limit: number }): Promise<TeleprotoMessage[]>;
  addEventHandler(handler: (event: TeleprotoNewMessageEvent) => void, filter: TeleprotoEventFilter): void;
}

export interface TeleprotoEntity {
  id: bigint | number;
  username?: string;
}

export interface TeleprotoMessage {
  id: number;
  message: string;
  date: number; // unix timestamp (seconds)
  peerId?: { channelId?: bigint | number };
}

export interface TeleprotoNewMessageEvent {
  message: TeleprotoMessage;
}

export interface TeleprotoEventFilter {
  chats?: Array<bigint | number>;
}

// --- TelegramSignalConsumer ---

export class TelegramSignalConsumer extends RunnableBase {
  private readonly config: TelegramClientConfig;
  private readonly parser: AgentPearParser;
  private readonly store: Store;
  private readonly db: Database.Database | null;
  private client: TeleprotoClient | null = null;
  private channelEntity: TeleprotoEntity | null = null;
  private lastProcessedMessageId = 0;
  private readonly processedMessageIds: Set<number> = new Set();
  private reconnectAttempts = 0;
  private degraded = false;
  private connected = false;

  constructor(
    config: Partial<TelegramClientConfig> & Pick<TelegramClientConfig, 'apiId' | 'apiHash'>,
    options?: {
      client?: TeleprotoClient;
      db?: Database.Database;
      store?: Store;
      parser?: AgentPearParser;
    },
  ) {
    super(config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS, 'telegram-client');
    this.config = {
      apiId: config.apiId,
      apiHash: config.apiHash,
      channelUsername: config.channelUsername ?? 'agentpear',
      pollIntervalMs: config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      reconnectMaxMs: config.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS,
      signalExpiryMinutes: config.signalExpiryMinutes ?? DEFAULT_SIGNAL_EXPIRY_MINUTES,
    };
    this.client = options?.client ?? null;
    this.db = options?.db ?? null;
    this.store = options?.store ?? Store.getInstance();
    this.parser = options?.parser ?? new AgentPearParser();

    if (this.db) {
      this.ensureAuditTable();
    }
  }

  // --- Lifecycle ---

  async connect(): Promise<void> {
    if (!this.client) {
      throw new Error('TeleprotoClient not provided. Use options.client or call setClient().');
    }

    const sessionString = process.env.TELEGRAM_SESSION_STRING;
    if (!sessionString) {
      throw new Error(
        'TELEGRAM_SESSION_STRING environment variable is not set. ' +
        'Run `cyrus telegram-auth` to generate a session string.',
      );
    }

    await this.client.connect();
    this.connected = true;

    // Resolve channel entity
    this.channelEntity = await this.client.getEntity(this.config.channelUsername);
    logger.info(
      { channel: this.config.channelUsername, entityId: String(this.channelEntity.id) },
      'Connected to Telegram and resolved channel',
    );

    // Register event handler
    this.client.addEventHandler(
      (event: TeleprotoNewMessageEvent) => {
        this.handleMessage(event.message, 'realtime').catch((err) => {
          logger.error({ error: err }, 'Error in message event handler');
        });
      },
      { chats: [this.channelEntity.id] },
    );

    this.reconnectAttempts = 0;
  }

  async controlTask(): Promise<void> {
    // Health check
    if (!this.connected || !this.client?.isConnected()) {
      if (!this.degraded) {
        await this.reconnect();
      }
      return;
    }

    // Poll for missed messages
    await this.pollForMessages();

    // Prune expired signals
    this.store.pruneExpiredSignals();
  }

  async onStop(): Promise<void> {
    if (this.client) {
      try {
        await this.client.disconnect();
      } catch (err) {
        logger.warn({ error: err }, 'Error disconnecting Telegram client');
      }
    }
    this.connected = false;
    logger.info('TelegramSignalConsumer stopped');
  }

  setClient(client: TeleprotoClient): void {
    this.client = client;
  }

  isConnectedToTelegram(): boolean {
    return this.connected && (this.client?.isConnected() ?? false);
  }

  // --- Message handling pipeline ---

  async handleMessage(
    message: TeleprotoMessage,
    source: 'realtime' | 'backfill' | 'poll',
  ): Promise<void> {
    try {
      // Deduplication
      if (this.processedMessageIds.has(message.id)) return;
      this.addToDedup(message.id);

      // Track last processed
      if (message.id > this.lastProcessedMessageId) {
        this.lastProcessedMessageId = message.id;
      }

      const text = message.message;
      if (!text) return;

      // Parse
      const parseResult = this.parser.parse(text);

      // Audit log
      this.logMessageToDb(message.id, text, parseResult, source, message.date);

      if (!parseResult) return;

      // Check expiry
      const messageTimestamp = message.date * 1000; // Convert seconds to ms
      const expiryThreshold = Date.now() - this.config.signalExpiryMinutes * 60 * 1000;
      if (messageTimestamp < expiryThreshold) {
        logger.debug({ messageId: message.id, age: Date.now() - messageTimestamp }, 'Signal expired, skipping');
        return;
      }

      // Store signal
      if (parseResult.type === 'open') {
        const signal = parseResult.signal;
        const [tokenA, tokenB] = signal.pair.split('/');
        const pairKey = createPairKey(tokenA, tokenB);

        // Parse half-life to hours
        const halfLifeHours = this.parseHalfLifeToHours(signal.halfLife);

        const statArbSignal: StatArbSignal = {
          signalId: `telegram-${message.id}`,
          pair: { tokenA, tokenB, key: pairKey },
          direction: signal.direction,
          zScore: signal.zScore,
          correlation: signal.correlation,
          halfLifeHours,
          hedgeRatio: 1.0, // Default; will be refined by stat arb engine
          recommendedLeverage: signal.leverage,
          source: 'telegram',
          timestamp: messageTimestamp,
          consumed: false,
          expiresAt: messageTimestamp + this.config.signalExpiryMinutes * 60 * 1000,
        };

        this.store.addStatArbSignal(statArbSignal);
        this.store.emitter.emit('stat_arb_signal', statArbSignal);
        logger.info(
          { pair: signal.pair, direction: signal.direction, zScore: signal.zScore },
          'Telegram signal stored',
        );
      } else if (parseResult.type === 'close') {
        const signal = parseResult.signal;
        const [tokenA, tokenB] = signal.pair.split('/');
        const pairKey = createPairKey(tokenA, tokenB);

        // Check if there's an active position for this pair
        const position = this.store.getActivePositionByPairKey(pairKey);
        if (position) {
          this.store.emitter.emit('stat_arb_exit_signal', {
            signalId: `telegram-close-${message.id}`,
            positionId: position.positionId,
            pair: position.pair,
            reason: signal.reason === 'mean_reversion' ? 'mean_reversion' : signal.reason === 'stop_loss' ? 'stoploss' : signal.reason === 'time_stop' ? 'time_stop' : 'telegram_close',
            zScore: signal.exitZScore,
            elapsedHours: (Date.now() - position.openTimestamp) / 3600000,
            halfLifeHours: position.halfLifeHours,
            timestamp: messageTimestamp,
          });
          logger.info({ pair: signal.pair, reason: signal.reason }, 'Telegram close signal emitted');
        }
      }
    } catch (err) {
      logger.error({ error: err, messageId: message.id }, 'Error processing message');
    }
  }

  // --- Polling ---

  async pollForMessages(): Promise<void> {
    if (!this.client || !this.channelEntity) return;

    try {
      const messages = await this.client.getMessages(this.channelEntity, { limit: 20 });

      for (const msg of messages) {
        await this.handleMessage(msg, 'poll');
      }
    } catch (err) {
      logger.warn({ error: err }, 'Error during message polling');
    }
  }

  // --- Reconnection ---

  async reconnect(): Promise<void> {
    if (this.degraded) return;

    this.reconnectAttempts++;

    if (this.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
      logger.error(
        { attempts: this.reconnectAttempts },
        'Max reconnection attempts reached, entering degraded mode',
      );
      this.degraded = true;
      return;
    }

    const delay = Math.min(
      Math.pow(2, this.reconnectAttempts - 1) * 1000,
      this.config.reconnectMaxMs,
    );

    logger.info({ attempt: this.reconnectAttempts, delayMs: delay }, 'Reconnecting to Telegram');
    await sleep(delay);

    try {
      await this.connect();
      // Backfill messages missed during outage
      if (this.lastProcessedMessageId > 0) {
        await this.pollForMessages();
      }
    } catch (err) {
      logger.error({ error: err, attempt: this.reconnectAttempts }, 'Reconnection failed');
    }
  }

  // --- Deduplication ---

  private addToDedup(messageId: number): void {
    this.processedMessageIds.add(messageId);
    if (this.processedMessageIds.size > DEDUP_SET_MAX) {
      // Remove oldest entries (lower IDs are older since IDs are monotonically increasing)
      const sorted = Array.from(this.processedMessageIds).sort((a, b) => a - b);
      for (let i = 0; i < DEDUP_SET_PRUNE; i++) {
        this.processedMessageIds.delete(sorted[i]);
      }
    }
  }

  getProcessedMessageIds(): Set<number> {
    return this.processedMessageIds;
  }

  getLastProcessedMessageId(): number {
    return this.lastProcessedMessageId;
  }

  // --- SQLite audit ---

  private ensureAuditTable(): void {
    if (!this.db) return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS telegram_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_message_id INTEGER UNIQUE,
        channel_username TEXT,
        raw_text TEXT,
        parse_result_type TEXT,
        source TEXT DEFAULT 'realtime',
        timestamp INTEGER,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }

  logMessageToDb(
    telegramMessageId: number,
    rawText: string,
    parseResult: AgentPearParseResult,
    source: 'realtime' | 'backfill' | 'poll',
    timestampSec: number,
  ): void {
    if (!this.db) return;
    try {
      this.db.prepare(`
        INSERT OR IGNORE INTO telegram_messages
          (telegram_message_id, channel_username, raw_text, parse_result_type, source, timestamp)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        telegramMessageId,
        this.config.channelUsername,
        rawText,
        parseResult?.type ?? null,
        source,
        timestampSec,
      );
    } catch (err) {
      logger.warn({ error: err, telegramMessageId }, 'Failed to write audit log');
    }
  }

  getAuditLog(limit: number = 50): TelegramAuditEntry[] {
    if (!this.db) return [];
    const rows = this.db
      .prepare('SELECT * FROM telegram_messages ORDER BY id DESC LIMIT ?')
      .all(limit) as Array<{
      id: number;
      telegram_message_id: number;
      channel_username: string;
      raw_text: string;
      parse_result_type: string | null;
      source: string;
      timestamp: number;
      created_at: string;
    }>;

    return rows.map((r) => ({
      id: r.id,
      telegramMessageId: r.telegram_message_id,
      channelUsername: r.channel_username,
      rawText: r.raw_text,
      parseResultType: r.parse_result_type,
      source: r.source as 'realtime' | 'backfill' | 'poll',
      timestamp: r.timestamp,
      createdAt: r.created_at,
    }));
  }

  // --- Helpers ---

  private parseHalfLifeToHours(halfLife: string): number {
    const match = halfLife.match(/^(\d+(?:\.\d+)?)\s*([dh])$/i);
    if (!match) return 24; // default
    const value = parseFloat(match[1]);
    const unit = match[2].toLowerCase();
    return unit === 'd' ? value * 24 : value;
  }

  isDegraded(): boolean {
    return this.degraded;
  }

  getReconnectAttempts(): number {
    return this.reconnectAttempts;
  }
}
