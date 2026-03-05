'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import type {
  ActivityReport,
  ActivityStats,
  ActivityFilters,
  ActivityTransfer,
} from '@/types/activity';
import { useTransfersStore } from '@/stores/transfers-store';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
const PAGE_SIZE = 20;

export interface UseActivityResult {
  reports: ActivityReport[];
  stats: ActivityStats;
  isLoading: boolean;
  hasMore: boolean;
  error: Error | null;
  loadMore: () => void;
  refetch: () => void;
  prependReport: (report: ActivityReport) => void;
}

function buildQueryString(
  offset: number,
  filters: ActivityFilters
): string {
  const params = new URLSearchParams();
  params.set('limit', String(PAGE_SIZE));
  params.set('offset', String(offset));
  if (filters.type) params.set('type', filters.type);
  if (filters.chains?.length) params.set('chain', filters.chains.join(','));
  if (filters.strategies?.length) params.set('strategy', filters.strategies.join(','));
  if (filters.dateFrom) params.set('dateFrom', filters.dateFrom);
  if (filters.dateTo) params.set('dateTo', filters.dateTo);
  return params.toString();
}

function deriveStats(reports: ActivityReport[]): ActivityStats {
  const totalOperations = reports.length;
  const successCount = reports.filter((r) => r.success).length;
  const successRate = totalOperations > 0 ? successCount / totalOperations : 0;
  const totalGasUsd = reports.reduce((acc, r) => acc + (r.gasCostUsd ?? 0), 0);
  const netPnlUsd = reports.reduce((acc, r) => acc + (r.pnlUsd ?? 0), 0);
  return { totalOperations, successCount, successRate, totalGasUsd, netPnlUsd };
}

export function useActivity(filters: ActivityFilters = {}): UseActivityResult {
  const [reports, setReports] = useState<ActivityReport[]>([]);
  const [stats, setStats] = useState<ActivityStats>({
    totalOperations: 0,
    successCount: 0,
    successRate: 0,
    totalGasUsd: 0,
    netPnlUsd: 0,
  });
  const [isLoading, setIsLoading] = useState(true);
  const [hasMore, setHasMore] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const offsetRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const filtersRef = useRef(filters);
  useEffect(() => {
    filtersRef.current = filters;
  });

  const fetchPage = useCallback(async (reset: boolean) => {
    if (abortRef.current) {
      abortRef.current.abort();
    }
    const controller = new AbortController();
    abortRef.current = controller;

    if (reset) {
      setIsLoading(true);
      offsetRef.current = 0;
    }

    try {
      const qs = buildQueryString(offsetRef.current, filtersRef.current);
      const res = await fetch(`${API_URL}/api/activity?${qs}`, {
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
      });

      if (!res.ok) {
        throw new Error(`Activity fetch failed: ${res.status}`);
      }

      const raw = (await res.json()) as {
        ok?: boolean;
        data?: {
          activities?: ActivityReport[];
          reports?: ActivityReport[];
          pagination?: { hasMore: boolean; total: number };
          stats?: ActivityStats;
          hasMore?: boolean;
        };
        reports?: ActivityReport[];
        stats?: ActivityStats;
        hasMore?: boolean;
      };

      // Unwrap response envelope if present
      const payload = raw.ok && raw.data ? raw.data : raw;
      const incoming = (payload as { activities?: ActivityReport[]; reports?: ActivityReport[] }).activities
        ?? (payload as { reports?: ActivityReport[] }).reports
        ?? [];

      setReports((prev) => {
        const next = reset ? incoming : [...prev, ...incoming];
        setStats((payload as { stats?: ActivityStats }).stats ?? deriveStats(next));
        return next;
      });

      const paginationHasMore = (payload as { pagination?: { hasMore: boolean } }).pagination?.hasMore
        ?? (payload as { hasMore?: boolean }).hasMore;
      setHasMore(paginationHasMore ?? incoming.length === PAGE_SIZE);
      setError(null);
      offsetRef.current += incoming.length;
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Reset and re-fetch when filters change
  const filtersTypeKey = filters.type ?? '';
  const filtersChainsKey = filters.chains?.join(',') ?? '';
  const filtersStrategiesKey = filters.strategies?.join(',') ?? '';

  useEffect(() => {
    void fetchPage(true);
    return () => {
      abortRef.current?.abort();
    };
  }, [filtersTypeKey, filtersChainsKey, filtersStrategiesKey, filters.dateFrom, filters.dateTo, fetchPage]);

  const loadMore = useCallback(() => {
    if (!isLoading && hasMore) {
      void fetchPage(false);
    }
  }, [isLoading, hasMore, fetchPage]);

  const refetch = useCallback(() => {
    void fetchPage(true);
  }, [fetchPage]);

  const prependReport = useCallback((report: ActivityReport) => {
    setReports((prev) => {
      const next = [report, ...prev];
      setStats(deriveStats(next));
      return next;
    });
  }, []);

  // React to completed transfers from the store by creating synthetic reports
  const completed = useTransfersStore((s) => s.completed);
  const seenRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const newest = completed[0];
    if (!newest) return;
    if (seenRef.current.has(newest.id)) return;
    seenRef.current.add(newest.id);

    // Only inject if the transfer was just completed (within last 10s)
    const age = Date.now() - (newest.completedAt ?? newest.startedAt);
    if (age > 10_000) return;

    const syntheticReport: ActivityReport = {
      id: newest.id,
      timestamp: new Date(newest.completedAt ?? Date.now()).toISOString(),
      type: newest.fromChainId !== newest.toChainId ? 'bridge' : 'trade',
      tier: 'Growth',
      strategyName: newest.bridge ?? 'Cross-Chain Transfer',
      summary: `${newest.fromToken.symbol} → ${newest.toToken.symbol}`,
      narrative: `Transferred ${newest.fromToken.symbol} from chain ${newest.fromChainId} to ${newest.toToken.symbol} on chain ${newest.toChainId}. Bridge: ${newest.bridge ?? 'auto-selected'}.`,
      transfer: newest as ActivityTransfer,
      success: newest.status === 'COMPLETED',
    };

    prependReport(syntheticReport);
  }, [completed, prependReport]);

  return { reports, stats, isLoading, hasMore, error, loadMore, refetch, prependReport };
}

// Lightweight hook for real-time WebSocket activity events
export function useActivityWsEvent(
  onReport: (report: ActivityReport) => void
): void {
  const handleRef = useRef(onReport);
  useEffect(() => {
    handleRef.current = onReport;
  });

  useEffect(() => {
    // The WS provider already dispatches to stores; we subscribe to the store.
    // For agent.decision events we'd need to extend ws types — handled here:
    const unsub = useTransfersStore.subscribe((state, prev) => {
      if (state.completed.length > prev.completed.length) {
        const newest = state.completed[0];
        if (!newest) return;
        const synth: ActivityReport = {
          id: newest.id,
          timestamp: new Date(newest.completedAt ?? Date.now()).toISOString(),
          type: newest.fromChainId !== newest.toChainId ? 'bridge' : 'trade',
          tier: 'Growth',
          strategyName: newest.bridge ?? 'Transfer',
          summary: `${newest.fromToken.symbol} → ${newest.toToken.symbol}`,
          narrative: `Transferred ${newest.fromToken.symbol} from chain ${newest.fromChainId} to ${newest.toToken.symbol} on chain ${newest.toChainId}.`,
          success: newest.status === 'COMPLETED',
        };
        handleRef.current(synth);
      }
    });
    return unsub;
  }, []);
}
