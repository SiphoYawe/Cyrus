'use client';

import React, { useMemo, useCallback } from 'react';
import { Treemap, ResponsiveContainer } from 'recharts';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import type { AllocationNode } from '@/hooks/use-analytics-data';

interface PortfolioTreemapProps {
  data: AllocationNode[];
  className?: string;
}

interface TreemapNodeData {
  name: string;
  symbol: string;
  value: number;
  change24h: number;
  [key: string]: unknown;
}

interface TreemapContentProps {
  x: number;
  y: number;
  width: number;
  height: number;
  name: string;
  symbol?: string;
  change24h?: number;
  value?: number;
}

/**
 * Get background color based on 24h performance
 * Green tints for positive, red tints for negative
 */
function getPerformanceColor(change: number): string {
  if (change > 5) return 'rgba(34, 197, 94, 0.45)';
  if (change > 2) return 'rgba(34, 197, 94, 0.3)';
  if (change > 0) return 'rgba(34, 197, 94, 0.15)';
  if (change > -2) return 'rgba(239, 68, 68, 0.15)';
  if (change > -5) return 'rgba(239, 68, 68, 0.3)';
  return 'rgba(239, 68, 68, 0.45)';
}

function getTextColor(change: number): string {
  return change >= 0 ? '#22C55E' : '#EF4444';
}

function formatUsd(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const CustomTreemapContent = (props: any): React.ReactElement => {
  const { x, y, width, height, name, symbol, change24h = 0, value = 0 } = props as TreemapContentProps;

  // Do not render tiny nodes
  if (width < 40 || height < 30) return <g />;

  const bgColor = getPerformanceColor(change24h);
  const changeColor = getTextColor(change24h);
  const showDetails = width > 80 && height > 60;

  return (
    <g>
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        rx={6}
        fill={bgColor}
        stroke="#27272a"
        strokeWidth={1.5}
      />
      <text
        x={x + width / 2}
        y={y + (showDetails ? height / 2 - 12 : height / 2)}
        textAnchor="middle"
        dominantBaseline="central"
        fill="#fafafa"
        fontSize={width > 100 ? 14 : 11}
        fontWeight={600}
        fontFamily="'Inter', sans-serif"
      >
        {symbol || name}
      </text>
      {showDetails && (
        <>
          <text
            x={x + width / 2}
            y={y + height / 2 + 6}
            textAnchor="middle"
            dominantBaseline="central"
            fill="#a1a1aa"
            fontSize={10}
            fontFamily="'JetBrains Mono', monospace"
          >
            {formatUsd(value)}
          </text>
          <text
            x={x + width / 2}
            y={y + height / 2 + 22}
            textAnchor="middle"
            dominantBaseline="central"
            fill={changeColor}
            fontSize={10}
            fontWeight={500}
            fontFamily="'JetBrains Mono', monospace"
          >
            {change24h >= 0 ? '+' : ''}{change24h.toFixed(1)}%
          </text>
        </>
      )}
    </g>
  );
};

export function PortfolioTreemap({ data, className }: PortfolioTreemapProps) {
  const treemapData = useMemo(
    () =>
      data.map(
        (item): TreemapNodeData => ({
          name: item.name,
          symbol: item.symbol,
          value: item.value,
          change24h: item.change24h,
        })
      ),
    [data]
  );

  const renderContent = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (props: any) => CustomTreemapContent(props),
    []
  );

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
            <rect x="3" y="3" width="7" height="7" />
            <rect x="14" y="3" width="7" height="7" />
            <rect x="14" y="14" width="7" height="7" />
            <rect x="3" y="14" width="7" height="7" />
          </svg>
          Portfolio Heatmap
        </CardTitle>
        <CardDescription>
          Allocation size with 24h performance tinting
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div data-testid="portfolio-treemap" className="w-full h-[340px]">
          <ResponsiveContainer width="100%" height="100%">
            <Treemap
              data={treemapData}
              dataKey="value"
              stroke="#27272a"
              content={renderContent}
              animationDuration={300}
            />
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
