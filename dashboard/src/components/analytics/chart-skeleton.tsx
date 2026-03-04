'use client';

import { Skeleton } from '@/components/ui/skeleton';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { cn } from '@/lib/utils';

interface ChartSkeletonProps {
  variant?: 'price' | 'treemap' | 'matrix' | 'metrics';
  className?: string;
}

export function ChartSkeleton({ variant = 'price', className }: ChartSkeletonProps) {
  return (
    <Card className={cn('border-border bg-card', className)}>
      <CardHeader className="pb-2">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-3 w-24" />
      </CardHeader>
      <CardContent>
        {variant === 'price' && <PriceChartSkeleton />}
        {variant === 'treemap' && <TreemapSkeleton />}
        {variant === 'matrix' && <MatrixSkeleton />}
        {variant === 'metrics' && <MetricsSkeleton />}
      </CardContent>
    </Card>
  );
}

// Pre-computed heights to avoid calling Math.random() during render (impure function)
const PRICE_CHART_HEIGHTS = [
  65, 42, 78, 55, 88, 34, 72, 91, 48, 63,
  82, 39, 57, 76, 44, 95, 61, 83, 50, 70,
  37, 66, 89, 53, 74, 41, 86, 59, 77, 47,
] as const;

function PriceChartSkeleton() {
  return (
    <div className="space-y-3" data-testid="price-chart-skeleton">
      <div className="flex items-end gap-1 h-[300px]">
        {PRICE_CHART_HEIGHTS.map((h, i) => (
          <Skeleton
            key={i}
            className="flex-1"
            style={{ height: `${h}%` }}
          />
        ))}
      </div>
      <div className="flex gap-2">
        <Skeleton className="h-7 w-14" />
        <Skeleton className="h-7 w-14" />
        <Skeleton className="h-7 w-14" />
      </div>
    </div>
  );
}

function TreemapSkeleton() {
  return (
    <div className="grid grid-cols-4 grid-rows-3 gap-1 h-[300px]" data-testid="treemap-skeleton">
      <Skeleton className="col-span-2 row-span-2" />
      <Skeleton className="col-span-1 row-span-2" />
      <Skeleton className="col-span-1 row-span-1" />
      <Skeleton className="col-span-1 row-span-1" />
      <Skeleton className="col-span-2 row-span-1" />
      <Skeleton className="col-span-1 row-span-1" />
      <Skeleton className="col-span-1 row-span-1" />
    </div>
  );
}

function MatrixSkeleton() {
  return (
    <div className="space-y-1" data-testid="matrix-skeleton">
      {Array.from({ length: 6 }).map((_, row) => (
        <div key={row} className="flex gap-1">
          {Array.from({ length: 6 }).map((_, col) => (
            <Skeleton key={col} className="h-10 flex-1" />
          ))}
        </div>
      ))}
    </div>
  );
}

function MetricsSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-4" data-testid="metrics-skeleton">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="space-y-2">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-8 w-20" />
        </div>
      ))}
    </div>
  );
}
