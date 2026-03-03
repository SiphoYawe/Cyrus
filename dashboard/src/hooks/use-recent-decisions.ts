'use client';

import { useState, useEffect, useCallback, useRef } from 'react';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

export type StrategyTier = 'Safe' | 'Growth' | 'Degen' | 'Reserve';

export interface DecisionReport {
  id: string;
  timestamp: string;
  tier: StrategyTier;
  strategyName: string;
  summary: string;
  narrative: string;
}

export interface UseRecentDecisionsResult {
  data: DecisionReport[];
  isLoading: boolean;
  error: Error | null;
  refetch: () => void;
}

export function useRecentDecisions(limit = 5): UseRecentDecisionsResult {
  const [data, setData] = useState<DecisionReport[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const fetchDecisions = useCallback(async () => {
    if (abortRef.current) {
      abortRef.current.abort();
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setIsLoading(true);

    try {
      const res = await fetch(
        `${API_URL}/api/activity?limit=${limit}`,
        {
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json' },
        }
      );

      if (!res.ok) {
        throw new Error(`Decisions fetch failed: ${res.status}`);
      }

      const json = await res.json() as DecisionReport[];
      setData(json);
      setError(null);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setIsLoading(false);
    }
  }, [limit]);

  useEffect(() => {
    void fetchDecisions();
    return () => {
      abortRef.current?.abort();
    };
  }, [fetchDecisions]);

  return { data, isLoading, error, refetch: fetchDecisions };
}
