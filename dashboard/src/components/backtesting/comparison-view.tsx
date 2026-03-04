'use client';

import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import type { BacktestDetail } from '@/hooks/use-backtests';

// ── Color palette for comparison lines ─────────────────────────────────

const COMPARISON_COLORS = ['#8B5CF6', '#3B82F6', '#F59E0B', '#10B981'] as const;

// ── Inline SVG icons ───────────────────────────────────────────────────

function CompareSvg({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={cn('size-10', className)} aria-hidden="true">
      <path d="M3 12H7L10 4L14 20L17 12H21" />
    </svg>
  );
}

// ── Merge equity curves into a single dataset ──────────────────────────

interface MergedPoint {
  date: string;
  [key: string]: number | string;
}

function mergeEquityCurves(details: BacktestDetail[]): MergedPoint[] {
  const dateSet = new Set<string>();
  for (const d of details) {
    for (const pt of d.equityCurve) {
      dateSet.add(pt.date);
    }
  }

  const dates = Array.from(dateSet).sort();

  return dates.map((date) => {
    const point: MergedPoint = { date };
    for (const d of details) {
      const match = d.equityCurve.find((p) => p.date === date);
      point[d.id] = match?.value ?? 0;
    }
    return point;
  });
}

// ── Parameter diff table ───────────────────────────────────────────────

function getParamKeys(details: BacktestDetail[]): string[] {
  const keys = new Set<string>();
  for (const d of details) {
    for (const k of Object.keys(d.params)) {
      keys.add(k);
    }
  }
  return Array.from(keys).sort();
}

// ── Metric rows for summary comparison ─────────────────────────────────

interface MetricRow {
  label: string;
  accessor: (d: BacktestDetail) => string;
}

const METRIC_ROWS: MetricRow[] = [
  { label: 'Return', accessor: (d) => `${d.totalReturn >= 0 ? '+' : ''}${d.totalReturn.toFixed(2)}%` },
  { label: 'Sharpe', accessor: (d) => d.sharpe.toFixed(2) },
  { label: 'Sortino', accessor: (d) => d.sortino.toFixed(2) },
  { label: 'Max DD', accessor: (d) => `${d.maxDrawdown.toFixed(2)}%` },
  { label: 'Win Rate', accessor: (d) => `${d.winRate.toFixed(1)}%` },
  { label: 'Avg P&L', accessor: (d) => `$${d.avgTradePnl.toFixed(2)}` },
  { label: 'Trades', accessor: (d) => String(d.totalTrades) },
];

// ── Component ──────────────────────────────────────────────────────────

interface ComparisonViewProps {
  details: BacktestDetail[];
  isLoading: boolean;
  onClose: () => void;
}

