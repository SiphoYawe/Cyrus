'use client';

import { useState, useCallback } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/shared/empty-state';
import { StrategyCard } from '@/components/strategies/strategy-card';
import { StrategyDetailSheet, ChartLineDataSvg } from '@/components/strategies/strategy-detail-sheet';
import { useStrategies } from '@/hooks/use-strategies';
import { useStrategyDetail } from '@/hooks/use-strategy-detail';
import { useStrategiesStore } from '@/stores/strategies-store';
import { useWebSocket } from '@/providers/ws-provider';
import { WS_COMMANDS } from '@/types/ws';
import type { Strategy } from '@/stores/strategies-store';

export default function StrategiesPage() {
  const { strategies, isLoading } = useStrategies();
  const { toggleStrategy } = useStrategiesStore();
  const { send } = useWebSocket();

  const [selectedStrategy, setSelectedStrategy] = useState<Strategy | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [pendingToggles, setPendingToggles] = useState<Set<string>>(new Set());

  const {
    filteredHistory,
    decisionReports,
    isLoading: detailLoading,
    timeRange,
    setTimeRange,
  } = useStrategyDetail(selectedStrategy?.name ?? null);

  const handleCardClick = useCallback((strategy: Strategy) => {
    setSelectedStrategy(strategy);
    setSheetOpen(true);
  }, []);

  const handleToggle = useCallback(
    (name: string, enabled: boolean) => {
      // Optimistic update
      toggleStrategy(name, enabled);

      // Mark as pending
      setPendingToggles((prev) => new Set(prev).add(name));

      // Send WS command
      send({
        command: WS_COMMANDS.STRATEGY_TOGGLE,
        payload: { strategy: name, enabled },
      });

      // Show success toast immediately (optimistic)
      toast.success(`Strategy ${name} ${enabled ? 'enabled' : 'disabled'}`);

      // Remove from pending after a short window
      // In real usage, we'd listen for command.response to confirm
      setTimeout(() => {
        setPendingToggles((prev) => {
          const next = new Set(prev);
          next.delete(name);
          return next;
        });
      }, 2000);
    },
    [send, toggleStrategy]
  );

  const handleSheetToggle = useCallback(
    (name: string, enabled: boolean) => {
      handleToggle(name, enabled);
      // Keep sheet open and update selectedStrategy optimistically
      if (selectedStrategy?.name === name) {
        setSelectedStrategy((prev) =>
          prev ? { ...prev, enabled } : prev
        );
      }
    },
    [handleToggle, selectedStrategy]
  );

  const handleSheetOpenChange = useCallback((open: boolean) => {
    setSheetOpen(open);
    if (!open) {
      setSelectedStrategy(null);
    }
  }, []);

  // Sync selectedStrategy with store when it changes
  const selectedFromStore = selectedStrategy
    ? strategies.find((s) => s.name === selectedStrategy.name) ?? selectedStrategy
    : null;

  // Merge decisionReports from detail hook (filtered by strategy)
  const filteredReports = (decisionReports ?? []).filter(
    (r) => !selectedStrategy || r.strategy === selectedStrategy.name
  );

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h2 className="text-xl font-semibold">Strategies</h2>
            <Skeleton className="h-5 w-12 rounded-full" />
          </div>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-52 w-full rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h2 className="text-xl font-semibold">Strategies</h2>
          <Badge
            variant="secondary"
            className="h-5 px-2 text-[10px] font-semibold font-mono"
            aria-label={`${strategies.length} strategies loaded`}
          >
            {strategies.length}
          </Badge>
        </div>
      </div>

      {strategies.length === 0 ? (
        <EmptyState
          icon={<ChartLineDataSvg />}
          message="No strategies loaded"
          description="Drop a strategy class extending CrossChainStrategy into the strategies directory to get started."
          action={
            <a
              href="https://docs.cyrus.agent/strategies"
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-primary underline underline-offset-4 hover:text-primary/80 transition-colors"
            >
              Read strategy documentation
            </a>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {strategies.map((strategy) => (
            <StrategyCard
              key={strategy.name}
              strategy={strategy}
              onToggle={handleToggle}
              togglePending={pendingToggles.has(strategy.name)}
              onClick={handleCardClick}
            />
          ))}
        </div>
      )}

      {/* Strategy detail sheet */}
      <StrategyDetailSheet
        strategy={selectedFromStore}
        open={sheetOpen}
        onOpenChange={handleSheetOpenChange}
        onToggle={handleSheetToggle}
        togglePending={
          selectedStrategy ? pendingToggles.has(selectedStrategy.name) : false
        }
        performanceHistory={filteredHistory}
        decisionReports={filteredReports}
        isLoading={detailLoading}
        timeRange={timeRange}
        onTimeRangeChange={setTimeRange}
      />
    </div>
  );
}
