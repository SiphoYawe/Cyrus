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

      const raw = (await res.json()) as { ok?: boolean; data?: AnalyticsData };
      const json = raw.ok && raw.data ? raw.data : (raw as unknown as AnalyticsData);
      errorRef.current = null;
      setData(json);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      errorRef.current = err instanceof Error ? err : new Error(String(err));
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
