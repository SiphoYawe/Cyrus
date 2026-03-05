'use client';

import { useEffect, useCallback, useRef } from 'react';
import { useStrategiesStore } from '@/stores/strategies-store';
import type { Strategy } from '@/stores/strategies-store';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
const REVALIDATE_INTERVAL_MS = 30_000;

export interface UseStrategiesResult {
  strategies: Strategy[];
  isLoading: boolean;
  error: Error | null;
  refetch: () => void;
}

export function useStrategies(): UseStrategiesResult {
  const { strategies, isLoading, setStrategies, setLoading } = useStrategiesStore();
  const errorRef = useRef<Error | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const fetchStrategies = useCallback(async () => {
    if (abortRef.current) {
      abortRef.current.abort();
    }
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);

    try {
      const res = await fetch(`${API_URL}/api/strategies`, {
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
      });

      if (!res.ok) {
        throw new Error(`Strategies fetch failed: ${res.status}`);
      }

      const json = (await res.json()) as { ok: boolean; data: Strategy[] };
      const strategies = json.ok ? json.data : (json as unknown as Strategy[]);
      errorRef.current = null;
      setStrategies(Array.isArray(strategies) ? strategies : []);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      errorRef.current = err instanceof Error ? err : new Error(String(err));
      setLoading(false);
    }
  }, [setStrategies, setLoading]);

  useEffect(() => {
    void fetchStrategies();

    const interval = setInterval(() => {
      void fetchStrategies();
    }, REVALIDATE_INTERVAL_MS);

    return () => {
      clearInterval(interval);
      abortRef.current?.abort();
    };
  }, [fetchStrategies]);

  return {
    strategies,
    isLoading,
    error: errorRef.current,
    refetch: fetchStrategies,
  };
}
