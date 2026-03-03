import type { ChainId, TokenAddress } from './types.js';

export const ACTION_TYPES = {
  SWAP: 'swap',
  BRIDGE: 'bridge',
  COMPOSER: 'composer',
  REBALANCE: 'rebalance',
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

export type ExecutorAction = SwapAction | BridgeAction | ComposerAction | RebalanceAction;
