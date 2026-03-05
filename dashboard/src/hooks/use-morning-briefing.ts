'use client';

import { useState, useEffect, useCallback, useRef } from 'react';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

export interface MorningBriefing {
  overnightPnl: number;
  overnightPnlPercent: number;
  operationsCount: number;
  yieldDelta: number;
  riskStatus: 'Low' | 'Medium' | 'High';
  generatedAt: string;
}

export interface UseMorningBriefingResult {
  data: MorningBriefing | null;
  isLoading: boolean;
  error: Error | null;
  refetch: () => void;
}

export function useMorningBriefing(): UseMorningBriefingResult {
  const [data, setData] = useState<MorningBriefing | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const fetchBriefing = useCallback(async () => {
    if (abortRef.current) {
      abortRef.current.abort();
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setIsLoading(true);

    try {
      const res = await fetch(`${API_URL}/api/portfolio/briefing`, {
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
      });

      if (!res.ok) {
        throw new Error(`Briefing fetch failed: ${res.status}`);
      }

      const raw = await res.json() as { ok?: boolean; data?: MorningBriefing };
      const json = raw.ok && raw.data ? raw.data : (raw as unknown as MorningBriefing);
      setData(json);
      setError(null);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchBriefing();
    return () => {
      abortRef.current?.abort();
    };
  }, [fetchBriefing]);

  return { data, isLoading, error, refetch: fetchBriefing };
}
