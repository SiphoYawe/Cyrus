// Connector type definitions for LI.FI integration

import type { ChainId, TokenAddress } from '../core/types.js';

// --- Quote ---

export interface QuoteParams {
  readonly fromChain: ChainId;
  readonly toChain: ChainId;
  readonly fromToken: TokenAddress;
  readonly toToken: TokenAddress;
  readonly fromAmount: string; // smallest units as string (wei)
  readonly slippage?: number;
}

export interface QuoteTransactionRequest {
  readonly to: string;
  readonly data: string;
  readonly value: string;
  readonly gasLimit: string;
  readonly gasPrice?: string;
  readonly chainId: number;
}

export interface QuoteGasCost {
  readonly amount: string;
  readonly amountUSD: string;
  readonly token: { readonly symbol: string };
}

export interface QuoteEstimate {
  readonly approvalAddress: string;
  readonly toAmount: string;
  readonly toAmountMin: string;
  readonly executionDuration: number;
  readonly gasCosts: ReadonlyArray<QuoteGasCost>;
}

export interface QuoteToolDetails {
  readonly key: string;
  readonly name: string;
  readonly logoURI: string;
}

export interface QuoteAction {
  readonly fromChainId: number;
  readonly toChainId: number;
  readonly fromToken: unknown;
  readonly toToken: unknown;
}

export interface QuoteResult {
  readonly transactionRequest: QuoteTransactionRequest;
  readonly estimate: QuoteEstimate;
  readonly tool: string;
  readonly toolDetails: QuoteToolDetails;
  readonly action: QuoteAction;
  readonly includedSteps?: unknown[];
}

// --- Routes ---

export interface RouteParams {
  readonly fromChainId: number;
  readonly toChainId: number;
  readonly fromTokenAddress: string;
  readonly toTokenAddress: string;
  readonly fromAmount: string;
  readonly slippage?: number;
  readonly order?: string;
}

export interface RouteResult {
  readonly id: string;
  readonly steps: unknown[];
  readonly toAmountMin: string;
  readonly toAmount: string;
  readonly gasCostUSD: string;
  readonly tags: string[];
}

// --- Chains ---

export interface LiFiNativeToken {
  readonly symbol: string;
  readonly decimals: number;
  readonly address: string;
}

export interface LiFiChain {
  readonly id: number;
  readonly key: string;
  readonly name: string;
  readonly nativeToken: LiFiNativeToken;
}

// --- Tokens ---

export interface LiFiToken {
  readonly address: string;
  readonly symbol: string;
  readonly decimals: number;
  readonly chainId: number;
  readonly name: string;
  readonly priceUSD?: string;
}

// --- Connections ---

export interface LiFiConnection {
  readonly fromChainId: number;
  readonly toChainId: number;
  readonly fromTokens: LiFiToken[];
  readonly toTokens: LiFiToken[];
}

// --- Tools ---

export interface LiFiTool {
  readonly key: string;
  readonly name: string;
  readonly type: string;
  readonly logoURI?: string;
}

// --- Status ---

export interface LiFiStatusResponse {
  readonly status: string;
  readonly substatus?: string;
  readonly sending?: {
    readonly txHash?: string;
    readonly amount?: string;
    readonly token?: LiFiToken;
    readonly chainId?: number;
  };
  readonly receiving?: {
    readonly txHash?: string;
    readonly amount?: string;
    readonly token?: LiFiToken;
    readonly chainId?: number;
  };
  readonly tool?: string;
  readonly bridge?: string;
}

// --- Connector Interface ---

export interface LiFiConnectorInterface {
  getQuote(params: QuoteParams): Promise<QuoteResult>;
  getRoutes(params: RouteParams): Promise<RouteResult[]>;
  getChains(): Promise<LiFiChain[]>;
  getTokens(chainId?: number): Promise<LiFiToken[]>;
  getStatus(
    txHash: string,
    bridge: string,
    fromChain: number,
    toChain: number
  ): Promise<LiFiStatusResponse>;
  getConnections(fromChain: number, toChain: number): Promise<LiFiConnection[]>;
  getTools(): Promise<LiFiTool[]>;
}
