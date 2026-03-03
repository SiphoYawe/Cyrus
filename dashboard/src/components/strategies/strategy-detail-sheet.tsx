'use client';

import NumberFlow from '@number-flow/react';
import { formatDistanceToNow } from 'date-fns';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import type { Strategy, StrategyTier, StrategyPerformancePoint } from '@/stores/strategies-store';
import type { DecisionReport, TimeRange } from '@/hooks/use-strategy-detail';

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

function formatChartDate(timestamp: number, range: TimeRange): string {
  const d = new Date(timestamp);
  if (range === '1W') {
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  }
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// Inline SVG icons
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

function CheckCircleSvg({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={cn('size-3.5 shrink-0', className)} aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12L11 15L16 9" />
    </svg>
  );
}

function XCircleSvg({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={cn('size-3.5 shrink-0', className)} aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M15 9L9 15M9 9L15 15" />
    </svg>
  );
}

function ClockCircleSvg({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={cn('size-3.5 shrink-0', className)} aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7V12L14.5 14.5" />
    </svg>
  );
}

// Empty state icon for no strategies
export function ChartLineDataSvg({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={cn('size-6', className)} aria-hidden="true">
      <path d="M3 20L8 14L12 17L17 11L21 14" />
      <path d="M3 4H21" />
      <path d="M3 20H21" />
      <path d="M3 4V20" />
    </svg>
  );
}

interface DecisionReportCardProps {
  report: DecisionReport;
}

function DecisionReportCard({ report }: DecisionReportCardProps) {
  const outcomeIcon = {
    success: <CheckCircleSvg className="text-positive" />,
    failure: <XCircleSvg className="text-negative" />,
    pending: <ClockCircleSvg className="text-warning" />,
  };

  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-muted/30 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {report.outcome ? outcomeIcon[report.outcome] : null}
          <span className="text-sm font-semibold text-foreground truncate">{report.action}</span>
        </div>
        <span className="text-[10px] text-muted-foreground font-mono shrink-0">
          {formatDistanceToNow(new Date(report.timestamp), { addSuffix: true })}
        </span>
      </div>
      <p className="text-xs text-muted-foreground leading-relaxed line-clamp-2">
        {report.reasoning}
      </p>
    </div>
  );
}

interface StrategyDetailSheetProps {
  strategy: Strategy | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onToggle: (name: string, enabled: boolean) => void;
  togglePending: boolean;
  performanceHistory: StrategyPerformancePoint[];
  decisionReports: DecisionReport[];
  isLoading: boolean;
  timeRange: TimeRange;
  onTimeRangeChange: (range: TimeRange) => void;
}

const TIME_RANGES: TimeRange[] = ['1W', '1M', '3M', 'All'];

