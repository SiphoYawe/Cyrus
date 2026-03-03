'use client';

import { lazy, Suspense } from 'react';
import { MorningBriefingBanner } from '@/components/overview/morning-briefing-banner';
import { KpiGrid } from '@/components/overview/kpi-grid';
import { RecentDecisions } from '@/components/overview/recent-decisions';
import { CardErrorBoundary } from '@/components/shared/card-error-boundary';
import { Skeleton } from '@/components/ui/skeleton';
import { usePortfolioOverview } from '@/hooks/use-portfolio-overview';
import { usePortfolioHistory } from '@/hooks/use-portfolio-history';
import { useTransfersStore } from '@/stores/transfers-store';

// Lazy-load chart components for <3s initial page load
const TierAllocationChart = lazy(
  () =>
    import('@/components/overview/tier-allocation-chart').then((m) => ({
      default: m.TierAllocationChart,
    }))
);

const PortfolioValueChart = lazy(
  () =>
    import('@/components/overview/portfolio-value-chart').then((m) => ({
      default: m.PortfolioValueChart,
    }))
);

const ChainAllocationList = lazy(
  () =>
    import('@/components/overview/chain-allocation-list').then((m) => ({
      default: m.ChainAllocationList,
    }))
);

function ChartSkeleton({ className }: { className?: string }) {
  return <Skeleton className={`w-full rounded-xl ${className ?? 'h-52'}`} />;
}

export default function OverviewPage() {
  const { data, isLoading, error: portfolioError, refetch } = usePortfolioOverview();
  const { data: historyData, isLoading: historyLoading, timeRange, setTimeRange } = usePortfolioHistory();
  const activeOperations = useTransfersStore((s) => s.active.size);

  return (
    <div className="space-y-6">
      {/* Morning Briefing Banner — full width, inline with page content */}
      <MorningBriefingBanner />

      {/* Page header */}
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Overview</h2>
        <p className="text-sm text-muted-foreground">
          Portfolio snapshot and agent activity
        </p>
      </div>

      {/* KPI Cards — 2x2 mobile, 4x1 desktop */}
      <CardErrorBoundary onRetry={refetch} className="rounded-xl">
        <KpiGrid
          data={data}
          isLoading={isLoading}
          activeOperations={activeOperations}
        />
      </CardErrorBoundary>

      {/* Charts row — DonutChart + ChainAllocationList side-by-side */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <CardErrorBoundary onRetry={refetch}>
          <Suspense fallback={<ChartSkeleton className="h-52" />}>
            <TierAllocationChart
              allocations={data.allocations}
              isLoading={isLoading}
            />
          </Suspense>
        </CardErrorBoundary>

        <CardErrorBoundary onRetry={refetch}>
          <Suspense fallback={<ChartSkeleton className="h-52" />}>
            <ChainAllocationList
              chainAllocations={data.chainAllocations}
              isLoading={isLoading}
            />
          </Suspense>
        </CardErrorBoundary>
      </div>

      {/* Portfolio Value Area Chart — full width */}
      <CardErrorBoundary>
        <Suspense fallback={<ChartSkeleton className="h-56" />}>
          <PortfolioValueChart
            data={historyData}
            isLoading={historyLoading}
            timeRange={timeRange}
            onTimeRangeChange={setTimeRange}
          />
        </Suspense>
      </CardErrorBoundary>

      {/* Recent Decisions */}
      <CardErrorBoundary>
        <RecentDecisions />
      </CardErrorBoundary>

      {/* Portfolio error notice (non-blocking) */}
      {portfolioError && !isLoading && (
        <p className="text-xs text-muted-foreground text-center">
          Portfolio data may be stale — {portfolioError.message}
        </p>
      )}
    </div>
  );
}
