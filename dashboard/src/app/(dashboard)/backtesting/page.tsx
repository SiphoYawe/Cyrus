'use client';

import { useState, useCallback, useMemo } from 'react';
import { useBacktests, useBacktestDetail, useBacktestComparison } from '@/hooks/use-backtests';
import { BacktestList } from '@/components/backtesting/backtest-list';
import { BacktestDetailSheet } from '@/components/backtesting/backtest-detail-sheet';
import { ComparisonView } from '@/components/backtesting/comparison-view';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

const MAX_COMPARE = 4;

// ── Inline SVG icon ────────────────────────────────────────────────────

function FlaskSvg({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={cn('size-4', className)} aria-hidden="true">
      <path d="M9 3H15" />
      <path d="M10 3V10.5L4.5 19.5C3.9 20.4 4.5 21.5 5.6 21.5H18.4C19.5 21.5 20.1 20.4 19.5 19.5L14 10.5V3" />
      <path d="M8.5 14H15.5" />
    </svg>
  );
}

export default function BacktestingPage() {
  const { backtests, isLoading } = useBacktests();

  // Detail sheet state
  const [selectedBacktestId, setSelectedBacktestId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const { detail, isLoading: detailLoading } = useBacktestDetail(
    detailOpen ? selectedBacktestId : null
  );

  // Comparison state
  const [compareIds, setCompareIds] = useState<Set<string>>(new Set());
  const compareIdArray = useMemo(() => Array.from(compareIds), [compareIds]);
  const { details: compareDetails, isLoading: compareLoading } = useBacktestComparison(
    compareIdArray.length >= 2 ? compareIdArray : []
  );

  const showComparison = compareIds.size >= 2;

  const handleRowClick = useCallback((id: string) => {
    setSelectedBacktestId(id);
    setDetailOpen(true);
  }, []);

  const handleToggleSelect = useCallback((id: string) => {
    setCompareIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else if (next.size < MAX_COMPARE) {
        next.add(id);
      }
      return next;
    });
  }, []);

  const handleClearComparison = useCallback(() => {
    setCompareIds(new Set());
  }, []);

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-center gap-3">
        <FlaskSvg className="text-violet-500" />
        <h2 className="text-xl font-semibold text-foreground">Backtesting</h2>
        {backtests.length > 0 && (
          <Badge
            variant="outline"
            className="h-5 border px-2 text-[10px] font-semibold"
            aria-label={`${backtests.length} backtests`}
          >
            {backtests.length}
          </Badge>
        )}
        {compareIds.size > 0 && compareIds.size < 2 && (
          <span className="text-xs text-muted-foreground ml-auto">
            Select {2 - compareIds.size} more to compare
          </span>
        )}
        {compareIds.size >= 2 && (
          <span className="text-xs text-violet-500 font-medium ml-auto">
            {compareIds.size} selected for comparison
          </span>
        )}
      </div>

      {/* Comparison view (shown when 2+ selected) */}
      {showComparison && (
        <ComparisonView
          details={compareDetails}
          isLoading={compareLoading}
          onClose={handleClearComparison}
        />
      )}

      {/* Backtest list */}
      <BacktestList
        backtests={backtests}
        isLoading={isLoading}
        selectedIds={compareIds}
        onToggleSelect={handleToggleSelect}
        onRowClick={handleRowClick}
      />

      {/* Detail sheet */}
      <BacktestDetailSheet
        detail={detail}
        open={detailOpen}
        onOpenChange={setDetailOpen}
        isLoading={detailLoading}
      />
    </div>
  );
}
