'use client';

import { useState, useEffect, useCallback, useRef } from 'react';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

export type TimeRange = '1D' | '1W' | '1M';

export interface PortfolioDataPoint {
  timestamp: string;
  value: number;
}

export interface UsePortfolioHistoryResult {
  data: PortfolioDataPoint[];
  isLoading: boolean;
  error: Error | null;
  timeRange: TimeRange;
  setTimeRange: (range: TimeRange) => void;
  refetch: () => void;
}

export function usePortfolioHistory(): UsePortfolioHistoryResult {
  const [timeRange, setTimeRange] = useState<TimeRange>('1D');
  const [data, setData] = useState<PortfolioDataPoint[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const fetchHistory = useCallback(async (range: TimeRange) => {
    if (abortRef.current) {
      abortRef.current.abort();
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setIsLoading(true);

    try {
      const res = await fetch(
        `${API_URL}/api/portfolio/history?range=${range}`,
        {
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json' },
        }
      );

      if (!res.ok) {
        throw new Error(`History fetch failed: ${res.status}`);
      }

      const raw = await res.json() as { ok?: boolean; data?: PortfolioDataPoint[] };
      const json = raw.ok && raw.data ? raw.data : (raw as unknown as PortfolioDataPoint[]);
      setData(Array.isArray(json) ? json : []);
      setError(null);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchHistory(timeRange);
    return () => {
      abortRef.current?.abort();
    };
  }, [timeRange, fetchHistory]);

  return {
    data,
    isLoading,
    error,
    timeRange,
    setTimeRange,
    refetch: () => { void fetchHistory(timeRange); },
  };
}
