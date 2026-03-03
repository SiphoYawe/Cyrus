'use client';

import { useState, useEffect, useRef, useCallback, Suspense } from 'react';
import { Button } from '@/components/ui/button';
import { KpiCard } from '@/components/shared/kpi-card';
import { ActivityTabs, type ActivityTab } from '@/components/activity/activity-tabs';
import { ActivityFilters } from '@/components/activity/activity-filters';
import { DecisionReportList } from '@/components/activity/decision-report-list';
import { TransferDetailSheet } from '@/components/activity/transfer-detail-sheet';
import { useActivity } from '@/hooks/use-activity';
import type { ActivityReport, ActivityFilters as Filters, ActivityTransfer } from '@/types/activity';

// KPI icons (inline SVG, no Lucide)
function ActivityIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
    </svg>
  );
}
function SuccessIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <polyline points="22 4 12 14.01 9 11.01" />
    </svg>
  );
}
function GasIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 22V6a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16" />
      <path d="M3 22h14" />
      <path d="M17 4h2a2 2 0 0 1 2 2v4a1 1 0 0 1-1 1h-3" />
      <rect x="7" y="10" width="6" height="6" />
    </svg>
  );
}
function PnlIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="12" y1="20" x2="12" y2="10" />
      <line x1="18" y1="20" x2="18" y2="4" />
      <line x1="6" y1="20" x2="6" y2="16" />
    </svg>
  );
}

function successRateTrend(rate: number): import('@/components/shared/kpi-card').KpiTrend {
  if (rate >= 0.95) return 'positive';
  if (rate >= 0.8) return 'warning';
  return 'negative';
}

function countByType(reports: ActivityReport[]) {
  return {
    all: reports.length,
    trade: reports.filter((r) => r.type === 'trade').length,
    bridge: reports.filter((r) => r.type === 'bridge').length,
    deposit: reports.filter((r) => r.type === 'deposit').length,
  };
}

export default function ActivityPage() {
  const [activeTab, setActiveTab] = useState<ActivityTab>('all');
  const [filters, setFilters] = useState<Filters>({});
  const [selectedTransfer, setSelectedTransfer] = useState<ActivityTransfer | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [newIds, setNewIds] = useState<Set<string>>(new Set());
  const [showNewPill, setShowNewPill] = useState(false);
  const listTopRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLElement | null>(null);
  const prevLengthRef = useRef(0);

  const { reports, stats, isLoading, hasMore, loadMore } = useActivity(filters);

  // Detect new items being prepended
  useEffect(() => {
    if (reports.length > prevLengthRef.current && prevLengthRef.current > 0) {
      const newest = reports[0];
      if (newest) {
        // Defer state updates to avoid cascading renders
        queueMicrotask(() => {
          setNewIds((prev) => new Set([...prev, newest.id]));
          // Show floating pill if user has scrolled down
          const scrollEl = scrollContainerRef.current;
          if (scrollEl && scrollEl.scrollTop > 100) {
            setShowNewPill(true);
          }
        });
        // Remove the "new" class after animation completes
        setTimeout(() => {
          setNewIds((prev) => {
            const next = new Set(prev);
            next.delete(newest.id);
            return next;
          });
        }, 1000);
      }
    }
    prevLengthRef.current = reports.length;
  }, [reports]);

  // Track scroll container to detect if user scrolled down
  useEffect(() => {
    // The main element in the layout has overflow-y-auto
    const main = document.querySelector('main');
    if (main) {
      scrollContainerRef.current = main as HTMLElement;
      const handleScroll = () => {
        if (main.scrollTop < 50) {
          setShowNewPill(false);
        }
      };
      main.addEventListener('scroll', handleScroll, { passive: true });
      return () => main.removeEventListener('scroll', handleScroll);
    }
  }, []);

  const scrollToTop = useCallback(() => {
    scrollContainerRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
    setShowNewPill(false);
  }, []);

  const handleViewTransfer = useCallback((report: ActivityReport) => {
    if (report.transfer) {
      setSelectedTransfer(report.transfer);
      setSheetOpen(true);
    }
  }, []);

  const tabCounts = countByType(reports);

  return (
    <div className="space-y-6" ref={listTopRef}>
      {/* Page header */}
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-foreground">Activity</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Full log of autonomous decisions and cross-chain operations.
        </p>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4" data-testid="kpi-cards">
        <KpiCard
          title="Total Operations"
          value={stats.totalOperations}
          format="number"
          icon={<ActivityIcon />}
          isLoading={isLoading && reports.length === 0}
          data-testid="kpi-total-operations"
        />
        <KpiCard
          title="Success Rate"
          value={stats.successRate * 100}
          format="percent"
          trend={successRateTrend(stats.successRate)}
          icon={<SuccessIcon />}
          subtitle={`${stats.successCount} of ${stats.totalOperations} succeeded`}
          isLoading={isLoading && reports.length === 0}
          data-testid="kpi-success-rate"
        />
        <KpiCard
          title="Total Gas Spent"
          value={stats.totalGasUsd}
          format="usd"
          icon={<GasIcon />}
          isLoading={isLoading && reports.length === 0}
          data-testid="kpi-gas-spent"
        />
        <KpiCard
          title="Net P&L"
          value={stats.netPnlUsd}
          format="usd"
          trend={stats.netPnlUsd >= 0 ? 'positive' : 'negative'}
          icon={<PnlIcon />}
          isLoading={isLoading && reports.length === 0}
          data-testid="kpi-net-pnl"
        />
      </div>

      {/* Tabs + Filters row */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <ActivityTabs
          activeTab={activeTab}
          onTabChange={setActiveTab}
          counts={tabCounts}
        />
        <Suspense fallback={null}>
          <ActivityFilters onChange={setFilters} />
        </Suspense>
      </div>

      {/* Report list */}
      <DecisionReportList
        reports={reports}
        activeTab={activeTab}
        newIds={newIds}
        isLoading={isLoading}
        hasMore={hasMore}
        onLoadMore={loadMore}
        onViewTransfer={handleViewTransfer}
      />

      {/* Transfer detail sheet */}
      <TransferDetailSheet
        transfer={selectedTransfer}
        open={sheetOpen}
        onOpenChange={setSheetOpen}
      />

      {/* Floating "new activity" pill */}
      {showNewPill && (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2">
          <Button
            size="sm"
            className="h-8 gap-1.5 rounded-full px-4 text-xs shadow-lg"
            onClick={scrollToTop}
            data-testid="new-activity-pill"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <polyline points="18 15 12 9 6 15" />
            </svg>
            New activity
          </Button>
        </div>
      )}
    </div>
  );
}
