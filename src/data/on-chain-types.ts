// On-chain data indexer types — string literal unions, not enums

import type { ChainId, TokenAddress } from '../core/types.js';

// Event types
export type OnChainEventType =
  | 'tvl_change'
  | 'whale_trade'
  | 'liquidity_change'
  | 'gas_update'
  | 'flow_pattern'
  | 'apy_update';

// Base event
export interface OnChainEvent {
  readonly id: string;
  readonly type: OnChainEventType;
  readonly chain: ChainId;
  readonly timestamp: number;
  readonly metadata: Record<string, unknown>;
}

// TVL change
export interface TvlChangeEvent extends OnChainEvent {
  readonly type: 'tvl_change';
  readonly protocol: string;
  readonly oldTvl: number;
  readonly newTvl: number;
  readonly changePercent: number;
}

// Whale trade
export interface WhaleTradeEvent extends OnChainEvent {
  readonly type: 'whale_trade';
  readonly walletAddress: string;
  readonly walletLabel: string | null;
  readonly token: TokenAddress;
  readonly amount: bigint;
  readonly amountUsd: number;
  readonly direction: 'buy' | 'sell';
  readonly dex: string;
}

// Liquidity change
export interface LiquidityChangeEvent extends OnChainEvent {
  readonly type: 'liquidity_change';
  readonly poolAddress: string;
  readonly tokenPair: readonly [TokenAddress, TokenAddress];
  readonly amount: bigint;
  readonly amountUsd: number;
  readonly direction: 'add' | 'remove';
}

// Gas update
export interface GasUpdateEvent extends OnChainEvent {
  readonly type: 'gas_update';
  readonly gasPriceGwei: number;
  readonly baseFeeGwei: number;
  readonly priorityFeeGwei: number;
}

// Flow pattern
export interface FlowPatternEvent extends OnChainEvent {
  readonly type: 'flow_pattern';
  readonly token: TokenAddress;
  readonly patternType: 'accumulation' | 'distribution';
  readonly confidenceScore: number;
  readonly buyCount: number;
  readonly sellCount: number;
  readonly volumeRatio: number;
}

// APY update
export interface ApyUpdateEvent extends OnChainEvent {
  readonly type: 'apy_update';
  readonly protocol: string;
  readonly asset: TokenAddress;
  readonly oldApy: number;
  readonly newApy: number;
}

// Discriminated union of all concrete event types
export type ConcreteOnChainEvent =
  | TvlChangeEvent
  | WhaleTradeEvent
  | LiquidityChangeEvent
  | GasUpdateEvent
  | FlowPatternEvent
  | ApyUpdateEvent;

// Query filter
export interface OnChainEventFilter {
  readonly type?: OnChainEventType;
  readonly chain?: ChainId;
  readonly token?: TokenAddress;
  readonly fromTimestamp?: number;
  readonly toTimestamp?: number;
}

// Gas price info
export interface GasPriceInfo {
  readonly gasPriceGwei: number;
  readonly baseFeeGwei: number;
  readonly priorityFeeGwei: number;
  readonly updatedAt: number;
}

// Config
export interface OnChainIndexerConfig {
  readonly monitoredChains: ChainId[];
  readonly monitoredProtocols: string[];
  readonly whaleThresholdUsd: number;
  readonly tvlChangeThresholdPercent: number;
  readonly pollIntervalMs: number;
  readonly maxEventRetention: number;
}

// Whale wallet entry
export interface WhaleWalletEntry {
  readonly address: string;
  readonly label: string | null;
}

// TVL snapshot for tracking changes
export interface TvlSnapshot {
  readonly protocol: string;
  readonly chain: ChainId;
  readonly tvl: number;
  readonly timestamp: number;
}

// Flow tracking window entry
export interface FlowWindowEntry {
  readonly timestamp: number;
  readonly direction: 'buy' | 'sell';
  readonly volumeUsd: number;
}
