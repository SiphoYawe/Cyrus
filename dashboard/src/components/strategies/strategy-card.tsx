'use client';

import NumberFlow from '@number-flow/react';
import { formatDistanceToNow } from 'date-fns';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { Strategy, StrategyTier } from '@/stores/strategies-store';

const TIER_STYLES: Record<StrategyTier, string> = {
  Safe: 'bg-blue-500/15 text-blue-500 border-blue-500/30',
  Growth: 'bg-violet-500/15 text-violet-500 border-violet-500/30',
  Degen: 'bg-amber-500/15 text-amber-500 border-amber-500/30',
};

function winRateColor(rate: number): string {
  if (rate >= 70) return 'text-positive';
  if (rate >= 50) return 'text-warning';
  return 'text-negative';
}

// Minimal inline SVG icons using HugeIcons visual style (stroke, rounded)
function TrendUpSvg({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={cn('size-3 shrink-0', className)} aria-hidden="true">
      <path d="M3 17L9 11L13 15L21 7" />
      <path d="M16 7H21V12" />
    </svg>
  );
}

function TrendDownSvg({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={cn('size-3 shrink-0', className)} aria-hidden="true">
      <path d="M3 7L9 13L13 9L21 17" />
      <path d="M16 17H21V12" />
    </svg>
  );
}

function ChartLineSvg({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={cn('size-3 shrink-0', className)} aria-hidden="true">
      <path d="M3 19L9 13L13 17L21 9" />
      <path d="M3 5H21" />
      <path d="M3 19H21" />
    </svg>
  );
}

function BarChartSvg({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={cn('size-3 shrink-0', className)} aria-hidden="true">
      <path d="M6 20V14" />
      <path d="M10 20V9" />
      <path d="M14 20V12" />
      <path d="M18 20V5" />
      <path d="M3 20H21" />
    </svg>
  );
}

function GridSvg({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={cn('size-3 shrink-0', className)} aria-hidden="true">
      <rect x="3" y="3" width="8" height="8" rx="1" />
      <rect x="13" y="3" width="8" height="8" rx="1" />
      <rect x="3" y="13" width="8" height="8" rx="1" />
      <rect x="13" y="13" width="8" height="8" rx="1" />
    </svg>
  );
}

function ClockSvg({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={cn('size-3 shrink-0', className)} aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7V12L15 15" />
    </svg>
  );
}

interface StrategyCardProps {
  strategy: Strategy;
  onToggle: (name: string, enabled: boolean) => void;
  togglePending: boolean;
  onClick: (strategy: Strategy) => void;
}

