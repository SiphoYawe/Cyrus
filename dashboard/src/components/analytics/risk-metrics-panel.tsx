'use client';

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import type { RiskMetrics } from '@/hooks/use-analytics-data';

interface RiskMetricsPanelProps {
  data: RiskMetrics;
  className?: string;
}

interface MetricItem {
  label: string;
  value: string;
  description: string;
  variant: 'default' | 'positive' | 'negative' | 'warning';
}

function formatRatio(value: number): string {
  return value === Infinity ? '\u221E' : value.toFixed(2);
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatUsd(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
}

function getRatioVariant(value: number): MetricItem['variant'] {
  if (value > 2) return 'positive';
  if (value > 1) return 'default';
  if (value > 0) return 'warning';
  return 'negative';
}

function getDrawdownVariant(value: number): MetricItem['variant'] {
  if (value < 0.05) return 'positive';
  if (value < 0.15) return 'default';
  if (value < 0.25) return 'warning';
  return 'negative';
}

const VARIANT_COLORS: Record<MetricItem['variant'], string> = {
  default: 'text-foreground',
  positive: 'text-positive',
  negative: 'text-negative',
  warning: 'text-warning',
};

const VARIANT_BG: Record<MetricItem['variant'], string> = {
  default: 'bg-secondary',
  positive: 'bg-positive-muted',
  negative: 'bg-negative-muted',
  warning: 'bg-warning-muted',
};

function buildMetrics(data: RiskMetrics): MetricItem[] {
  return [
    {
      label: 'Sharpe Ratio',
      value: formatRatio(data.sharpeRatio),
      description: 'Risk-adjusted return (mean / std dev)',
      variant: getRatioVariant(data.sharpeRatio),
    },
    {
      label: 'Sortino Ratio',
      value: formatRatio(data.sortinoRatio),
      description: 'Downside risk-adjusted return',
      variant: getRatioVariant(data.sortinoRatio),
    },
    {
      label: 'Max Drawdown',
      value: formatPercent(data.maxDrawdown),
      description: 'Largest peak-to-trough decline',
      variant: getDrawdownVariant(data.maxDrawdown),
    },
    {
      label: 'VaR (95%)',
      value: formatUsd(data.var95),
      description: '95% confidence daily loss limit',
      variant: data.var95 > 5000 ? 'warning' : 'default',
    },
    {
      label: 'VaR (99%)',
      value: formatUsd(data.var99),
      description: '99% confidence daily loss limit',
      variant: data.var99 > 10000 ? 'negative' : data.var99 > 5000 ? 'warning' : 'default',
    },
    {
      label: 'Annualized Return',
      value: formatPercent(data.annualizedReturn),
      description: 'Projected yearly return',
      variant: data.annualizedReturn > 0 ? 'positive' : 'negative',
    },
    {
      label: 'Annualized Vol',
      value: formatPercent(data.annualizedVolatility),
      description: 'Yearly return standard deviation',
      variant: data.annualizedVolatility > 0.3 ? 'warning' : 'default',
    },
    {
      label: 'Calmar Ratio',
      value: formatRatio(data.calmarRatio),
      description: 'Return / max drawdown',
      variant: getRatioVariant(data.calmarRatio),
    },
    {
      label: 'Win Rate',
      value: formatPercent(data.winRate),
      description: 'Percentage of profitable trades',
      variant: data.winRate > 0.55 ? 'positive' : data.winRate > 0.45 ? 'default' : 'negative',
    },
    {
      label: 'Profit Factor',
      value: formatRatio(data.profitFactor),
      description: 'Gross profit / gross loss',
      variant: getRatioVariant(data.profitFactor),
    },
  ];
}

export function RiskMetricsPanel({ data, className }: RiskMetricsPanelProps) {
  const metrics = buildMetrics(data);

  return (
    <Card className={cn('border-border bg-card', className)}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z" />
            <path d="M12 8v4" />
            <path d="M12 16h.01" />
          </svg>
          Risk Metrics
        </CardTitle>
        <CardDescription>
          Portfolio risk analysis and performance ratios
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div
          data-testid="risk-metrics-panel"
          className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5"
        >
          {metrics.map((metric) => (
            <div
              key={metric.label}
              className={cn(
                'rounded-lg p-3 transition-colors',
                VARIANT_BG[metric.variant]
              )}
            >
              <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                {metric.label}
              </p>
              <p
                className={cn(
                  'mt-1 font-mono text-xl font-bold tabular-nums',
                  VARIANT_COLORS[metric.variant]
                )}
              >
                {metric.value}
              </p>
              <p className="mt-0.5 text-[10px] text-muted-foreground leading-tight">
                {metric.description}
              </p>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
