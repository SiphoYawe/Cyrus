// Branded types for type safety — prevents mixing up chainId/tokenAddress/transferId at call sites

declare const __brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [__brand]: B };

export type ChainId = Brand<number, 'ChainId'>;
export type TokenAddress = Brand<string, 'TokenAddress'>;
export type TransferId = Brand<string, 'TransferId'>;

// Type constructors
export function chainId(value: number): ChainId {
  return value as ChainId;
}

export function tokenAddress(value: string): TokenAddress {
  return value.toLowerCase() as TokenAddress;
}

export function transferId(value: string): TransferId {
  return value as TransferId;
}

// Type guards
export function isChainId(value: unknown): value is ChainId {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

export function isTokenAddress(value: unknown): value is TokenAddress {
  return typeof value === 'string' && /^0x[a-fA-F0-9]{40}$/.test(value);
}

export function isTransferId(value: unknown): value is TransferId {
  return typeof value === 'string' && value.length > 0;
}

// Transfer status — string literal union, not enum
export type TransferStatus =
  | 'pending'
  | 'in_flight'
  | 'completed'
  | 'partial'
  | 'refunded'
  | 'failed'
  | 'timed_out';

// LI.FI status types
export type LiFiStatus = 'NOT_FOUND' | 'PENDING' | 'DONE' | 'FAILED';
export type LiFiSubstatus = 'COMPLETED' | 'PARTIAL' | 'REFUNDED';

// Agent mode
export type AgentMode = 'live' | 'dry-run' | 'backtest';

// Balance entry
export interface BalanceEntry {
  readonly chainId: ChainId;
  readonly tokenAddress: TokenAddress;
  readonly symbol: string;
  readonly decimals: number;
  amount: bigint;
  usdValue: number;
  updatedAt: number;
}

// In-flight transfer
export interface InFlightTransfer {
  readonly id: TransferId;
  txHash: string | null;
  readonly fromChain: ChainId;
  readonly toChain: ChainId;
  readonly fromToken: TokenAddress;
  readonly toToken: TokenAddress;
  readonly amount: bigint;
  readonly bridge: string;
  status: TransferStatus;
  readonly quoteData: unknown;
  readonly createdAt: number;
  updatedAt: number;
  recovered: boolean;
}

// Completed transfer
export interface CompletedTransfer {
  readonly id: TransferId;
  readonly txHash: string;
  readonly fromChain: ChainId;
  readonly toChain: ChainId;
  readonly fromToken: TokenAddress;
  readonly toToken: TokenAddress;
  readonly fromAmount: bigint;
  readonly toAmount: bigint;
  readonly bridge: string;
  readonly status: TransferStatus;
  readonly completedAt: number;
}

// Position
export interface Position {
  readonly id: string;
  readonly strategyId: string;
  readonly chainId: ChainId;
  readonly tokenAddress: TokenAddress;
  readonly entryPrice: number;
  currentPrice: number;
  readonly amount: bigint;
  readonly enteredAt: number;
  pnlUsd: number;
  pnlPercent: number;
}

// Price entry
export interface PriceEntry {
  readonly chainId: ChainId;
  readonly tokenAddress: TokenAddress;
  priceUsd: number;
  readonly timestamp: number;
}

// Trade record
export interface Trade {
  readonly id: string;
  readonly strategyId: string;
  readonly fromChain: ChainId;
  readonly toChain: ChainId;
  readonly fromToken: TokenAddress;
  readonly toToken: TokenAddress;
  readonly fromAmount: bigint;
  readonly toAmount: bigint;
  readonly pnlUsd: number;
  readonly executedAt: number;
}

// Activity log entry
export interface ActivityLogEntry {
  readonly id: string;
  readonly timestamp: string;
  readonly chainId: ChainId;
  readonly fromToken: TokenAddress;
  readonly toToken: TokenAddress;
  readonly fromAmount: string;
  readonly toAmount: string;
  readonly txHash: string;
  readonly decisionReportId: string | null;
  readonly actionType: string;
  readonly createdAt: string;
}

// Transfer result
export interface TransferResult {
  readonly transferId: TransferId;
  readonly status: TransferStatus;
  readonly receivedAmount: bigint | null;
  readonly receivedToken: TokenAddress | null;
  readonly receivedChain: ChainId | null;
}

// Execution result
export interface ExecutionResult {
  readonly success: boolean;
  readonly transferId: TransferId | null;
  readonly txHash: string | null;
  readonly error: string | null;
  readonly metadata: Record<string, unknown>;
}
