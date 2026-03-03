'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatUsd, formatBps, pnlColor } from '@/lib/format';
import type { MarketMakingPosition } from './types';

interface MarketMakingCardProps {
  position: MarketMakingPosition;
  onClick: (position: MarketMakingPosition) => void;
}

function spreadColor(bps: number): string {
  if (bps < 10) return 'text-positive';
  if (bps < 50) return 'text-warning';
  return 'text-negative';
}

export function MarketMakingCard({ position, onClick }: MarketMakingCardProps) {
  const totalInventory = position.baseInventory + position.quoteInventory;
  const basePercent = totalInventory > 0 ? (position.baseInventory / totalInventory) * 100 : 50;

  return (
    <Card
      className="cursor-pointer border-border bg-card transition-colors hover:bg-secondary/30"
      onClick={() => onClick(position)}
    >
      <CardHeader className="pb-3">
        <CardTitle className="text-base font-medium">{position.market}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Bid/Ask */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <span className="text-xs text-muted-foreground">Bids ({position.bidCount})</span>
            <p className="font-mono text-sm text-positive">{formatUsd(position.bestBid)}</p>
          </div>
          <div className="text-right">
            <span className="text-xs text-muted-foreground">Asks ({position.askCount})</span>
            <p className="font-mono text-sm text-negative">{formatUsd(position.bestAsk)}</p>
          </div>
        </div>

        {/* Inventory Balance Bar */}
        <div>
          <div className="mb-1 flex justify-between text-xs text-muted-foreground">
            <span>{position.baseToken}</span>
            <span>{position.quoteToken}</span>
          </div>
          <div className="flex h-2 overflow-hidden rounded-full bg-secondary">
            <div
              className="bg-info transition-all duration-300"
              style={{ width: `${basePercent}%` }}
            />
            <div
              className="bg-positive transition-all duration-300"
              style={{ width: `${100 - basePercent}%` }}
            />
          </div>
        </div>

        {/* Spread & P&L */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <span className="text-xs text-muted-foreground">Spread</span>
            <p className={`font-mono text-sm ${spreadColor(position.spreadBps)}`}>
              {formatBps(position.spreadBps)}
            </p>
          </div>
          <div className="text-right">
            <span className="text-xs text-muted-foreground">Session P&L</span>
            <p className={`font-mono text-sm ${pnlColor(position.sessionPnl)}`}>
              {formatUsd(position.sessionPnl)}
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
