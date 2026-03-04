'use client';

import { useState, useCallback, useMemo } from 'react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import type { BacktestSummary, SortField, SortDirection } from '@/hooks/use-backtests';

// ── Inline SVG icons ───────────────────────────────────────────────────

function ChevronUpSvg({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={cn('size-3 shrink-0', className)} aria-hidden="true">
      <path d="M18 15L12 9L6 15" />
    </svg>
  );
}

function ChevronDownSvg({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={cn('size-3 shrink-0', className)} aria-hidden="true">
      <path d="M6 9L12 15L18 9" />
    </svg>
  );
}

function FlaskSvg({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={cn('size-10', className)} aria-hidden="true">
      <path d="M9 3H15" />
      <path d="M10 3V10.5L4.5 19.5C3.9 20.4 4.5 21.5 5.6 21.5H18.4C19.5 21.5 20.1 20.4 19.5 19.5L14 10.5V3" />
      <path d="M8.5 14H15.5" />
    </svg>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
}

function formatPct(value: number): string {
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(1)}%`;
}

function pctColor(value: number): string {
  if (value > 0) return 'text-positive';
  if (value < 0) return 'text-negative';
  return 'text-muted-foreground';
}

function sortBacktests(
  backtests: BacktestSummary[],
  field: SortField,
  direction: SortDirection
): BacktestSummary[] {
  return [...backtests].sort((a, b) => {
    let cmp = 0;
    switch (field) {
      case 'strategy':
        cmp = a.strategy.localeCompare(b.strategy);
        break;
      case 'createdAt':
        cmp = a.createdAt - b.createdAt;
        break;
      case 'sharpe':
        cmp = a.sharpe - b.sharpe;
        break;
      case 'totalReturn':
        cmp = a.totalReturn - b.totalReturn;
        break;
      case 'maxDrawdown':
        cmp = a.maxDrawdown - b.maxDrawdown;
        break;
      case 'winRate':
        cmp = a.winRate - b.winRate;
        break;
    }
    return direction === 'asc' ? cmp : -cmp;
  });
}

// ── Component ──────────────────────────────────────────────────────────

const MAX_COMPARE = 4;

interface BacktestListProps {
  backtests: BacktestSummary[];
  isLoading: boolean;
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onRowClick: (id: string) => void;
}

export function BacktestList({
  backtests,
  isLoading,
  selectedIds,
  onToggleSelect,
  onRowClick,
}: BacktestListProps) {
  const [sortField, setSortField] = useState<SortField>('createdAt');
  const [sortDir, setSortDir] = useState<SortDirection>('desc');

  const handleSort = useCallback(
    (field: SortField) => {
      if (sortField === field) {
        setSortDir((prev) => (prev === 'asc' ? 'desc' : 'asc'));
      } else {
        setSortField(field);
        setSortDir('desc');
      }
    },
    [sortField]
  );

  const sorted = useMemo(
    () => sortBacktests(backtests, sortField, sortDir),
    [backtests, sortField, sortDir]
  );

  const renderSortIcon = (field: SortField) => {
    if (sortField !== field) return null;
    return sortDir === 'asc' ? (
      <ChevronUpSvg className="ml-0.5 inline" />
    ) : (
      <ChevronDownSvg className="ml-0.5 inline" />
    );
  };

  // Loading skeleton
  if (isLoading) {
    return (
      <div className="space-y-2" data-testid="backtest-loading">
        {[1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-12 w-full rounded-lg" />
        ))}
      </div>
    );
  }

  // Empty state
  if (backtests.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border bg-muted/10 px-6 py-16">
        <FlaskSvg className="text-muted-foreground/50" />
        <h3 className="text-sm font-semibold text-foreground">No backtests yet</h3>
        <p className="max-w-sm text-center text-xs text-muted-foreground">
          Run a backtest from the agent CLI to see results here. Completed backtests will appear automatically.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="w-10">
              <span className="sr-only">Select</span>
            </TableHead>
            <TableHead>
              <button
                type="button"
                onClick={() => handleSort('strategy')}
                className="flex items-center gap-0.5 text-xs font-medium hover:text-foreground transition-colors"
              >
                Strategy
                {renderSortIcon('strategy')}
              </button>
            </TableHead>
            <TableHead>
              <button
                type="button"
                onClick={() => handleSort('createdAt')}
                className="flex items-center gap-0.5 text-xs font-medium hover:text-foreground transition-colors"
              >
                Date Range
                {renderSortIcon('createdAt')}
              </button>
            </TableHead>
            <TableHead className="text-right">
              <button
                type="button"
                onClick={() => handleSort('sharpe')}
                className="ml-auto flex items-center gap-0.5 text-xs font-medium hover:text-foreground transition-colors"
              >
                Sharpe
                {renderSortIcon('sharpe')}
              </button>
            </TableHead>
            <TableHead className="text-right">
              <button
                type="button"
                onClick={() => handleSort('totalReturn')}
                className="ml-auto flex items-center gap-0.5 text-xs font-medium hover:text-foreground transition-colors"
              >
                Return
                {renderSortIcon('totalReturn')}
              </button>
            </TableHead>
            <TableHead className="text-right">
              <button
                type="button"
                onClick={() => handleSort('maxDrawdown')}
                className="ml-auto flex items-center gap-0.5 text-xs font-medium hover:text-foreground transition-colors"
              >
                Max DD
                {renderSortIcon('maxDrawdown')}
              </button>
            </TableHead>
            <TableHead className="text-right">
              <button
                type="button"
                onClick={() => handleSort('winRate')}
                className="ml-auto flex items-center gap-0.5 text-xs font-medium hover:text-foreground transition-colors"
              >
                Win Rate
                {renderSortIcon('winRate')}
              </button>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.map((bt) => {
            const isSelected = selectedIds.has(bt.id);
            const isMaxReached = selectedIds.size >= MAX_COMPARE && !isSelected;

            return (
              <TableRow
                key={bt.id}
                className={cn(
                  'cursor-pointer transition-colors',
                  isSelected && 'bg-violet-500/5'
                )}
                onClick={() => onRowClick(bt.id)}
                data-testid={`backtest-row-${bt.id}`}
              >
                <TableCell>
                  <input
                    type="checkbox"
                    checked={isSelected}
                    disabled={isMaxReached}
                    onChange={(e) => {
                      e.stopPropagation();
                      onToggleSelect(bt.id);
                    }}
                    onClick={(e) => e.stopPropagation()}
                    className={cn(
                      'size-4 rounded border-border accent-violet-500',
                      isMaxReached && 'opacity-30 cursor-not-allowed'
                    )}
                    aria-label={`Select ${bt.strategy} backtest for comparison`}
                  />
                </TableCell>
                <TableCell>
                  <span className="text-sm font-semibold text-foreground">{bt.strategy}</span>
                </TableCell>
                <TableCell>
                  <span className="text-xs text-muted-foreground font-mono">
                    {formatDate(bt.dateFrom)} - {formatDate(bt.dateTo)}
                  </span>
                </TableCell>
                <TableCell className="text-right">
                  <span className={cn('font-mono text-sm', pctColor(bt.sharpe))}>
                    {bt.sharpe.toFixed(2)}
                  </span>
                </TableCell>
                <TableCell className="text-right">
                  <Badge
                    variant="outline"
                    className={cn(
                      'h-5 border px-2 text-[10px] font-semibold font-mono',
                      bt.totalReturn >= 0
                        ? 'bg-green-500/10 text-green-500 border-green-500/30'
                        : 'bg-red-500/10 text-red-500 border-red-500/30'
                    )}
                  >
                    {formatPct(bt.totalReturn)}
                  </Badge>
                </TableCell>
                <TableCell className="text-right">
                  <span className="font-mono text-sm text-negative">
                    {bt.maxDrawdown.toFixed(1)}%
                  </span>
                </TableCell>
                <TableCell className="text-right">
                  <span className={cn('font-mono text-sm', pctColor(bt.winRate - 50))}>
                    {bt.winRate.toFixed(1)}%
                  </span>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
