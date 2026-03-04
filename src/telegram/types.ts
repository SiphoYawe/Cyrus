// Telegram signal types — string literal unions, no enums

export type PairDirection = 'long_pair' | 'short_pair';

export type CloseReason = 'mean_reversion' | 'stop_loss' | 'time_stop' | 'manual';

export interface AgentPearOpenSignal {
  readonly pair: string;
  readonly direction: PairDirection;
  readonly zScore: number;
  readonly correlation: number;
  readonly halfLife: string;
  readonly leverage: number;
  readonly raw: string;
}

export interface AgentPearCloseSignal {
  readonly pair: string;
  readonly reason: CloseReason;
  readonly exitZScore: number;
  readonly raw: string;
}

export type AgentPearParseResult =
  | { readonly type: 'open'; readonly signal: AgentPearOpenSignal }
  | { readonly type: 'close'; readonly signal: AgentPearCloseSignal }
  | null;

export interface TelegramClientConfig {
  readonly apiId: number;
  readonly apiHash: string;
  readonly channelUsername: string;
  readonly pollIntervalMs: number;
  readonly reconnectMaxMs: number;
  readonly signalExpiryMinutes: number;
}

export interface TelegramAuditEntry {
  readonly id: number;
  readonly telegramMessageId: number;
  readonly channelUsername: string;
  readonly rawText: string;
  readonly parseResultType: string | null;
  readonly source: 'realtime' | 'backfill' | 'poll';
  readonly timestamp: number;
  readonly createdAt: string;
}
