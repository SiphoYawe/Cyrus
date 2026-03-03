export interface PerpPosition {
  id: string;
  symbol: string;
  side: 'long' | 'short';
  size: number;
  entryPrice: number;
  currentPrice: number;
  leverage: number;
  unrealizedPnl: number;
  unrealizedPnlPercent: number;
  liquidationPrice: number;
  fundingRate: number;
  openedAt: number;
}

export interface PairLeg {
  token: string;
  amount: number;
  entryPrice: number;
}

export interface PairPosition {
  id: string;
  pairName: string;
  direction: 'long_pair' | 'short_pair';
  longLeg: PairLeg;
  shortLeg: PairLeg;
  entryZScore: number;
  currentZScore: number;
  combinedPnl: number;
  openedAt: number;
}

export interface MarketMakingPosition {
  id: string;
  market: string;
  baseToken: string;
  quoteToken: string;
  bidCount: number;
  bestBid: number;
  askCount: number;
  bestAsk: number;
  baseInventory: number;
  quoteInventory: number;
  spreadBps: number;
  sessionPnl: number;
}

export type PositionType = 'perp' | 'pair' | 'mm';
