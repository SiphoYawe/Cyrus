'use client';

import { type ReactNode } from 'react';
import NumberFlow from '@number-flow/react';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

export type KpiCardVariant = 'default' | 'positive' | 'negative';

interface KpiCardProps {
  label: string;
  value: number;
  isLoading?: boolean;
  variant?: KpiCardVariant;
  prefix?: string;
  suffix?: string;
  decimals?: number;
  icon?: ReactNode;
  subtext?: ReactNode;
  className?: string;
}

const VARIANT_VALUE_CLASS: Record<KpiCardVariant, string> = {
  default: 'text-foreground',
  positive: 'text-positive',
  negative: 'text-negative',
};

export function KpiCard({
  label,
  value,
  isLoading = false,
  variant = 'default',
  prefix,
  suffix,
  decimals = 2,
  icon,
  subtext,
  className,
}: KpiCardProps) {
  return (
    <Card className={cn('gap-3 py-5', className)}>
      <CardContent className="px-5 py-0">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0 space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              {label}
            </p>
            {isLoading ? (
              <Skeleton className="h-8 w-32" />
            ) : (
              <div className={cn('font-mono text-2xl font-bold tabular-nums', VARIANT_VALUE_CLASS[variant])}>
                {prefix && <span>{prefix}</span>}
                <NumberFlow
                  value={value}
                  format={{
                    minimumFractionDigits: decimals,
                    maximumFractionDigits: decimals,
                    useGrouping: true,
                  }}
                  transformTiming={{ duration: 500 }}
                  spinTiming={{ duration: 500, easing: 'ease-out' }}
                />
                {suffix && <span>{suffix}</span>}
              </div>
            )}
            {subtext && (
              <div className="text-xs text-muted-foreground">
                {isLoading ? <Skeleton className="h-3 w-20" /> : subtext}
              </div>
            )}
          </div>
          {icon && (
            <div className="shrink-0 flex h-9 w-9 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              {icon}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
