'use client';

import { useState } from 'react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { formatUsd, formatPercent, pnlColor } from '@/lib/format';
import type { PerpPosition } from './types';

type SortKey = 'symbol' | 'unrealizedPnl' | 'size' | 'leverage';
type SortDir = 'asc' | 'desc';

interface PerpsTableProps {
  positions: PerpPosition[];
  onRowClick: (position: PerpPosition) => void;
}

export function PerpsTable({ positions, onRowClick }: PerpsTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>('unrealizedPnl');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  };

  const sorted = [...positions].sort((a, b) => {
    const mul = sortDir === 'asc' ? 1 : -1;
    if (sortKey === 'symbol') return mul * a.symbol.localeCompare(b.symbol);
    return mul * ((a[sortKey] as number) - (b[sortKey] as number));
  });

  if (positions.length === 0) {
    return (
      <div className="py-8 text-center text-sm text-muted-foreground">
        No perpetual positions open.
      </div>
    );
  }

  const isNearLiquidation = (pos: PerpPosition): boolean => {
    const distance = Math.abs(pos.currentPrice - pos.liquidationPrice) / pos.currentPrice;
    return distance < 0.1;
  };

  const leverageColor = (lev: number): string => {
    if (lev <= 3) return 'bg-info/20 text-info';
    if (lev <= 10) return 'bg-warning/20 text-warning';
    return 'bg-negative/20 text-negative';
  };

  const sortIcon = (key: SortKey) => {
    if (sortKey !== key) return null;
    return sortDir === 'asc' ? ' ↑' : ' ↓';
  };

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="cursor-pointer" onClick={() => handleSort('symbol')}>
            Symbol{sortIcon('symbol')}
          </TableHead>
          <TableHead>Side</TableHead>
          <TableHead className="cursor-pointer text-right" onClick={() => handleSort('size')}>
            Size{sortIcon('size')}
          </TableHead>
          <TableHead className="text-right">Entry Price</TableHead>
          <TableHead className="text-right">Current Price</TableHead>
          <TableHead className="cursor-pointer text-right" onClick={() => handleSort('leverage')}>
            Leverage{sortIcon('leverage')}
          </TableHead>
          <TableHead className="cursor-pointer text-right" onClick={() => handleSort('unrealizedPnl')}>
            Unrealized P&L{sortIcon('unrealizedPnl')}
          </TableHead>
          <TableHead className="text-right">Liq. Price</TableHead>
          <TableHead className="text-right">Funding</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sorted.map((pos) => (
          <TableRow
            key={pos.id}
            className="cursor-pointer hover:bg-secondary/50"
            onClick={() => onRowClick(pos)}
          >
            <TableCell className="font-medium">{pos.symbol}</TableCell>
            <TableCell>
              <Badge
                variant="secondary"
                className={
                  pos.side === 'long'
                    ? 'bg-positive/20 text-positive'
                    : 'bg-negative/20 text-negative'
                }
              >
                {pos.side === 'long' ? 'Long' : 'Short'}
              </Badge>
            </TableCell>
            <TableCell className="text-right font-mono">{pos.size.toFixed(4)}</TableCell>
            <TableCell className="text-right font-mono">{formatUsd(pos.entryPrice)}</TableCell>
            <TableCell className="text-right font-mono">{formatUsd(pos.currentPrice)}</TableCell>
            <TableCell className="text-right">
              <Badge variant="secondary" className={leverageColor(pos.leverage)}>
                {pos.leverage}x
              </Badge>
            </TableCell>
            <TableCell className={`text-right font-mono ${pnlColor(pos.unrealizedPnl)}`}>
              {formatUsd(pos.unrealizedPnl)}
              <span className="ml-1 text-xs">
                ({formatPercent(pos.unrealizedPnlPercent)})
              </span>
            </TableCell>
            <TableCell
              className={`text-right font-mono ${
                isNearLiquidation(pos) ? 'text-negative animate-pulse' : 'text-muted-foreground'
              }`}
            >
              {formatUsd(pos.liquidationPrice)}
              {isNearLiquidation(pos) && (
                <span className="ml-1 text-xs text-negative">⚠</span>
              )}
            </TableCell>
            <TableCell className={`text-right font-mono ${pnlColor(pos.fundingRate)}`}>
              {formatPercent(pos.fundingRate)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
