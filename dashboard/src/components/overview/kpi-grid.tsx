'use client';

import { KpiCard } from './kpi-card';
import { cn } from '@/lib/utils';

function MoneyBagSvg() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="size-[18px]" aria-hidden="true">
      <path d="M12 2C9 2 7 4 8 7H16C17 4 15 2 12 2Z" />
      <path d="M8 7C5 7 3 10 3 13C3 17.4 7 21 12 21C17 21 21 17.4 21 13C21 10 19 7 16 7H8Z" />
      <path d="M9 13H15" />
      <path d="M12 10V16" />
    </svg>
  );
}

function TrendUpSvg() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="size-[18px]" aria-hidden="true">
      <path d="M3 17L9 11L13 15L21 7" />
      <path d="M16 7H21V12" />
    </svg>
  );
}

function ChartBarSvg() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="size-[18px]" aria-hidden="true">
      <path d="M6 20V14" />
      <path d="M10 20V9" />
      <path d="M14 20V12" />
      <path d="M18 20V5" />
      <path d="M3 20H21" />
    </svg>
  );
}

function ActivitySvg() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="size-[18px]" aria-hidden="true">
      <path d="M2 12H6L9 5L12 19L15 9L18 12H22" />
    </svg>
  );
}
import type { UsePortfolioOverviewResult } from '@/hooks/use-portfolio-overview';

interface KpiGridProps {
  data: UsePortfolioOverviewResult['data'];
  isLoading: boolean;
  activeOperations?: number;
  className?: string;
}

export function KpiGrid({ data, isLoading, activeOperations = 0, className }: KpiGridProps) {
  const pnlVariant = data.dailyPnl >= 0 ? 'positive' : 'negative';
  const pnlSign = data.dailyPnl >= 0 ? '+' : '';

  return (
    <div className={cn('grid grid-cols-2 gap-4 lg:grid-cols-4', className)}>
      {/* Portfolio Value */}
      <KpiCard
        label="Portfolio Value"
        value={data.totalValue}
        isLoading={isLoading}
        variant="default"
        prefix="$"
        decimals={2}
        icon={<MoneyBagSvg />}
      />

      {/* 24h P&L */}
      <KpiCard
        label="24h P&L"
        value={data.dailyPnl}
        isLoading={isLoading}
        variant={pnlVariant}
        prefix={`${pnlSign}$`}
        decimals={2}
        icon={<TrendUpSvg />}
        subtext={
          !isLoading && data.dailyPnlPercent !== undefined ? (
            <span className={data.dailyPnlPercent >= 0 ? 'text-positive' : 'text-negative'}>
              {data.dailyPnlPercent >= 0 ? '+' : ''}{data.dailyPnlPercent.toFixed(2)}%
            </span>
          ) : undefined
        }
      />

      {/* Weighted Yield */}
      <KpiCard
        label="Weighted Yield"
        value={data.weightedYield}
        isLoading={isLoading}
        variant="default"
        suffix="%"
        decimals={2}
        icon={<ChartBarSvg />}
        subtext={<span>APY across positions</span>}
      />

      {/* Active Operations */}
      <KpiCard
        label="Active Operations"
        value={activeOperations}
        isLoading={isLoading}
        variant="default"
        decimals={0}
        icon={<ActivitySvg />}
        subtext={<span>in-flight transfers</span>}
      />
    </div>
  );
}
