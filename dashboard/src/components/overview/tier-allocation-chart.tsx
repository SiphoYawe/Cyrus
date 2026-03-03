'use client';

import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import type { Allocation } from '@/stores/portfolio-store';

const TIER_COLORS: Record<string, string> = {
  Safe: '#3B82F6',     // blue-500
  Growth: '#8B5CF6',   // violet-500
  Degen: '#F59E0B',    // amber-500
  Reserve: '#71717A',  // zinc-500
};

interface TierAllocationChartProps {
  allocations: Allocation[];
  isLoading: boolean;
}

interface CustomTooltipProps {
  active?: boolean;
  payload?: Array<{ name: string; value: number; payload: Allocation }>;
}

function CustomTooltip({ active, payload }: CustomTooltipProps) {
  if (!active || !payload?.length) return null;
  const item = payload[0];
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2 shadow-lg">
      <p className="text-xs font-medium text-foreground">{item.name}</p>
      <p className="font-mono text-sm text-muted-foreground">
        {item.value.toFixed(1)}%&nbsp;—&nbsp;
        ${item.payload.usdValue.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
      </p>
    </div>
  );
}

interface LegendEntryProps {
  tier: string;
  percentage: number;
}

function LegendEntry({ tier, percentage }: LegendEntryProps) {
  const color = TIER_COLORS[tier] ?? '#71717A';
  return (
    <div className="flex items-center gap-2">
      <span
        className="h-2.5 w-2.5 shrink-0 rounded-full"
        style={{ backgroundColor: color }}
        aria-hidden="true"
      />
      <span className="text-xs text-muted-foreground">{tier}</span>
      <span className="ml-auto font-mono text-xs font-medium text-foreground">
        {percentage.toFixed(1)}%
      </span>
    </div>
  );
}

export function TierAllocationChart({ allocations, isLoading }: TierAllocationChartProps) {
  const hasData = allocations.length > 0;

  return (
    <Card className="gap-4 py-5">
      <CardHeader className="px-5 py-0">
        <CardTitle className="text-sm font-semibold">Tier Allocation</CardTitle>
      </CardHeader>
      <CardContent className="px-5 py-0">
        {isLoading ? (
          <div className="flex items-center gap-6">
            <Skeleton className="h-36 w-36 rounded-full" />
            <div className="flex-1 space-y-2">
              {[1, 2, 3, 4].map((i) => (
                <Skeleton key={i} className="h-3 w-full" />
              ))}
            </div>
          </div>
        ) : !hasData ? (
          <div className="flex h-36 items-center justify-center">
            <p className="text-xs text-muted-foreground">No allocation data</p>
          </div>
        ) : (
          <div className="flex items-center gap-6">
            <div className="h-36 w-36 shrink-0" role="img" aria-label="Tier allocation donut chart">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={allocations}
                    dataKey="percentage"
                    nameKey="tier"
                    cx="50%"
                    cy="50%"
                    innerRadius="60%"
                    outerRadius="90%"
                    strokeWidth={2}
                    stroke="transparent"
                  >
                    {allocations.map((entry) => (
                      <Cell
                        key={entry.tier}
                        fill={TIER_COLORS[entry.tier] ?? '#71717A'}
                      />
                    ))}
                  </Pie>
                  <Tooltip content={<CustomTooltip />} />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div className="flex-1 min-w-0 space-y-2">
              {allocations.map((alloc) => (
                <LegendEntry
                  key={alloc.tier}
                  tier={alloc.tier}
                  percentage={alloc.percentage}
                />
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
