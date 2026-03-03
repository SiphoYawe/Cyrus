'use client';

import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle, CardAction } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { PortfolioDataPoint, TimeRange } from '@/hooks/use-portfolio-history';

interface PortfolioValueChartProps {
  data: PortfolioDataPoint[];
  isLoading: boolean;
  timeRange: TimeRange;
  onTimeRangeChange: (range: TimeRange) => void;
}

const TIME_RANGES: TimeRange[] = ['1D', '1W', '1M'];

interface CustomTooltipProps {
  active?: boolean;
  payload?: Array<{ value: number }>;
  label?: string;
}

function CustomTooltip({ active, payload, label }: CustomTooltipProps) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2 shadow-lg">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="font-mono text-sm font-semibold text-foreground">
        ${payload[0].value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
      </p>
    </div>
  );
}

export function PortfolioValueChart({
  data,
  isLoading,
  timeRange,
  onTimeRangeChange,
}: PortfolioValueChartProps) {
  const hasData = data.length > 0;
  const minValue = hasData ? Math.min(...data.map((d) => d.value)) * 0.995 : 0;
  const maxValue = hasData ? Math.max(...data.map((d) => d.value)) * 1.005 : 1;

  return (
    <Card className="gap-4 py-5">
      <CardHeader className="px-5 py-0">
        <CardTitle className="text-sm font-semibold">Portfolio Value</CardTitle>
        <CardAction>
          <div className="flex items-center gap-1 rounded-lg bg-muted p-1">
            {TIME_RANGES.map((range) => (
              <Button
                key={range}
                variant="ghost"
                size="sm"
                onClick={() => onTimeRangeChange(range)}
                className={cn(
                  'h-6 px-2 text-xs font-medium',
                  timeRange === range
                    ? 'bg-card text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {range}
              </Button>
            ))}
          </div>
        </CardAction>
      </CardHeader>
      <CardContent className="px-5 py-0">
        {isLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : !hasData ? (
          <div className="flex h-40 items-center justify-center">
            <p className="text-xs text-muted-foreground">No history data</p>
          </div>
        ) : (
          <div className="h-40" role="img" aria-label="Portfolio value over time">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart
                data={data}
                margin={{ top: 4, right: 4, left: 0, bottom: 0 }}
              >
                <defs>
                  <linearGradient id="portfolioGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#8B5CF6" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#8B5CF6" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="#27272A"
                  vertical={false}
                />
                <XAxis
                  dataKey="timestamp"
                  tick={{ fontSize: 10, fill: '#71717A' }}
                  axisLine={false}
                  tickLine={false}
                  interval="preserveStartEnd"
                />
                <YAxis
                  domain={[minValue, maxValue]}
                  tick={{ fontSize: 10, fill: '#71717A' }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={(v: number) =>
                    `$${(v / 1000).toFixed(0)}k`
                  }
                  width={40}
                />
                <Tooltip content={<CustomTooltip />} />
                <Area
                  type="monotone"
                  dataKey="value"
                  stroke="#8B5CF6"
                  strokeWidth={2}
                  fill="url(#portfolioGradient)"
                  dot={false}
                  activeDot={{ r: 4, fill: '#8B5CF6', stroke: '#18181B', strokeWidth: 2 }}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
