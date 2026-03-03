'use client';

import { DecisionReportCard } from '@/components/shared/decision-report-card';
import { EmptyState } from '@/components/shared/empty-state';
import { CardErrorBoundary } from '@/components/shared/card-error-boundary';
import { Skeleton } from '@/components/ui/skeleton';
function AlertCircleSvg() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="size-[22px]" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8V12" />
      <circle cx="12" cy="16" r="0.5" fill="currentColor" />
    </svg>
  );
}
import { useRecentDecisions } from '@/hooks/use-recent-decisions';

export function RecentDecisions() {
  const { data, isLoading, error, refetch } = useRecentDecisions(5);

  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-5 w-36" />
        {[1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-16 w-full rounded-xl" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <CardErrorBoundary onRetry={refetch}>
        <div className="rounded-xl border bg-card px-4 py-8 text-center">
          <p className="text-xs text-muted-foreground">Failed to load decisions</p>
        </div>
      </CardErrorBoundary>
    );
  }

  if (data.length === 0) {
    return (
      <EmptyState
        icon={<AlertCircleSvg />}
        message="All quiet. Your agent is monitoring."
        className="rounded-xl border bg-card"
      />
    );
  }

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-foreground">Recent Decisions</h3>
      <div className="space-y-2">
        {data.map((report) => (
          <DecisionReportCard key={report.id} report={report} />
        ))}
      </div>
    </div>
  );
}
