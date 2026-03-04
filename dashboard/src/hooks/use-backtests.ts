'use client';

import { useState, useEffect, useCallback, useRef } from 'react';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

// ── Types ──────────────────────────────────────────────────────────────

export interface BacktestSummary {
  id: string;
  strategy: string;
  dateFrom: string; // ISO date
  dateTo: string;   // ISO date
  sharpe: number;
  sortino: number;
  totalReturn: number; // percentage, e.g. 12.5 = 12.5%
  maxDrawdown: number; // percentage, negative e.g. -8.3
  winRate: number;     // percentage, e.g. 64.2
  totalTrades: number;
  avgTradePnl: number; // dollar amount
  createdAt: number;   // timestamp
}

export interface EquityPoint {
  date: string;  // ISO date string
  value: number; // portfolio value
}

export interface DrawdownPoint {
  date: string;
  drawdown: number; // always <= 0
}

export interface TradeHistogramBin {
  range: string;  // e.g. "-$100 to -$50"
  count: number;
  isPositive: boolean;
}

export interface BacktestDetail extends BacktestSummary {
  equityCurve: EquityPoint[];
  drawdownCurve: DrawdownPoint[];
  tradeDistribution: TradeHistogramBin[];
  params: Record<string, string | number | boolean>;
}

export type SortField = 'strategy' | 'createdAt' | 'sharpe' | 'totalReturn' | 'maxDrawdown' | 'winRate';
export type SortDirection = 'asc' | 'desc';

// ── Hook: Backtest List ────────────────────────────────────────────────

export interface UseBacktestsResult {
  backtests: BacktestSummary[];
  isLoading: boolean;
  error: Error | null;
  refetch: () => void;
}

export function useBacktests(): UseBacktestsResult {
  const [backtests, setBacktests] = useState<BacktestSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const fetchBacktests = useCallback(async () => {
    if (abortRef.current) {
      abortRef.current.abort();
    }
    const controller = new AbortController();
    abortRef.current = controller;

    setIsLoading(true);
    setError(null);

    try {
      const res = await fetch(`${API_URL}/api/backtests`, {
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
      });

      if (!res.ok) {
        throw new Error(`Backtests fetch failed: ${res.status}`);
      }

      const json = (await res.json()) as BacktestSummary[];
      setBacktests(json);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchBacktests();

    return () => {
      abortRef.current?.abort();
    };
  }, [fetchBacktests]);

  return { backtests, isLoading, error, refetch: fetchBacktests };
}

// ── Hook: Backtest Detail ──────────────────────────────────────────────

export interface UseBacktestDetailResult {
  detail: BacktestDetail | null;
  isLoading: boolean;
  error: Error | null;
}

export function useBacktestDetail(backtestId: string | null): UseBacktestDetailResult {
  const [detail, setDetail] = useState<BacktestDetail | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const fetchDetail = useCallback(async (id: string) => {
    if (abortRef.current) {
      abortRef.current.abort();
    }
    const controller = new AbortController();
    abortRef.current = controller;

    setIsLoading(true);
    setError(null);

    try {
      const res = await fetch(`${API_URL}/api/backtests/${encodeURIComponent(id)}`, {
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
      });

      if (!res.ok) {
        throw new Error(`Backtest detail fetch failed: ${res.status}`);
      }

      const json = (await res.json()) as BacktestDetail;
      setDetail(json);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!backtestId) {
      setDetail(null);
      return;
    }
    void fetchDetail(backtestId);

    return () => {
      abortRef.current?.abort();
    };
  }, [backtestId, fetchDetail]);

  return { detail, isLoading, error };
}

// ── Hook: Backtest Comparison ──────────────────────────────────────────

export interface UseBacktestComparisonResult {
  details: BacktestDetail[];
  isLoading: boolean;
  error: Error | null;
}

export function useBacktestComparison(backtestIds: string[]): UseBacktestComparisonResult {
  const [details, setDetails] = useState<BacktestDetail[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const fetchComparison = useCallback(async (ids: string[]) => {
    if (ids.length === 0) {
      setDetails([]);
      return;
    }

    if (abortRef.current) {
      abortRef.current.abort();
    }
    const controller = new AbortController();
    abortRef.current = controller;

    setIsLoading(true);
    setError(null);

    try {
      const results = await Promise.all(
        ids.map(async (id) => {
          const res = await fetch(`${API_URL}/api/backtests/${encodeURIComponent(id)}`, {
            signal: controller.signal,
            headers: { 'Content-Type': 'application/json' },
          });

          if (!res.ok) {
            throw new Error(`Backtest comparison fetch failed for ${id}: ${res.status}`);
          }

          return (await res.json()) as BacktestDetail;
        })
      );

      setDetails(results);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchComparison(backtestIds);

    return () => {
      abortRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backtestIds.join(','), fetchComparison]);

  return { details, isLoading, error };
}
