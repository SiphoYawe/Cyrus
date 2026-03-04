'use client';

import { useEffect, useCallback, useRef, useState } from 'react';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
const REVALIDATE_INTERVAL_MS = 60_000;

// ── Types ──────────────────────────────────────────────────────────

export interface CandlestickDataPoint {
  time: string; // ISO date string YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface TradeMarker {
  time: string;
  position: 'aboveBar' | 'belowBar';
  color: string;
  shape: 'arrowUp' | 'arrowDown' | 'circle';
  text: string;
}

export interface PriceHistory {
  symbol: string;
  candles: CandlestickDataPoint[];
  markers: TradeMarker[];
}

export interface AllocationNode {
  name: string;
  symbol: string;
  value: number; // USD allocation
  change24h: number; // percent change in 24h
}

export interface CorrelationPair {
  assetA: string;
  assetB: string;
  correlation: number; // -1 to +1
}

export interface CorrelationData {
  assets: string[];
  matrix: number[][]; // NxN Pearson correlation matrix
}

export interface RiskMetrics {
  sharpeRatio: number;
  sortinoRatio: number;
  maxDrawdown: number; // as decimal e.g. 0.15 = 15%
  var95: number; // Value at Risk 95% as USD
  var99: number; // Value at Risk 99% as USD
  annualizedReturn: number;
  annualizedVolatility: number;
  calmarRatio: number;
  winRate: number; // 0 to 1
  profitFactor: number;
}

export interface AnalyticsData {
  priceHistory: PriceHistory;
  allocations: AllocationNode[];
  correlation: CorrelationData;
  riskMetrics: RiskMetrics;
}

export interface UseAnalyticsDataResult {
  data: AnalyticsData | null;
  isLoading: boolean;
  error: Error | null;
  refetch: () => void;
  selectedSymbol: string;
  setSelectedSymbol: (symbol: string) => void;
}

// ── Default / fallback data ──────────────────────────────────────────

function generateFallbackCandles(): CandlestickDataPoint[] {
  const candles: CandlestickDataPoint[] = [];
  let price = 3000;
  const now = new Date();

  for (let i = 89; i >= 0; i--) {
    const date = new Date(now);
    date.setDate(date.getDate() - i);
    const dateStr = date.toISOString().split('T')[0];

    const change = (Math.random() - 0.48) * 100;
    const open = price;
    const close = price + change;
    const high = Math.max(open, close) + Math.random() * 50;
    const low = Math.min(open, close) - Math.random() * 50;

    candles.push({
      time: dateStr,
      open: Math.round(open * 100) / 100,
      high: Math.round(high * 100) / 100,
      low: Math.round(low * 100) / 100,
      close: Math.round(close * 100) / 100,
      volume: Math.round(Math.random() * 1000000),
    });

    price = close;
  }

  return candles;
}

function generateFallbackMarkers(candles: CandlestickDataPoint[]): TradeMarker[] {
  const markers: TradeMarker[] = [];
  const entryIndices = [10, 25, 45, 60, 75];

  for (const idx of entryIndices) {
    if (idx < candles.length) {
      const isBuy = Math.random() > 0.4;
      markers.push({
        time: candles[idx].time,
        position: isBuy ? 'belowBar' : 'aboveBar',
        color: isBuy ? '#22C55E' : '#EF4444',
        shape: isBuy ? 'arrowUp' : 'arrowDown',
        text: isBuy ? 'BUY' : 'SELL',
      });
    }
  }

  return markers;
}

const FALLBACK_ALLOCATIONS: AllocationNode[] = [
  { name: 'Ethereum', symbol: 'ETH', value: 45000, change24h: 2.3 },
  { name: 'Bitcoin', symbol: 'BTC', value: 30000, change24h: -0.8 },
  { name: 'Arbitrum', symbol: 'ARB', value: 12000, change24h: 5.1 },
  { name: 'Optimism', symbol: 'OP', value: 8000, change24h: -1.2 },
  { name: 'Polygon', symbol: 'MATIC', value: 5000, change24h: 3.7 },
  { name: 'Chainlink', symbol: 'LINK', value: 4000, change24h: -2.5 },
  { name: 'Aave', symbol: 'AAVE', value: 3500, change24h: 1.8 },
  { name: 'Uniswap', symbol: 'UNI', value: 2500, change24h: -0.3 },
];

const FALLBACK_CORRELATION: CorrelationData = {
  assets: ['ETH', 'BTC', 'ARB', 'OP', 'MATIC', 'LINK'],
  matrix: [
    [1.0, 0.85, 0.72, 0.68, 0.61, 0.55],
    [0.85, 1.0, 0.65, 0.58, 0.52, 0.48],
    [0.72, 0.65, 1.0, 0.78, 0.45, 0.42],
    [0.68, 0.58, 0.78, 1.0, 0.41, 0.38],
    [0.61, 0.52, 0.45, 0.41, 1.0, 0.55],
    [0.55, 0.48, 0.42, 0.38, 0.55, 1.0],
  ],
};

