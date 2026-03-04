import type { ChainId, TokenAddress } from './types.js';

export const ACTION_TYPES = {
  SWAP: 'swap',
  BRIDGE: 'bridge',
  FUNDING_BRIDGE: 'funding_bridge',
  COMPOSER: 'composer',
  REBALANCE: 'rebalance',
  PERP: 'perp',
  PAIR: 'pair',
  MARKET_MAKE: 'market_make',
} as const;

export type ActionType = (typeof ACTION_TYPES)[keyof typeof ACTION_TYPES];

interface BaseAction {
  readonly id: string;
  readonly type: ActionType;
  readonly priority: number;
  readonly createdAt: number;
  readonly strategyId: string;
}

export interface SwapAction extends BaseAction {
  readonly type: 'swap';
  readonly fromChain: ChainId;
  readonly toChain: ChainId;
  readonly fromToken: TokenAddress;
  readonly toToken: TokenAddress;
  readonly amount: bigint;
  readonly slippage: number;
  readonly metadata: Record<string, unknown>;
}

export interface BridgeAction extends BaseAction {
  readonly type: 'bridge';
  readonly fromChain: ChainId;
  readonly toChain: ChainId;
  readonly fromToken: TokenAddress;
  readonly toToken: TokenAddress;
  readonly amount: bigint;
  readonly preferredBridge?: string;
  readonly metadata: Record<string, unknown>;
}

export interface ComposerAction extends BaseAction {
  readonly type: 'composer';
  readonly fromChain: ChainId;
  readonly toChain: ChainId;
  readonly fromToken: TokenAddress;
  readonly toToken: TokenAddress; // vault address
  readonly amount: bigint;
  readonly protocol: string;
  readonly metadata: Record<string, unknown>;
}

export interface RebalanceAction extends BaseAction {
  readonly type: 'rebalance';
  readonly actions: ExecutorAction[];
  readonly metadata: Record<string, unknown>;
}

export interface PerpAction extends BaseAction {
  readonly type: 'perp';
  readonly symbol: string;
  readonly side: 'long' | 'short';
  readonly size: bigint;
  readonly leverage: number;
  readonly orderType: 'market' | 'limit';
  readonly limitPrice?: number;
  readonly timeInForce?: 'GTC' | 'IOC' | 'FOK';
  readonly metadata: Record<string, unknown>;
}

export interface PairAction extends BaseAction {
  readonly type: 'pair';
  readonly pairId: string;
  readonly longSymbol: string;
  readonly shortSymbol: string;
  readonly longSize: bigint;
  readonly shortSize: bigint;
  readonly leverage: number;
  readonly metadata: Record<string, unknown>;
}

export interface MarketMakeAction extends BaseAction {
  readonly type: 'market_make';
  readonly symbol: string;
  readonly spread: number;
  readonly orderSize: bigint;
  readonly levels: number;
  readonly metadata: Record<string, unknown>;
}

export interface FundingBridgeAction extends BaseAction {
  readonly type: 'funding_bridge';
  readonly fromChain: ChainId;
  readonly toChain: ChainId;
  readonly fromToken: TokenAddress;
  readonly toToken: TokenAddress;
  readonly amount: bigint;
  readonly fundingBatchId: string;
  readonly triggeringSignalId: string;
  readonly depositToHyperliquid: boolean;
  readonly metadata: Record<string, unknown>;
}

export type ExecutorAction =
  | SwapAction
  | BridgeAction
  | ComposerAction
  | RebalanceAction
  | PerpAction
  | PairAction
  | MarketMakeAction
  | FundingBridgeAction;