export function StrategyCard({
  strategy,
  onToggle,
  togglePending,
  onClick,
}: StrategyCardProps) {
  const { name, enabled, tier, metrics } = strategy;
  const {
    totalPnl,
    winRate,
    totalTrades,
    openPositions,
    lastSignalAt,
  } = metrics;

  const isPnlPositive = totalPnl >= 0;

  const lastSignalLabel = lastSignalAt
    ? formatDistanceToNow(new Date(lastSignalAt), { addSuffix: true })
    : 'No signals yet';

  const lastSignalFull = lastSignalAt
    ? new Date(lastSignalAt).toLocaleString()
    : null;

  const handleCardClick = () => {
    onClick(strategy);
  };

  const handleToggleAreaClick = (e: React.MouseEvent) => {
    e.stopPropagation();
  };

  const handleSwitchChange = (checked: boolean) => {
    onToggle(name, checked);
  };

  return (
    <Card
      className="cursor-pointer transition-colors hover:bg-card/80 hover:border-border/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      role="button"
      tabIndex={0}
      onClick={handleCardClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleCardClick();
        }
      }}
      aria-label={`Open ${name} strategy details`}
    >
      <CardHeader className="pb-0">
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-1.5 min-w-0">
            <h3 className="text-lg font-bold leading-tight truncate">{name}</h3>
            <div className="flex items-center gap-2 flex-wrap">
              {/* Status badge */}
              <Badge
                variant="outline"
                className={cn(
                  'h-5 border px-2 text-[10px] font-semibold uppercase tracking-wide',
                  enabled
                    ? 'bg-green-500/15 text-green-500 border-green-500/30'
                    : 'bg-zinc-600/20 text-zinc-400 border-zinc-600/30'
                )}
              >
                {enabled ? 'Active' : 'Inactive'}
              </Badge>
              {/* Tier badge */}
              <Badge
                variant="outline"
                className={cn(
                  'h-5 border px-2 text-[10px] font-semibold uppercase tracking-wide',
                  TIER_STYLES[tier]
                )}
              >
                {tier}
              </Badge>
            </div>
          </div>

          {/* Toggle switch — stopPropagation so card click doesn't fire */}
          <div
            className="flex items-center shrink-0 pt-1"
            onClick={handleToggleAreaClick}
            role="presentation"
          >
            <Switch
              checked={enabled}
              onCheckedChange={handleSwitchChange}
              disabled={togglePending}
              aria-label={`Toggle ${name} strategy ${enabled ? 'off' : 'on'}`}
              className={cn(togglePending && 'opacity-60')}
            />
          </div>
        </div>
      </CardHeader>

      <CardContent className="pt-4">
        <div className="grid grid-cols-2 gap-3">
          {/* Total P&L */}
          <div className="flex flex-col gap-0.5">
            <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground flex items-center gap-1">
              {isPnlPositive ? <TrendUpSvg /> : <TrendDownSvg />}
              Total P&amp;L
            </span>
            <span
              className={cn(
                'font-mono text-sm font-semibold',
                isPnlPositive ? 'text-positive' : 'text-negative'
              )}
            >
              {!isPnlPositive && totalPnl !== 0 ? '-' : ''}$
              <NumberFlow
                value={Math.abs(totalPnl)}
                format={{ minimumFractionDigits: 2, maximumFractionDigits: 2 }}
                aria-label={`Total P&L: ${totalPnl < 0 ? '-' : ''}$${Math.abs(totalPnl).toFixed(2)}`}
              />
            </span>
          </div>

          {/* Win Rate */}
          <div className="flex flex-col gap-0.5">
            <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground flex items-center gap-1">
              <ChartLineSvg />
              Win Rate
            </span>
            <span
              className={cn('font-mono text-sm font-semibold', winRateColor(winRate))}
            >
              <NumberFlow
                value={winRate}
                format={{ minimumFractionDigits: 1, maximumFractionDigits: 1 }}
                suffix="%"
                aria-label={`Win rate: ${winRate.toFixed(1)}%`}
              />
            </span>
          </div>

          {/* Total Trades */}
          <div className="flex flex-col gap-0.5">
            <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground flex items-center gap-1">
              <BarChartSvg />
              Trades
            </span>
            <span className="font-mono text-sm font-semibold text-foreground">
              <NumberFlow
                value={totalTrades}
                aria-label={`Total trades: ${totalTrades}`}
              />
            </span>
          </div>

          {/* Open Positions */}
          <div className="flex flex-col gap-0.5">
            <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground flex items-center gap-1">
              <GridSvg />
              Open Pos.
            </span>
            <span className="font-mono text-sm font-semibold text-foreground">
              <NumberFlow
                value={openPositions}
                aria-label={`Open positions: ${openPositions}`}
              />
            </span>
          </div>
        </div>

        {/* Last signal */}
        <div className="mt-3 flex items-center gap-1.5 border-t border-border/50 pt-3">
          <ClockSvg className="text-muted-foreground" />
          <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Last Signal
          </span>
          {lastSignalFull ? (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="ml-auto text-xs text-muted-foreground font-mono truncate cursor-default">
                    {lastSignalLabel}
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top">
                  <p>{lastSignalFull}</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ) : (
            <span className="ml-auto text-xs text-muted-foreground font-mono">
              {lastSignalLabel}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
