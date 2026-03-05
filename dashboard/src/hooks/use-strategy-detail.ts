'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import type { Strategy, StrategyPerformancePoint } from '@/stores/strategies-store';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export interface DecisionReport {
  id: string;
  strategy: string;
  action: string;
  reasoning: string;
  timestamp: number;
  outcome?: 'success' | 'failure' | 'pending';
}

export interface StrategyDetailData {
  strategy: Strategy;
  performanceHistory: StrategyPerformancePoint[];
  decisionReports: DecisionReport[];
}

export type TimeRange = '1W' | '1M' | '3M' | 'All';

export interface UseStrategyDetailResult {
  data: StrategyDetailData | null;
  isLoading: boolean;
  error: Error | null;
  timeRange: TimeRange;
  setTimeRange: (range: TimeRange) => void;
  filteredHistory: StrategyPerformancePoint[];
  decisionReports: DecisionReport[];
}

function filterHistory(
  history: StrategyPerformancePoint[],
  range: TimeRange
): StrategyPerformancePoint[] {
  const now = Date.now();
  const cutoffs: Record<TimeRange, number> = {
    '1W': now - 7 * 24 * 60 * 60 * 1000,
    '1M': now - 30 * 24 * 60 * 60 * 1000,
    '3M': now - 90 * 24 * 60 * 60 * 1000,
    'All': 0,
  };
  const cutoff = cutoffs[range];
  return history.filter((p) => p.timestamp >= cutoff);
}

export function useStrategyDetail(strategyName: string | null): UseStrategyDetailResult {
  const [data, setData] = useState<StrategyDetailData | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [timeRange, setTimeRange] = useState<TimeRange>('1M');
  const abortRef = useRef<AbortController | null>(null);

  const fetchDetail = useCallback(async (name: string) => {
    if (abortRef.current) {
      abortRef.current.abort();
    }
    const controller = new AbortController();
    abortRef.current = controller;

    setIsLoading(true);
    setError(null);

    try {
      const res = await fetch(`${API_URL}/api/strategies/${encodeURIComponent(name)}`, {
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
      });

      if (!res.ok) {
        throw new Error(`Strategy detail fetch failed: ${res.status}`);
      }

      const raw = (await res.json()) as { ok?: boolean; data?: StrategyDetailData };
      const json = raw.ok && raw.data ? raw.data : (raw as unknown as StrategyDetailData);
      setData(json);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!strategyName) {
      setData(null);
      return;
    }
    void fetchDetail(strategyName);

    return () => {
      abortRef.current?.abort();
    };
  }, [strategyName, fetchDetail]);

  const filteredHistory = data
    ? filterHistory(data.performanceHistory, timeRange)
    : [];

  const decisionReports = data?.decisionReports ?? [];

  return {
    data,
    isLoading,
    error,
    timeRange,
    setTimeRange,
    filteredHistory,
    decisionReports,
  };
}