export function StrategyDetailSheet({
  strategy,
  open,
  onOpenChange,
  onToggle,
  togglePending,
  performanceHistory,
  decisionReports,
  isLoading,
  timeRange,
  onTimeRangeChange,
}: StrategyDetailSheetProps) {
  if (!strategy) return null;

  const { name, enabled, tier, metrics, params } = strategy;
  const { totalPnl, winRate, totalTrades, openPositions, lastSignalAt } = metrics;
  const isPnlPositive = totalPnl >= 0;

  const lastSignalLabel = lastSignalAt
    ? formatDistanceToNow(new Date(lastSignalAt), { addSuffix: true })
    : 'No signals yet';

  const chartData = performanceHistory.map((p) => ({
    date: formatChartDate(p.timestamp, timeRange),
    pnl: p.pnl,
    timestamp: p.timestamp,
  }));

  const minPnl = chartData.length ? Math.min(...chartData.map((d) => d.pnl)) : 0;
  const maxPnl = chartData.length ? Math.max(...chartData.map((d) => d.pnl)) : 0;
  const chartColor = (chartData[chartData.length - 1]?.pnl ?? 0) >= 0 ? '#8B5CF6' : '#EF4444';

  const handleToggle = (checked: boolean) => {
    onToggle(name, checked);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-[480px] sm:max-w-[480px] p-0 flex flex-col"
        aria-label={`${name} strategy details`}
      >
        {/* Header */}
        <SheetHeader className="border-b border-border px-6 py-4 shrink-0">
          <div className="flex items-start justify-between gap-3 pr-8">
            <div className="flex flex-col gap-2 min-w-0">
              <SheetTitle className="text-lg font-bold leading-tight">{name}</SheetTitle>
              <SheetDescription className="sr-only">
                Strategy configuration, performance metrics, and decision reports for {name}
              </SheetDescription>
              <div className="flex items-center gap-2 flex-wrap">
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
            <div className="shrink-0 pt-1">
              <Switch
                checked={enabled}
                onCheckedChange={handleToggle}
                disabled={togglePending}
                aria-label={`Toggle ${name} strategy ${enabled ? 'off' : 'on'}`}
                className={cn(togglePending && 'opacity-60')}
              />
            </div>
          </div>
        </SheetHeader>

        <ScrollArea className="flex-1">
          <div className="flex flex-col gap-6 px-6 py-4">
            {/* Metrics summary */}
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-0.5 rounded-lg border border-border bg-muted/30 p-3">
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
                  />
                </span>
              </div>

              <div className="flex flex-col gap-0.5 rounded-lg border border-border bg-muted/30 p-3">
                <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground flex items-center gap-1">
                  <ChartLineSvg />
                  Win Rate
                </span>
                <span className={cn('font-mono text-sm font-semibold', winRateColor(winRate))}>
                  <NumberFlow
                    value={winRate}
                    format={{ minimumFractionDigits: 1, maximumFractionDigits: 1 }}
                    suffix="%"
                  />
                </span>
              </div>

              <div className="flex flex-col gap-0.5 rounded-lg border border-border bg-muted/30 p-3">
                <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground flex items-center gap-1">
                  <BarChartSvg />
                  Total Trades
                </span>
                <span className="font-mono text-sm font-semibold text-foreground">
                  <NumberFlow value={totalTrades} />
                </span>
              </div>

              <div className="flex flex-col gap-0.5 rounded-lg border border-border bg-muted/30 p-3">
                <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground flex items-center gap-1">
                  <GridSvg />
                  Open Positions
                </span>
                <span className="font-mono text-sm font-semibold text-foreground">
                  <NumberFlow value={openPositions} />
                </span>
              </div>
            </div>

            {/* Last signal */}
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <ClockSvg />
              <span className="font-medium">Last Signal:</span>
              <span className="font-mono">{lastSignalLabel}</span>
            </div>

            <Separator />

            {/* Performance chart */}
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-semibold text-foreground">Performance</h4>
                <Tabs value={timeRange} onValueChange={(v) => onTimeRangeChange(v as TimeRange)}>
                  <TabsList className="h-7 gap-0 p-0.5">
                    {TIME_RANGES.map((range) => (
                      <TabsTrigger
                        key={range}
                        value={range}
                        className="h-6 px-2 text-[11px]"
                      >
                        {range}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                </Tabs>
              </div>

              {isLoading ? (
                <Skeleton className="h-40 w-full rounded-lg" />
              ) : chartData.length > 0 ? (
                <div className="h-40 w-full" aria-label="Strategy performance chart">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                      <defs>
                        <linearGradient id="strategyPnlGradient" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor={chartColor} stopOpacity={0.3} />
                          <stop offset="95%" stopColor={chartColor} stopOpacity={0.02} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.5} />
                      <XAxis
                        dataKey="date"
                        tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                        tickLine={false}
                        axisLine={false}
                        interval="preserveStartEnd"
                      />
                      <YAxis
                        domain={[minPnl * 1.05, maxPnl * 1.05]}
                        tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                        tickLine={false}
                        axisLine={false}
                        tickFormatter={(v: number) => `$${v.toFixed(0)}`}
                        width={48}
                      />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: 'hsl(var(--popover))',
                          border: '1px solid hsl(var(--border))',
                          borderRadius: '8px',
                          fontSize: '11px',
                        }}
                        labelStyle={{ color: 'hsl(var(--muted-foreground))' }}
                        itemStyle={{ color: chartColor }}
                        formatter={(value: number | undefined) => [`$${(value ?? 0).toFixed(2)}`, 'P&L']}
                      />
                      <Area
                        type="monotone"
                        dataKey="pnl"
                        stroke={chartColor}
                        strokeWidth={2}
                        fill="url(#strategyPnlGradient)"
                        dot={false}
                        activeDot={{ r: 4, fill: chartColor }}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <div className="h-40 flex items-center justify-center rounded-lg border border-border bg-muted/20">
                  <p className="text-xs text-muted-foreground">No performance data for this range</p>
                </div>
              )}
            </div>

            <Separator />

            {/* Configuration */}
            {params.length > 0 && (
              <div className="flex flex-col gap-3">
                <h4 className="text-sm font-semibold text-foreground">Configuration</h4>
                <div className="flex flex-col divide-y divide-border rounded-lg border border-border overflow-hidden">
                  {params.map((param) => (
                    <div
                      key={param.key}
                      className="flex items-start justify-between gap-3 px-3 py-2.5 bg-muted/20"
                    >
                      <div className="flex flex-col gap-0.5 min-w-0">
                        <span className="text-xs font-medium text-foreground font-mono">
                          {param.key}
                        </span>
                        {param.description && (
                          <span className="text-[10px] text-muted-foreground leading-relaxed">
                            {param.description}
                          </span>
                        )}
                      </div>
                      <span className="text-xs font-mono text-muted-foreground shrink-0">
                        {String(param.value)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Decision reports */}
            {(decisionReports.length > 0 || isLoading) && (
              <>
                <Separator />
                <div className="flex flex-col gap-3">
                  <h4 className="text-sm font-semibold text-foreground">Recent Decisions</h4>
                  {isLoading ? (
                    <div className="flex flex-col gap-2">
                      {[1, 2, 3].map((i) => (
                        <Skeleton key={i} className="h-16 w-full rounded-lg" />
                      ))}
                    </div>
                  ) : (
                    <div className="flex flex-col gap-2">
                      {decisionReports.map((report) => (
                        <DecisionReportCard key={report.id} report={report} />
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
