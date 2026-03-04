'use client';

import { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { CorrelationData } from '@/hooks/use-analytics-data';

interface CorrelationMatrixProps {
  data: CorrelationData;
  className?: string;
}

/**
 * Interpolate between blue (-1), white (0), and red (+1)
 */
function correlationColor(value: number): string {
  const clamped = Math.max(-1, Math.min(1, value));

  if (clamped < 0) {
    const intensity = Math.abs(clamped);
    return `rgba(59, 130, 246, ${0.1 + intensity * 0.6})`;
  } else if (clamped > 0) {
    const intensity = clamped;
    return `rgba(239, 68, 68, ${0.1 + intensity * 0.6})`;
  }

  return 'rgba(161, 161, 170, 0.1)';
}

function correlationTextColor(value: number): string {
  const abs = Math.abs(value);
  if (abs > 0.6) return '#fafafa';
  return '#a1a1aa';
}

/**
 * Build the flat list of grid items: corner, column headers, then for each
 * row: row header + N cells. This avoids React Fragment key warnings.
 */
interface GridItem {
  key: string;
  type: 'corner' | 'col-header' | 'row-header' | 'cell';
  asset?: string;
  rowIdx?: number;
  colIdx?: number;
  assetA?: string;
  assetB?: string;
  value?: number;
}

export function CorrelationMatrix({ data, className }: CorrelationMatrixProps) {
  const { assets, matrix } = data;

  const gridItems = useMemo(() => {
    const items: GridItem[] = [];

    // Top-left corner
    items.push({ key: 'corner', type: 'corner' });

    // Column headers
    for (const asset of assets) {
      items.push({ key: `col-${asset}`, type: 'col-header', asset });
    }

    // Rows: row-header + cells
    for (let rowIdx = 0; rowIdx < assets.length; rowIdx++) {
      items.push({
        key: `row-${assets[rowIdx]}`,
        type: 'row-header',
        asset: assets[rowIdx],
      });

      for (let colIdx = 0; colIdx < assets.length; colIdx++) {
        items.push({
          key: `cell-${rowIdx}-${colIdx}`,
          type: 'cell',
          rowIdx,
          colIdx,
          assetA: assets[rowIdx],
          assetB: assets[colIdx],
          value: matrix[rowIdx][colIdx],
        });
      }
    }

    return items;
  }, [assets, matrix]);

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
            <path d="M3 3h18v18H3z" />
            <path d="M3 9h18" />
            <path d="M3 15h18" />
            <path d="M9 3v18" />
            <path d="M15 3v18" />
          </svg>
          Correlation Matrix
        </CardTitle>
        <CardDescription>
          Pearson correlation between portfolio assets
        </CardDescription>
      </CardHeader>
      <CardContent>
        <TooltipProvider delayDuration={100}>
          <div data-testid="correlation-matrix" className="overflow-x-auto">
            <div
              className="grid gap-0.5"
              style={{
                gridTemplateColumns: `48px repeat(${assets.length}, 1fr)`,
                gridTemplateRows: `32px repeat(${assets.length}, 1fr)`,
              }}
            >
              {gridItems.map((item) => {
                if (item.type === 'corner') {
                  return <div key={item.key} />;
                }

                if (item.type === 'col-header') {
                  return (
                    <div
                      key={item.key}
                      className="flex items-center justify-center text-xs font-mono font-medium text-muted-foreground truncate px-1"
                    >
                      {item.asset}
                    </div>
                  );
                }

                if (item.type === 'row-header') {
                  return (
                    <div
                      key={item.key}
                      className="flex items-center justify-end pr-2 text-xs font-mono font-medium text-muted-foreground"
                    >
                      {item.asset}
                    </div>
                  );
                }

                // Cell
                const value = item.value ?? 0;
                const isDiagonal = item.rowIdx === item.colIdx;

                return (
                  <Tooltip key={item.key}>
                    <TooltipTrigger asChild>
                      <div
                        className={cn(
                          'flex items-center justify-center rounded-sm h-10 min-w-[40px] cursor-default transition-colors',
                          isDiagonal && 'ring-1 ring-border'
                        )}
                        style={{
                          backgroundColor: correlationColor(value),
                        }}
                        data-testid={`cell-${item.rowIdx}-${item.colIdx}`}
                      >
                        <span
                          className="text-xs font-mono font-medium"
                          style={{ color: correlationTextColor(value) }}
                        >
                          {value.toFixed(2)}
                        </span>
                      </div>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="text-xs">
                      <span className="font-medium">
                        {item.assetA}/{item.assetB}
                      </span>
                      : {value.toFixed(4)}
                    </TooltipContent>
                  </Tooltip>
                );
              })}
            </div>

            {/* Legend */}
            <div className="mt-4 flex items-center justify-center gap-2 text-xs text-muted-foreground">
              <div className="flex items-center gap-1">
                <div
                  className="h-3 w-3 rounded-sm"
                  style={{ backgroundColor: 'rgba(59, 130, 246, 0.7)' }}
                />
                <span>-1.0</span>
              </div>
              <div className="h-px w-6 bg-border" />
              <div className="flex items-center gap-1">
                <div
                  className="h-3 w-3 rounded-sm"
                  style={{ backgroundColor: 'rgba(161, 161, 170, 0.1)' }}
                />
                <span>0.0</span>
              </div>
              <div className="h-px w-6 bg-border" />
              <div className="flex items-center gap-1">
                <div
                  className="h-3 w-3 rounded-sm"
                  style={{ backgroundColor: 'rgba(239, 68, 68, 0.7)' }}
                />
                <span>+1.0</span>
              </div>
            </div>
          </div>
        </TooltipProvider>
      </CardContent>
    </Card>
  );
}
