'use client';

import { type ReactNode } from 'react';
import NumberFlow from '@number-flow/react';
import { cn } from '@/lib/utils';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

export type KpiTrend = 'positive' | 'negative' | 'neutral' | 'warning';

interface KpiCardProps {
  title: string;
  value: number;
  format?: 'number' | 'percent' | 'usd';
  trend?: KpiTrend;
  subtitle?: string;
  icon?: ReactNode;
  isLoading?: boolean;
  className?: string;
  'data-testid'?: string;
}

function getTrendClass(trend?: KpiTrend): string {
  switch (trend) {
    case 'positive':
      return 'text-positive';
    case 'negative':
      return 'text-negative';
    case 'warning':
      return 'text-warning';
    default:
      return 'text-foreground';
  }
}

export function KpiCard({
  title,
  value,
  format = 'number',
  trend,
  subtitle,
  icon,
  isLoading = false,
  className,
  'data-testid': testId,
}: KpiCardProps) {
  const trendClass = getTrendClass(trend);

  const numberFormat =
    format === 'usd'
      ? ({ style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 } as const)
      : format === 'percent'
      ? ({ style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 } as const)
      : ({ minimumFractionDigits: 0, maximumFractionDigits: 0 } as const);

  // NumberFlow percent format requires value in [0, 1] range;
  // for our percent KPIs we already store them as 0-100, so pass value / 100
  const displayValue = format === 'percent' ? value / 100 : value;

  return (
    <Card
      className={cn('gap-3 py-5', className)}
      data-testid={testId}
    >
      <CardContent className="px-5 py-0">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1 space-y-1.5">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              {title}
            </p>
            {isLoading ? (
              <Skeleton className="h-8 w-28" />
            ) : (
              <div className={cn('text-2xl font-bold tabular-nums', trendClass)}>
                <NumberFlow value={displayValue} format={numberFormat} />
              </div>
            )}
            {subtitle && (
              <p className="text-xs text-muted-foreground">
                {isLoading ? <Skeleton className="h-3 w-20" /> : subtitle}
              </p>
            )}
          </div>
          {icon && (
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              {icon}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
