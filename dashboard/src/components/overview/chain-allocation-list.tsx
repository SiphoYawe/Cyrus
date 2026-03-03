'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import type { ChainAllocation } from '@/stores/portfolio-store';

const CHAIN_COLORS: Record<number, { bg: string; label: string }> = {
  1:     { bg: '#627EEA', label: 'ETH' },
  42161: { bg: '#28A0F0', label: 'ARB' },
  10:    { bg: '#FF0420', label: 'OP' },
  137:   { bg: '#8247E5', label: 'POLY' },
  8453:  { bg: '#0052FF', label: 'BASE' },
  56:    { bg: '#F0B90B', label: 'BSC' },
};

const DEFAULT_CHAIN_COLOR = '#71717A';

interface BarRowProps {
  allocation: ChainAllocation;
}

function BarRow({ allocation }: BarRowProps) {
  const chain = CHAIN_COLORS[allocation.chainId];
  const color = chain?.bg ?? DEFAULT_CHAIN_COLOR;
  const label = chain?.label ?? allocation.name;

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ backgroundColor: color }}
            aria-hidden="true"
          />
          <span className="truncate text-xs text-muted-foreground">{label}</span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="font-mono text-xs font-medium text-foreground">
            {allocation.percentage.toFixed(1)}%
          </span>
          <span className="font-mono text-[10px] text-muted-foreground">
            ${allocation.usdValue.toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 1 })}
          </span>
        </div>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{
            width: `${Math.min(100, allocation.percentage)}%`,
            backgroundColor: color,
          }}
          role="progressbar"
          aria-valuenow={allocation.percentage}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${label}: ${allocation.percentage.toFixed(1)}%`}
        />
      </div>
    </div>
  );
}

interface ChainAllocationListProps {
  chainAllocations: ChainAllocation[];
  isLoading: boolean;
}

export function ChainAllocationList({ chainAllocations, isLoading }: ChainAllocationListProps) {
  const sorted = [...chainAllocations].sort((a, b) => b.percentage - a.percentage);

  return (
    <Card className="gap-4 py-5">
      <CardHeader className="px-5 py-0">
        <CardTitle className="text-sm font-semibold">Chain Allocation</CardTitle>
      </CardHeader>
      <CardContent className={cn('px-5 py-0', isLoading ? 'space-y-3' : 'space-y-3')}>
        {isLoading ? (
          <>
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="space-y-1">
                <div className="flex justify-between">
                  <Skeleton className="h-3 w-16" />
                  <Skeleton className="h-3 w-12" />
                </div>
                <Skeleton className="h-1.5 w-full rounded-full" />
              </div>
            ))}
          </>
        ) : sorted.length === 0 ? (
          <p className="text-xs text-muted-foreground py-4 text-center">No chain data</p>
        ) : (
          sorted.map((alloc) => (
            <BarRow key={alloc.chainId} allocation={alloc} />
          ))
        )}
      </CardContent>
    </Card>
  );
}
