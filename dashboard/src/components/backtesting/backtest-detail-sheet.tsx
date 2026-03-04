'use client';

import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import type { BacktestDetail } from '@/hooks/use-backtests';
import { EquityCurveChart } from './equity-curve-chart';
import { DrawdownChart } from './drawdown-chart';
import { TradeHistogram } from './trade-histogram';

// ── Inline SVG icons ───────────────────────────────────────────────────

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

function TargetSvg({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={cn('size-3 shrink-0', className)} aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="5" />
      <circle cx="12" cy="12" r="1" />
    </svg>
  );
}

function CalendarSvg({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={cn('size-3 shrink-0', className)} aria-hidden="true">
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M16 2V6" />
      <path d="M8 2V6" />
      <path d="M3 10H21" />
    </svg>
  );
}

// ── Stat card ──────────────────────────────────────────────────────────

interface StatCardProps {
  label: string;
  value: string;
  icon: React.ReactNode;
  valueClassName?: string;
}

function StatCard({ label, value, icon, valueClassName }: StatCardProps) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border border-border bg-muted/30 p-3">
      <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground flex items-center gap-1">
        {icon}
        {label}
      </span>
      <span className={cn('font-mono text-sm font-semibold', valueClassName ?? 'text-foreground')}>
        {value}
      </span>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────

interface BacktestDetailSheetProps {
  detail: BacktestDetail | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isLoading: boolean;
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function formatPct(value: number): string {
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
}

export function BacktestDetailSheet({
  detail,
  open,
  onOpenChange,
  isLoading,
}: BacktestDetailSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-[480px] sm:max-w-[480px] p-0 flex flex-col"
        aria-label={detail ? `${detail.strategy} backtest details` : 'Backtest details'}
      >
        {isLoading ? (
          <div className="flex flex-col gap-4 p-6">
            <Skeleton className="h-6 w-48" />
            <Skeleton className="h-4 w-32" />
            <div className="grid grid-cols-2 gap-3">
              {[1, 2, 3, 4].map((i) => (
                <Skeleton key={i} className="h-16 rounded-lg" />
              ))}
            </div>
            <Skeleton className="h-48 rounded-lg" />
            <Skeleton className="h-36 rounded-lg" />
          </div>
        ) : detail ? (
          <>
            {/* Header */}
            <SheetHeader className="border-b border-border px-6 py-4 shrink-0">
              <div className="flex flex-col gap-2 pr-8">
                <SheetTitle className="text-lg font-bold leading-tight">
                  {detail.strategy}
                </SheetTitle>
                <SheetDescription className="flex items-center gap-1.5 text-xs">
                  <CalendarSvg />
                  {formatDate(detail.dateFrom)} - {formatDate(detail.dateTo)}
                </SheetDescription>
              </div>
            </SheetHeader>

            <ScrollArea className="flex-1">
              <div className="flex flex-col gap-6 px-6 py-4">
                {/* Summary stats */}
                <div className="grid grid-cols-2 gap-3">
                  <StatCard
                    label="Total Return"
                    value={formatPct(detail.totalReturn)}
                    icon={detail.totalReturn >= 0 ? <TrendUpSvg /> : <TrendDownSvg />}
                    valueClassName={detail.totalReturn >= 0 ? 'text-positive' : 'text-negative'}
                  />
                  <StatCard
                    label="Sharpe Ratio"
                    value={detail.sharpe.toFixed(2)}
                    icon={<ChartLineSvg />}
                    valueClassName={detail.sharpe >= 1 ? 'text-positive' : detail.sharpe >= 0 ? 'text-warning' : 'text-negative'}
                  />
                  <StatCard
                    label="Sortino Ratio"
                    value={detail.sortino.toFixed(2)}
                    icon={<TargetSvg />}
                    valueClassName={detail.sortino >= 1 ? 'text-positive' : detail.sortino >= 0 ? 'text-warning' : 'text-negative'}
                  />
                  <StatCard
                    label="Max Drawdown"
                    value={`${detail.maxDrawdown.toFixed(2)}%`}
                    icon={<TrendDownSvg />}
                    valueClassName="text-negative"
                  />
                  <StatCard
                    label="Win Rate"
                    value={`${detail.winRate.toFixed(1)}%`}
                    icon={<TargetSvg />}
                    valueClassName={detail.winRate >= 60 ? 'text-positive' : detail.winRate >= 50 ? 'text-warning' : 'text-negative'}
                  />
                  <StatCard
                    label="Avg Trade P&L"
                    value={`$${detail.avgTradePnl.toFixed(2)}`}
                    icon={<BarChartSvg />}
                    valueClassName={detail.avgTradePnl >= 0 ? 'text-positive' : 'text-negative'}
                  />
                  <StatCard
                    label="Total Trades"
                    value={String(detail.totalTrades)}
                    icon={<BarChartSvg />}
                  />
                </div>

                <Separator />

                {/* Equity curve */}
                <div className="flex flex-col gap-2">
                  <h4 className="text-sm font-semibold text-foreground">Equity Curve</h4>
                  <EquityCurveChart data={detail.equityCurve} height={180} />
                </div>

                <Separator />

                {/* Drawdown */}
                <div className="flex flex-col gap-2">
                  <h4 className="text-sm font-semibold text-foreground">Drawdown</h4>
                  <DrawdownChart data={detail.drawdownCurve} height={140} />
                </div>

                <Separator />

                {/* Trade distribution */}
                <div className="flex flex-col gap-2">
                  <h4 className="text-sm font-semibold text-foreground">Trade P&L Distribution</h4>
                  <TradeHistogram data={detail.tradeDistribution} height={140} />
                </div>

                {/* Parameters */}
                {Object.keys(detail.params).length > 0 && (
                  <>
                    <Separator />
                    <div className="flex flex-col gap-3">
                      <h4 className="text-sm font-semibold text-foreground">Parameters</h4>
                      <div className="flex flex-col divide-y divide-border rounded-lg border border-border overflow-hidden">
                        {Object.entries(detail.params).map(([key, value]) => (
                          <div
                            key={key}
                            className="flex items-center justify-between gap-3 px-3 py-2.5 bg-muted/20"
                          >
                            <span className="text-xs font-medium text-foreground font-mono">
                              {key}
                            </span>
                            <span className="text-xs font-mono text-muted-foreground">
                              {String(value)}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </>
                )}
              </div>
            </ScrollArea>
          </>
        ) : (
          <div className="flex items-center justify-center flex-1">
            <p className="text-sm text-muted-foreground">Select a backtest to view details</p>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
