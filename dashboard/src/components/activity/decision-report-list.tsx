'use client';

import { useEffect, useRef, useCallback } from 'react';
import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/shared/empty-state';
import { ActivityDecisionCard } from './activity-decision-card';
import type { ActivityReport } from '@/types/activity';
import type { ActivityTab } from './activity-tabs';

interface DecisionReportListProps {
  reports: ActivityReport[];
  activeTab: ActivityTab;
  newIds: Set<string>;
  isLoading: boolean;
  hasMore: boolean;
  onLoadMore: () => void;
  onViewTransfer: (report: ActivityReport) => void;
  className?: string;
}

function filterByTab(reports: ActivityReport[], tab: ActivityTab): ActivityReport[] {
  if (tab === 'all') return reports;
  return reports.filter((r) => r.type === tab);
}

function LoadingSkeleton() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 5 }).map((_, i) => (
        <div
          key={i}
          className="rounded-xl border border-border bg-card p-4 space-y-2"
        >
          <div className="flex items-center gap-2">
            <Skeleton className="h-2 w-2 rounded-full" />
            <Skeleton className="h-4 w-14 rounded" />
            <Skeleton className="h-4 w-14 rounded" />
            <Skeleton className="ml-auto h-3 w-20 rounded" />
          </div>
          <Skeleton className="h-4 w-3/4 rounded" />
        </div>
      ))}
    </div>
  );
}

export function DecisionReportList({
  reports,
  activeTab,
  newIds,
  isLoading,
  hasMore,
  onLoadMore,
  onViewTransfer,
  className,
}: DecisionReportListProps) {
  const sentinelRef = useRef<HTMLDivElement>(null);
  const onLoadMoreRef = useRef(onLoadMore);
  useEffect(() => {
    onLoadMoreRef.current = onLoadMore;
  });

  // Intersection Observer for infinite scroll
  const observe = useCallback(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          onLoadMoreRef.current();
        }
      },
      { rootMargin: '200px' }
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const cleanup = observe();
    return cleanup;
  }, [observe]);

  const filtered = filterByTab(reports, activeTab);

  if (isLoading && filtered.length === 0) {
    return <LoadingSkeleton />;
  }

  if (!isLoading && filtered.length === 0) {
    return (
      <EmptyState
        icon={
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
          </svg>
        }
        message="No activity found"
        description={
          activeTab !== 'all'
            ? `No ${activeTab} operations match the current filters.`
            : 'No operations have been recorded yet.'
        }
        data-testid="empty-state"
      />
    );
  }

  return (
    <div className={cn('space-y-3', className)} data-testid="decision-report-list">
      {filtered.map((report) => (
        <ActivityDecisionCard
          key={report.id}
          report={report}
          isNew={newIds.has(report.id)}
          onViewTransfer={onViewTransfer}
        />
      ))}

      {/* Infinite scroll sentinel */}
      {hasMore && (
        <div ref={sentinelRef} aria-hidden="true" className="h-4" />
      )}

      {/* Loading more indicator */}
      {isLoading && filtered.length > 0 && (
        <div className="flex justify-center py-4">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-border border-t-primary" />
        </div>
      )}
    </div>
  );
}
