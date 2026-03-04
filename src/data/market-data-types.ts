// Enhanced market data types for Story 7.2

import type { ChainId, TokenAddress } from '../core/types.js';

export interface MarketOrderBookLevel {
  readonly price: number;
  readonly size: number;
  readonly sizeUsd: number;
}

export interface MarketOrderBook {
  readonly market: string;
  readonly bids: readonly MarketOrderBookLevel[];
  readonly asks: readonly MarketOrderBookLevel[];
  readonly spread: number;
  readonly spreadPercent: number;
  readonly midPrice: number;
  readonly timestamp: number;
}

export interface VolumeMetrics {
  readonly token: TokenAddress;
  readonly chain: ChainId;
  readonly period: string;
  readonly totalVolume: number;
  readonly buyVolume: number;
  readonly sellVolume: number;
  readonly buySellRatio: number;
  readonly volumeVs7dAvg: number;
  readonly vwap: number;
  readonly timestamp: number;
}

export interface VolatilityMetrics {
  readonly token: TokenAddress;
  readonly period: string;
  readonly realizedVolatility: number;
  readonly atr: number;
  readonly bollingerWidth: number;
  readonly bollingerUpper: number;
  readonly bollingerLower: number;
  readonly bollingerMiddle: number;
  readonly timestamp: number;
}

export interface FundingRateData {
  readonly market: string;
  readonly currentRate: number;
  readonly predictedNextRate: number;
  readonly avg7d: number;
  readonly annualizedYield: number;
  readonly nextFundingTime: number;
  readonly timestamp: number;
}

export interface OpenInterestData {
  readonly market: string;
  readonly totalOi: number;
  readonly totalOiUsd: number;
  readonly longRatio: number;
  readonly shortRatio: number;
  readonly change24h: number;
  readonly change24hPercent: number;
  readonly timestamp: number;
}

export interface CorrelationResult {
  readonly tokenA: TokenAddress;
  readonly tokenB: TokenAddress;
  readonly period: string;
  readonly coefficient: number;
  readonly sampleSize: number;
  readonly pValue: number;
  readonly timestamp: number;
}

export interface MarketMicrostructure {
  readonly orderBooks: Map<string, MarketOrderBook>;
  readonly volumes: Map<string, VolumeMetrics>;
  readonly volatilities: Map<string, VolatilityMetrics>;
  readonly fundingRates: Map<string, FundingRateData>;
  readonly openInterest: Map<string, OpenInterestData>;
  readonly correlations: Map<string, CorrelationResult>;
}

// Price candle for historical data
export interface PriceCandle {
  readonly timestamp: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}
