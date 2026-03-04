'use client';

import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import type { DrawdownPoint } from '@/hooks/use-backtests';

interface DrawdownChartProps {
  data: DrawdownPoint[];
  height?: number;
}

const DRAWDOWN_COLOR = '#EF4444'; // red-500

export function DrawdownChart({ data, height = 160 }: DrawdownChartProps) {
  if (data.length === 0) {
    return (
      <div
        className="flex items-center justify-center rounded-lg border border-border bg-muted/20"
        style={{ height }}
      >
        <p className="text-xs text-muted-foreground">No drawdown data available</p>
      </div>
    );
  }

  const values = data.map((d) => d.drawdown);
  const minVal = Math.min(...values);
  const padding = Math.abs(minVal) * 0.1 || 1;

  return (
    <div style={{ height }} aria-label="Drawdown chart">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="drawdownGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={DRAWDOWN_COLOR} stopOpacity={0.3} />
              <stop offset="95%" stopColor={DRAWDOWN_COLOR} stopOpacity={0.02} />
            </linearGradient>
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
            domain={[minVal - padding, 0]}
            tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v: number) => `${v.toFixed(1)}%`}
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
            itemStyle={{ color: DRAWDOWN_COLOR }}
            formatter={(value: number | undefined) => [
              `${(value ?? 0).toFixed(2)}%`,
              'Drawdown',
            ]}
          />
          <Area
            type="monotone"
            dataKey="drawdown"
            stroke={DRAWDOWN_COLOR}
            strokeWidth={2}
            fill="url(#drawdownGradient)"
            dot={false}
            activeDot={{ r: 4, fill: DRAWDOWN_COLOR }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