export function ComparisonView({
  details,
  isLoading,
  onClose,
}: ComparisonViewProps) {
  if (isLoading) {
    return (
      <div className="space-y-4" data-testid="comparison-loading">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-64 w-full rounded-lg" />
        <Skeleton className="h-48 w-full rounded-lg" />
      </div>
    );
  }

  if (details.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border bg-muted/10 px-6 py-16">
        <CompareSvg className="text-muted-foreground/50" />
        <h3 className="text-sm font-semibold text-foreground">No backtests selected</h3>
        <p className="max-w-sm text-center text-xs text-muted-foreground">
          Select up to 4 backtests from the list to compare their equity curves and parameters.
        </p>
      </div>
    );
  }

  const mergedData = mergeEquityCurves(details);
  const paramKeys = getParamKeys(details);

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-bold text-foreground">
          Comparing {details.length} Backtests
        </h3>
        <button
          type="button"
          onClick={onClose}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors underline underline-offset-2"
        >
          Clear comparison
        </button>
      </div>

      {/* Overlaid equity curves */}
      <div className="flex flex-col gap-2">
        <h4 className="text-sm font-semibold text-foreground">Equity Curves</h4>
        <div className="h-72 w-full" aria-label="Comparison equity curves">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={mergedData} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
              <defs>
                {details.map((d, i) => (
                  <linearGradient
                    key={d.id}
                    id={`compareGrad-${d.id}`}
                    x1="0"
                    y1="0"
                    x2="0"
                    y2="1"
                  >
                    <stop
                      offset="5%"
                      stopColor={COMPARISON_COLORS[i % COMPARISON_COLORS.length]}
                      stopOpacity={0.15}
                    />
                    <stop
                      offset="95%"
                      stopColor={COMPARISON_COLORS[i % COMPARISON_COLORS.length]}
                      stopOpacity={0.02}
                    />
                  </linearGradient>
                ))}
              </defs>
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="hsl(var(--border))"
                opacity={0.5}
              />
              <XAxis
                dataKey="date"
                tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                tickLine={false}
                axisLine={false}
                interval="preserveStartEnd"
              />
              <YAxis
                tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                tickLine={false}
                axisLine={false}
                tickFormatter={(v: number) => `$${v.toFixed(0)}`}
                width={52}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: 'hsl(var(--popover))',
                  border: '1px solid hsl(var(--border))',
                  borderRadius: '8px',
                  fontSize: '11px',
                }}
                labelStyle={{ color: 'hsl(var(--muted-foreground))' }}
              />
              <Legend
                verticalAlign="top"
                height={30}
                wrapperStyle={{ fontSize: '11px' }}
              />
              {details.map((d, i) => (
                <Area
                  key={d.id}
                  type="monotone"
                  dataKey={d.id}
                  name={d.strategy}
                  stroke={COMPARISON_COLORS[i % COMPARISON_COLORS.length]}
                  strokeWidth={2}
                  fill={`url(#compareGrad-${d.id})`}
                  dot={false}
                  activeDot={{ r: 3 }}
                />
              ))}
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Metrics comparison table */}
      <div className="flex flex-col gap-2">
        <h4 className="text-sm font-semibold text-foreground">Metrics</h4>
        <div className="rounded-xl border border-border overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="text-xs">Metric</TableHead>
                {details.map((d, i) => (
                  <TableHead key={d.id} className="text-right text-xs">
                    <span
                      className="inline-flex items-center gap-1.5"
                    >
                      <span
                        className="size-2 rounded-full inline-block"
                        style={{ backgroundColor: COMPARISON_COLORS[i % COMPARISON_COLORS.length] }}
                      />
                      {d.strategy}
                    </span>
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {METRIC_ROWS.map((row) => (
                <TableRow key={row.label}>
                  <TableCell className="text-xs font-medium text-muted-foreground">
                    {row.label}
                  </TableCell>
                  {details.map((d) => (
                    <TableCell key={d.id} className="text-right font-mono text-xs">
                      {row.accessor(d)}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* Parameter diff table */}
      {paramKeys.length > 0 && (
        <div className="flex flex-col gap-2">
          <h4 className="text-sm font-semibold text-foreground">Parameter Differences</h4>
          <div className="rounded-xl border border-border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="text-xs">Parameter</TableHead>
                  {details.map((d, i) => (
                    <TableHead key={d.id} className="text-right text-xs">
                      <span className="inline-flex items-center gap-1.5">
                        <span
                          className="size-2 rounded-full inline-block"
                          style={{ backgroundColor: COMPARISON_COLORS[i % COMPARISON_COLORS.length] }}
                        />
                        {d.strategy}
                      </span>
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {paramKeys.map((key) => {
                  const values = details.map((d) => String(d.params[key] ?? '-'));
                  const allSame = values.every((v) => v === values[0]);

                  return (
                    <TableRow key={key} className={cn(!allSame && 'bg-violet-500/5')}>
                      <TableCell className="text-xs font-medium font-mono text-muted-foreground">
                        {key}
                      </TableCell>
                      {details.map((d) => (
                        <TableCell
                          key={d.id}
                          className={cn(
                            'text-right font-mono text-xs',
                            !allSame && 'text-foreground font-semibold'
                          )}
                        >
                          {String(d.params[key] ?? '-')}
                        </TableCell>
                      ))}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </div>
      )}
    </div>
  );
}
