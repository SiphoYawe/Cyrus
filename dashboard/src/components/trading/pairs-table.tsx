'use client';

import { useEffect, useState } from 'react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { formatUsd, formatDuration, pnlColor } from '@/lib/format';
import type { PairPosition } from './types';

interface PairsTableProps {
  positions: PairPosition[];
  onRowClick: (position: PairPosition) => void;
}

function zScoreColor(z: number): string {
  const absZ = Math.abs(z);
  if (absZ < 0.5) return 'text-positive';
  if (absZ < 1.5) return 'text-info';
  if (absZ < 2.5) return 'text-warning';
  return 'text-negative';
}

export function PairsTable({ positions, onRowClick }: PairsTableProps) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  if (positions.length === 0) {
    return (
      <div className="py-8 text-center text-sm text-muted-foreground">
        No pair trades active.
      </div>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Pair</TableHead>
          <TableHead>Direction</TableHead>
          <TableHead className="text-right">Long Leg</TableHead>
          <TableHead className="text-right">Short Leg</TableHead>
          <TableHead className="text-right">Entry Z</TableHead>
          <TableHead className="text-right">Current Z</TableHead>
          <TableHead className="text-right">Combined P&L</TableHead>
          <TableHead className="text-right">Duration</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {positions.map((pos) => (
          <TableRow
            key={pos.id}
            className="cursor-pointer hover:bg-secondary/50"
            onClick={() => onRowClick(pos)}
          >
            <TableCell className="font-medium">{pos.pairName}</TableCell>
            <TableCell>
              <Badge variant="secondary" className="bg-primary/20 text-primary">
                {pos.direction === 'long_pair' ? 'Long Pair' : 'Short Pair'}
              </Badge>
            </TableCell>
            <TableCell className="text-right font-mono text-sm">
              {pos.longLeg.token} @ {formatUsd(pos.longLeg.entryPrice)}
            </TableCell>
            <TableCell className="text-right font-mono text-sm">
              {pos.shortLeg.token} @ {formatUsd(pos.shortLeg.entryPrice)}
            </TableCell>
            <TableCell className="text-right font-mono">
              {pos.entryZScore.toFixed(2)}
            </TableCell>
            <TableCell className={`text-right font-mono ${zScoreColor(pos.currentZScore)}`}>
              {pos.currentZScore.toFixed(2)}
            </TableCell>
            <TableCell className={`text-right font-mono ${pnlColor(pos.combinedPnl)}`}>
              {formatUsd(pos.combinedPnl)}
            </TableCell>
            <TableCell className="text-right text-sm text-muted-foreground">
              {formatDuration(now - pos.openedAt)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
