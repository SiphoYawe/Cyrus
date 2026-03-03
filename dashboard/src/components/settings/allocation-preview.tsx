'use client';

import { useMemo, useEffect, useState } from 'react';
import { PieChart, Pie, Cell, ResponsiveContainer } from 'recharts';
import { cn } from '@/lib/utils';
import {
  getAllocation,
  toChartData,
  estimateRebalancingCost,
  TIER_COLORS,
  TIER_LABELS,
  type TierKey,
} from './risk-allocations';

interface AllocationPreviewProps {
  currentLevel: number;
  previewLevel: number;
  className?: string;
}

function DonutChart({ level, label }: { level: number; label: string }) {
  const alloc = getAllocation(level);
  const data = toChartData(alloc);

  return (
    <div className="flex flex-col items-center gap-3">
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{label}</p>
      <div className="relative h-28 w-28">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              cx="50%"
              cy="50%"
              innerRadius="55%"
              outerRadius="80%"
              paddingAngle={2}
              dataKey="value"
              isAnimationActive
              animationDuration={400}
              animationEasing="ease-out"
            >
              {data.map((entry) => (
                <Cell key={entry.name} fill={entry.fill} strokeWidth={0} />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className="text-lg font-bold text-foreground">{level}</span>
        </div>
      </div>
      {/* Legend */}
      <div className="space-y-1">
        {(Object.keys(TIER_LABELS) as TierKey[]).map((tier) => (
          <div key={tier} className="flex items-center justify-between gap-4 text-xs">
            <div className="flex items-center gap-1.5">
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ backgroundColor: TIER_COLORS[tier] }}
              />
              <span className="text-muted-foreground">{TIER_LABELS[tier]}</span>
            </div>
            <span className="font-medium tabular-nums text-foreground">
              {alloc[tier]}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function AllocationPreview({
  currentLevel,
  previewLevel,
  className,
}: AllocationPreviewProps) {
  const [debouncedPreview, setDebouncedPreview] = useState(previewLevel);

  useEffect(() => {
    const id = setTimeout(() => setDebouncedPreview(previewLevel), 100);
    return () => clearTimeout(id);
  }, [previewLevel]);

  const hasChanged = debouncedPreview !== currentLevel;

  const cost = useMemo(
    () => estimateRebalancingCost(currentLevel, debouncedPreview),
    [currentLevel, debouncedPreview],
  );

  return (
    <div className={cn('space-y-4', className)}>
      <div className="flex items-start justify-center gap-8">
        <DonutChart level={currentLevel} label="Current" />
        {hasChanged && (
          <>
            <div className="mt-12 flex-shrink-0 self-center">
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <path
                  d="M4 10h12M12 5l5 5-5 5"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="text-muted-foreground"
                />
              </svg>
            </div>
            <DonutChart level={debouncedPreview} label="New" />
          </>
        )}
      </div>

      {hasChanged && (
        <div
          className="rounded-lg border border-border bg-muted/30 px-4 py-3 text-center"
          aria-live="polite"
          aria-atomic="true"
        >
          <p className="text-xs text-muted-foreground">
            Estimated rebalancing:{' '}
            <span className="font-medium text-foreground">{cost.operations} operation{cost.operations !== 1 ? 's' : ''}</span>
            {' · '}
            <span className="font-medium text-foreground">~${cost.estimatedGasUsd.toFixed(2)} gas</span>
            {' · '}
            <span className="font-medium text-foreground">~{cost.estimatedMinutes} min</span>
          </p>
        </div>
      )}
    </div>
  );
}
