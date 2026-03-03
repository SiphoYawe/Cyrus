'use client';

import { useEffect, useCallback, useRef } from 'react';
import { usePortfolioStore } from '@/stores/portfolio-store';
import type { PortfolioState } from '@/stores/portfolio-store';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
const REVALIDATE_INTERVAL_MS = 30_000;

export interface UsePortfolioOverviewResult {
  data: Pick<
    PortfolioState,
    | 'totalValue'
    | 'dailyPnl'
    | 'dailyPnlPercent'
    | 'weightedYield'
    | 'allocations'
    | 'chainAllocations'
    | 'balances'
  >;
  isLoading: boolean;
  error: Error | null;
  refetch: () => void;
}

export function usePortfolioOverview(): UsePortfolioOverviewResult {
  const {
    totalValue,
    dailyPnl,
    dailyPnlPercent,
    weightedYield,
    allocations,
    chainAllocations,
    balances,
    isLoading,
    setPortfolio,
  } = usePortfolioStore();

  const errorRef = useRef<Error | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const fetchPortfolio = useCallback(async () => {
    if (abortRef.current) {
      abortRef.current.abort();
    }
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch(`${API_URL}/api/portfolio`, {
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
      });

      if (!res.ok) {
        throw new Error(`Portfolio fetch failed: ${res.status}`);
      }

      const json = await res.json() as Partial<PortfolioState>;
      errorRef.current = null;
      setPortfolio(json);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      errorRef.current = err instanceof Error ? err : new Error(String(err));
      // Keep isLoading false so stale data displays
      setPortfolio({ isLoading: false } as Partial<PortfolioState>);
    }
  }, [setPortfolio]);

  useEffect(() => {
    void fetchPortfolio();

    const interval = setInterval(() => {
      void fetchPortfolio();
    }, REVALIDATE_INTERVAL_MS);

    return () => {
      clearInterval(interval);
      abortRef.current?.abort();
    };
  }, [fetchPortfolio]);

  return {
    data: {
      totalValue,
      dailyPnl,
      dailyPnlPercent,
      weightedYield,
      allocations,
      chainAllocations,
      balances,
    },
    isLoading,
    error: errorRef.current,
    refetch: fetchPortfolio,
  };
}
