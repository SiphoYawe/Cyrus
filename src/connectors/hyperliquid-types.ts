// Hyperliquid-specific type definitions for perps trading

export interface HyperliquidBalance {
  readonly totalMarginUsed: number;
  readonly totalNtlPos: number;
  readonly totalRawUsd: number;
  readonly withdrawable: number;
  readonly crossMarginSummary: {
    readonly accountValue: number;
    readonly totalMarginUsed: number;
    readonly totalNtlPos: number;
  };
}

export interface HyperliquidPosition {
  readonly coin: string;
  readonly szi: string; // signed size as string
  readonly leverage: { readonly type: string; readonly value: number };
  readonly entryPx: string;
  readonly positionValue: string;
  readonly unrealizedPnl: string;
  readonly returnOnEquity: string;
  readonly liquidationPx: string | null;
  readonly marginUsed: string;
}

export interface HyperliquidOrder {
  readonly oid: number;
  readonly coin: string;
  readonly side: 'B' | 'A'; // Buy or Ask(sell)
  readonly sz: string;
  readonly limitPx: string;
  readonly orderType: string;
  readonly timestamp: number;
  readonly origSz: string;
}

export interface FundingRate {
  readonly coin: string;
  readonly fundingRate: string;
  readonly premium: string;
  readonly time: number;
}

export type FundingRateMap = Map<string, FundingRate>;

export interface OpenInterest {
  readonly coin: string;
  readonly openInterest: string;
}

export type OpenInterestMap = Map<string, OpenInterest>;

export interface OrderBookLevel {
  readonly price: number;
  readonly size: number;
  readonly numOrders: number;
}

export interface OrderBook {
  readonly coin: string;
  readonly bids: readonly OrderBookLevel[];
  readonly asks: readonly OrderBookLevel[];
  readonly timestamp: number;
}

export interface HyperliquidOrderResult {
  readonly status: 'ok' | 'error';
  readonly orderId?: number;
  readonly error?: string;
  readonly filledSize?: string;
  readonly avgPrice?: string;
}

export interface HyperliquidFill {
  readonly coin: string;
  readonly px: string;
  readonly sz: string;
  readonly side: 'B' | 'A';
  readonly time: number;
  readonly startPosition: string;
  readonly dir: string;
  readonly closedPnl: string;
  readonly hash: string;
  readonly oid: number;
  readonly fee: string;
}

// PerpPosition for internal tracking
// Mutable fields: currentPrice, unrealizedPnl, accumulatedFunding (updated during manage stage)
export interface PerpPosition {
  readonly id: string;
  readonly symbol: string;
  readonly side: 'long' | 'short';
  readonly size: bigint;
  readonly entryPrice: number;
  currentPrice: number;
  readonly leverage: number;
  unrealizedPnl: number;
  accumulatedFunding: number;
  readonly openTimestamp: number;
  readonly orderId: number | null;
}

/**
 * EIP-712 signing callback. The caller (e.g. WalletManager) provides this
 * so the connector can sign exchange actions without holding the private key.
 * Returns the hex-encoded signature string.
 */
export type HyperliquidSignerFn = (
  action: Record<string, unknown>,
  nonce: number,
) => Promise<string>;

export interface HyperliquidConnectorConfig {
  readonly walletAddress: string;
  readonly apiUrl?: string;
  readonly wsUrl?: string;
  readonly reconnectDelayMs?: number;
  readonly maxReconnectAttempts?: number;
  /** Optional EIP-712 signer for authenticated exchange actions. */
  readonly signer?: HyperliquidSignerFn;
}
