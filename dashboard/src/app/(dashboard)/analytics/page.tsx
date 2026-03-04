'use client';

import { lazy, Suspense } from 'react';
import { useAnalyticsData } from '@/hooks/use-analytics-data';
import { ChartSkeleton } from '@/components/analytics/chart-skeleton';
import { Button } from '@/components/ui/button';

// Code-split all chart components
const PriceChart = lazy(() =>
  import('@/components/analytics/price-chart').then((m) => ({
    default: m.PriceChart,
  }))
);

const PortfolioTreemap = lazy(() =>
  import('@/components/analytics/portfolio-treemap').then((m) => ({
    default: m.PortfolioTreemap,
  }))
);

const CorrelationMatrix = lazy(() =>
  import('@/components/analytics/correlation-matrix').then((m) => ({
    default: m.CorrelationMatrix,
  }))
);

const RiskMetricsPanel = lazy(() =>
  import('@/components/analytics/risk-metrics-panel').then((m) => ({
    default: m.RiskMetricsPanel,
  }))
);

const SYMBOLS = ['ETH', 'BTC', 'ARB', 'OP', 'MATIC', 'LINK'];

export default function AnalyticsPage() {
  const {
    data,
    isLoading,
    error,
    refetch,
    selectedSymbol,
    setSelectedSymbol,
  } = useAnalyticsData();

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">Analytics</h2>
          <p className="text-sm text-muted-foreground">
            Advanced portfolio analytics and risk metrics
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* Symbol selector */}
          <div className="flex items-center gap-1 rounded-lg bg-secondary p-1">
            {SYMBOLS.map((sym) => (
              <Button
                key={sym}
                variant={selectedSymbol === sym ? 'default' : 'ghost'}
                size="sm"
                className="h-7 px-2.5 text-xs font-mono"
                onClick={() => setSelectedSymbol(sym)}
              >
                {sym}
              </Button>
            ))}
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={refetch}
            className="h-8"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="mr-1.5"
            >
              <path d="M21 2v6h-6" />
              <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
              <path d="M3 22v-6h6" />
              <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
            </svg>
            Refresh
          </Button>
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="rounded-lg border border-warning/30 bg-warning-muted px-4 py-3 text-sm text-warning">
          <span className="font-medium">API unavailable</span> — showing
          simulated data. {error.message}
        </div>
      )}

      {/* Price Chart — Full Width */}
      <Suspense fallback={<ChartSkeleton variant="price" />}>
        {isLoading || !data ? (
          <ChartSkeleton variant="price" />
        ) : (
          <PriceChart data={data.priceHistory} />
        )}
      </Suspense>

      {/* Two-column: Treemap + Correlation */}
      <div className="grid gap-6 lg:grid-cols-2">
        <Suspense fallback={<ChartSkeleton variant="treemap" />}>
          {isLoading || !data ? (
            <ChartSkeleton variant="treemap" />
          ) : (
            <PortfolioTreemap data={data.allocations} />
          )}
        </Suspense>

        <Suspense fallback={<ChartSkeleton variant="matrix" />}>
          {isLoading || !data ? (
            <ChartSkeleton variant="matrix" />
          ) : (
            <CorrelationMatrix data={data.correlation} />
          )}
        </Suspense>
      </div>

      {/* Risk Metrics — Full Width */}
      <Suspense fallback={<ChartSkeleton variant="metrics" />}>
        {isLoading || !data ? (
          <ChartSkeleton variant="metrics" />
        ) : (
          <RiskMetricsPanel data={data.riskMetrics} />
        )}
      </Suspense>
    </div>
  );
}
