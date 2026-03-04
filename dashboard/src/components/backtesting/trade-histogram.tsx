'use client';

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from 'recharts';
import type { TradeHistogramBin } from '@/hooks/use-backtests';

interface TradeHistogramProps {
  data: TradeHistogramBin[];
  height?: number;
}

const POSITIVE_COLOR = '#22C55E'; // green-500
const NEGATIVE_COLOR = '#EF4444'; // red-500

export function TradeHistogram({ data, height = 160 }: TradeHistogramProps) {
  if (data.length === 0) {
    return (
      <div
        className="flex items-center justify-center rounded-lg border border-border bg-muted/20"
        style={{ height }}
      >
        <p className="text-xs text-muted-foreground">No trade data available</p>
      </div>
    );
  }

  return (
    <div style={{ height }} aria-label="Trade P&L distribution">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="hsl(var(--border))"
            opacity={0.5}
          />
          <XAxis
            dataKey="range"
            tick={{ fontSize: 9, fill: 'hsl(var(--muted-foreground))' }}
            tickLine={false}
            axisLine={false}
            interval={0}
            angle={-30}
            textAnchor="end"
            height={40}
          />
          <YAxis
            tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
            tickLine={false}
            axisLine={false}
            width={32}
            allowDecimals={false}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: 'hsl(var(--popover))',
              border: '1px solid hsl(var(--border))',
              borderRadius: '8px',
              fontSize: '11px',
            }}
            labelStyle={{ color: 'hsl(var(--muted-foreground))' }}
            formatter={(value: number | undefined) => [`${value ?? 0}`, 'Trades']}
          />
          <Bar dataKey="count" radius={[3, 3, 0, 0]}>
            {data.map((entry, index) => (
              <Cell
                key={`cell-${index}`}
                fill={entry.isPositive ? POSITIVE_COLOR : NEGATIVE_COLOR}
                opacity={0.85}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