const FALLBACK_RISK_METRICS: RiskMetrics = {
  sharpeRatio: 1.85,
  sortinoRatio: 2.42,
  maxDrawdown: 0.127,
  var95: 2340,
  var99: 4120,
  annualizedReturn: 0.342,
  annualizedVolatility: 0.185,
  calmarRatio: 2.69,
  winRate: 0.63,
  profitFactor: 1.72,
};

function buildFallbackData(symbol: string): AnalyticsData {
  const candles = generateFallbackCandles();
  return {
    priceHistory: {
      symbol,
      candles,
      markers: generateFallbackMarkers(candles),
    },
    allocations: FALLBACK_ALLOCATIONS,
    correlation: FALLBACK_CORRELATION,
    riskMetrics: FALLBACK_RISK_METRICS,
  };
}

// ── Hook ──────────────────────────────────────────────────────────

export function useAnalyticsData(): UseAnalyticsDataResult {
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedSymbol, setSelectedSymbol] = useState('ETH');
  const errorRef = useRef<Error | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const fetchAnalytics = useCallback(async (symbol: string) => {
    if (abortRef.current) {
      abortRef.current.abort();
    }
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      setIsLoading(true);
      const res = await fetch(
        `${API_URL}/api/analytics?symbol=${encodeURIComponent(symbol)}`,
        {
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json' },
        }
      );

      if (!res.ok) {
        throw new Error(`Analytics fetch failed: ${res.status}`);
      }

      const json = (await res.json()) as AnalyticsData;
      errorRef.current = null;
      setData(json);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      errorRef.current = err instanceof Error ? err : new Error(String(err));
      // Fall back to generated data when API is unavailable
      setData(buildFallbackData(symbol));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchAnalytics(selectedSymbol);

    const interval = setInterval(() => {
      void fetchAnalytics(selectedSymbol);
    }, REVALIDATE_INTERVAL_MS);

    return () => {
      clearInterval(interval);
      abortRef.current?.abort();
    };
  }, [fetchAnalytics, selectedSymbol]);

  const refetch = useCallback(() => {
    void fetchAnalytics(selectedSymbol);
  }, [fetchAnalytics, selectedSymbol]);

  return {
    data,
    isLoading,
    error: errorRef.current,
    refetch,
    selectedSymbol,
    setSelectedSymbol,
  };
}

// ── Utility: Risk metric calculations ──────────────────────────────

/**
 * Calculate Sharpe Ratio from an array of returns
 * sharpe = (mean - riskFreeRate) / stdDev
 */
export function calculateSharpeRatio(
  returns: number[],
  riskFreeRate = 0
): number {
  if (returns.length < 2) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance =
    returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) /
    (returns.length - 1);
  const stdDev = Math.sqrt(variance);
  if (stdDev === 0) return 0;
  return (mean - riskFreeRate) / stdDev;
}

/**
 * Calculate Sortino Ratio from an array of returns
 * sortino = (mean - riskFreeRate) / downsideDeviation
 */
export function calculateSortinoRatio(
  returns: number[],
  riskFreeRate = 0
): number {
  if (returns.length < 2) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const downsideReturns = returns.filter((r) => r < riskFreeRate);
  if (downsideReturns.length === 0) return mean > riskFreeRate ? Infinity : 0;
  const downsideVariance =
    downsideReturns.reduce((sum, r) => sum + (r - riskFreeRate) ** 2, 0) /
    downsideReturns.length;
  const downsideDev = Math.sqrt(downsideVariance);
  if (downsideDev === 0) return 0;
  return (mean - riskFreeRate) / downsideDev;
}

/**
 * Calculate Maximum Drawdown from an equity curve (array of portfolio values)
 * Returns a decimal (e.g. 0.15 = 15% drawdown)
 */
export function calculateMaxDrawdown(equityCurve: number[]): number {
  if (equityCurve.length < 2) return 0;
  let peak = equityCurve[0];
  let maxDd = 0;

  for (const value of equityCurve) {
    if (value > peak) peak = value;
    const dd = (peak - value) / peak;
    if (dd > maxDd) maxDd = dd;
  }

  return maxDd;
}

/**
 * Calculate Value at Risk using historical simulation
 * Returns the VaR as a positive number representing potential loss
 */
export function calculateVaR(
  returns: number[],
  portfolioValue: number,
  confidence: number
): number {
  if (returns.length === 0) return 0;
  const sorted = [...returns].sort((a, b) => a - b);
  const index = Math.floor((1 - confidence) * sorted.length);
  const varReturn = sorted[Math.max(0, index)];
  return Math.abs(varReturn) * portfolioValue;
}
