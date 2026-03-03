'use client';

import { useState } from 'react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
function Cancel01Svg({ size }: { size?: number }) {
  const s = size ?? 14;
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 18L18 6M6 6L18 18" />
    </svg>
  );
}

function TrendUpSvg({ size }: { size?: number }) {
  const s = size ?? 14;
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 17L9 11L13 15L21 7" />
      <path d="M16 7H21V12" />
    </svg>
  );
}

function TrendDownSvg({ size }: { size?: number }) {
  const s = size ?? 14;
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 7L9 13L13 9L21 17" />
      <path d="M16 17H21V12" />
    </svg>
  );
}
import { useMorningBriefing } from '@/hooks/use-morning-briefing';

const RISK_BADGE_STYLES = {
  Low: 'bg-positive/15 text-positive border-positive/30',
  Medium: 'bg-warning/15 text-warning border-warning/30',
  High: 'bg-negative/15 text-negative border-negative/30',
};

export function MorningBriefingBanner() {
  const { data, isLoading, error } = useMorningBriefing();
  const [dismissed, setDismissed] = useState(false);

  if (dismissed) return null;

  // Don't show banner if there's no data and no loading state
  if (!isLoading && (error || !data)) return null;

  const isPositivePnl = (data?.overnightPnl ?? 0) >= 0;
  const pnlSign = isPositivePnl ? '+' : '';
  const yieldSign = (data?.yieldDelta ?? 0) >= 0 ? '+' : '';

  return (
    <div
      role="banner"
      aria-label="Morning briefing"
      className="relative w-full border-b border-border bg-card/60 backdrop-blur-sm px-6 py-3"
    >
      {isLoading && !data ? (
        <div className="flex items-center gap-6">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-5 w-16 rounded-full" />
        </div>
      ) : data ? (
        <div className="flex items-center gap-6 flex-wrap pr-8">
          {/* Overnight P&L */}
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground">Overnight P&L</span>
            <span
              className={cn(
                'flex items-center gap-0.5 text-sm font-semibold font-mono',
                isPositivePnl ? 'text-positive' : 'text-negative'
              )}
            >
              {isPositivePnl ? (
                <TrendUpSvg size={14} />
              ) : (
                <TrendDownSvg size={14} />
              )}
              {pnlSign}
              {data.overnightPnlPercent.toFixed(2)}%&nbsp;
              <span className="text-xs font-normal opacity-80">
                ({pnlSign}${Math.abs(data.overnightPnl).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })})
              </span>
            </span>
          </div>

          {/* Separator */}
          <div className="h-4 w-px bg-border shrink-0" aria-hidden="true" />

          {/* Operations */}
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground">Operations</span>
            <span className="text-sm font-semibold font-mono">{data.operationsCount}</span>
          </div>

          {/* Separator */}
          <div className="h-4 w-px bg-border shrink-0" aria-hidden="true" />

          {/* Yield delta */}
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground">Yield Change</span>
            <span
              className={cn(
                'text-sm font-semibold font-mono',
                data.yieldDelta >= 0 ? 'text-positive' : 'text-negative'
              )}
            >
              {yieldSign}{data.yieldDelta.toFixed(2)}%
            </span>
          </div>

          {/* Separator */}
          <div className="h-4 w-px bg-border shrink-0" aria-hidden="true" />

          {/* Risk status */}
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground">Risk</span>
            <Badge
              variant="outline"
              className={cn(
                'h-5 border px-2 text-[10px] font-semibold uppercase tracking-wide',
                RISK_BADGE_STYLES[data.riskStatus]
              )}
            >
              {data.riskStatus}
            </Badge>
          </div>
        </div>
      ) : null}

      {/* Dismiss */}
      <Button
        variant="ghost"
        size="icon"
        className="absolute right-3 top-1/2 -translate-y-1/2 h-7 w-7 text-muted-foreground hover:text-foreground"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss morning briefing"
      >
        <Cancel01Svg size={14} />
      </Button>
    </div>
  );
}
