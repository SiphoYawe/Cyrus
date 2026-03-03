'use client';

import { useEffect, useState } from 'react';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { formatUsd, formatPercent, formatDuration, pnlColor } from '@/lib/format';
import type { PerpPosition, PairPosition, MarketMakingPosition, PositionType } from './types';

function useNow(intervalMs = 60_000) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

interface PositionDetailSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  positionType: PositionType;
  position: PerpPosition | PairPosition | MarketMakingPosition | null;
}

export function PositionDetailSheet({
  open,
  onOpenChange,
  positionType,
  position,
}: PositionDetailSheetProps) {
  if (!position) return null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[480px] overflow-y-auto bg-card sm:max-w-[480px]">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Badge variant="secondary" className="bg-primary/20 text-primary">
              {positionType === 'perp' ? 'Perpetual' : positionType === 'pair' ? 'Pair Trade' : 'Market Making'}
            </Badge>
            <span>
              {positionType === 'perp'
                ? (position as PerpPosition).symbol
                : positionType === 'pair'
                  ? (position as PairPosition).pairName
                  : (position as MarketMakingPosition).market}
            </span>
          </SheetTitle>
        </SheetHeader>

        <div className="mt-6 space-y-6">
          {positionType === 'perp' && <PerpDetail position={position as PerpPosition} />}
          {positionType === 'pair' && <PairDetail position={position as PairPosition} />}
          {positionType === 'mm' && <MMDetail position={position as MarketMakingPosition} />}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function PerpDetail({ position }: { position: PerpPosition }) {
  const now = useNow();
  return (
    <>
      <div className="grid grid-cols-2 gap-4">
        <DetailItem label="Side">
          <Badge
            variant="secondary"
            className={position.side === 'long' ? 'bg-positive/20 text-positive' : 'bg-negative/20 text-negative'}
          >
            {position.side === 'long' ? 'Long' : 'Short'}
          </Badge>
        </DetailItem>
        <DetailItem label="Leverage">
          <span className="font-mono">{position.leverage}x</span>
        </DetailItem>
        <DetailItem label="Entry Price">
          <span className="font-mono">{formatUsd(position.entryPrice)}</span>
        </DetailItem>
        <DetailItem label="Current Price">
          <span className="font-mono">{formatUsd(position.currentPrice)}</span>
        </DetailItem>
        <DetailItem label="Size">
          <span className="font-mono">{position.size.toFixed(4)}</span>
        </DetailItem>
        <DetailItem label="Liquidation Price">
          <span className="font-mono text-negative">{formatUsd(position.liquidationPrice)}</span>
        </DetailItem>
      </div>

      <Separator />

      <div className="space-y-2">
        <h4 className="text-sm font-medium">Performance</h4>
        <div className="grid grid-cols-2 gap-4">
          <DetailItem label="Unrealized P&L">
            <span className={`font-mono ${pnlColor(position.unrealizedPnl)}`}>
              {formatUsd(position.unrealizedPnl)} ({formatPercent(position.unrealizedPnlPercent)})
            </span>
          </DetailItem>
          <DetailItem label="Funding Rate">
            <span className={`font-mono ${pnlColor(position.fundingRate)}`}>
              {formatPercent(position.fundingRate)} / yr
            </span>
          </DetailItem>
        </div>
      </div>

      <Separator />

      <DetailItem label="Duration">
        <span className="text-muted-foreground">
          {formatDuration(now - position.openedAt)}
        </span>
      </DetailItem>
    </>
  );
}

function PairDetail({ position }: { position: PairPosition }) {
  const now = useNow();
  return (
    <>
      <div className="grid grid-cols-2 gap-4">
        <DetailItem label="Direction">
          <Badge variant="secondary" className="bg-primary/20 text-primary">
            {position.direction === 'long_pair' ? 'Long Pair' : 'Short Pair'}
          </Badge>
        </DetailItem>
        <DetailItem label="Combined P&L">
          <span className={`font-mono ${pnlColor(position.combinedPnl)}`}>
            {formatUsd(position.combinedPnl)}
          </span>
        </DetailItem>
      </div>

      <Separator />

      <div className="space-y-2">
        <h4 className="text-sm font-medium">Long Leg</h4>
        <div className="grid grid-cols-2 gap-4">
          <DetailItem label="Token">{position.longLeg.token}</DetailItem>
          <DetailItem label="Entry Price">
            <span className="font-mono">{formatUsd(position.longLeg.entryPrice)}</span>
          </DetailItem>
        </div>
      </div>

      <div className="space-y-2">
        <h4 className="text-sm font-medium">Short Leg</h4>
        <div className="grid grid-cols-2 gap-4">
          <DetailItem label="Token">{position.shortLeg.token}</DetailItem>
          <DetailItem label="Entry Price">
            <span className="font-mono">{formatUsd(position.shortLeg.entryPrice)}</span>
          </DetailItem>
        </div>
      </div>

      <Separator />

      <div className="grid grid-cols-2 gap-4">
        <DetailItem label="Entry Z-Score">
          <span className="font-mono">{position.entryZScore.toFixed(2)}</span>
        </DetailItem>
        <DetailItem label="Current Z-Score">
          <span className="font-mono">{position.currentZScore.toFixed(2)}</span>
        </DetailItem>
        <DetailItem label="Duration">
          <span className="text-muted-foreground">
            {formatDuration(now - position.openedAt)}
          </span>
        </DetailItem>
      </div>
    </>
  );
}

function MMDetail({ position }: { position: MarketMakingPosition }) {
  const totalInventory = position.baseInventory + position.quoteInventory;
  const basePercent = totalInventory > 0 ? (position.baseInventory / totalInventory) * 100 : 50;

  return (
    <>
      <div className="grid grid-cols-2 gap-4">
        <DetailItem label="Best Bid">
          <span className="font-mono text-positive">{formatUsd(position.bestBid)}</span>
        </DetailItem>
        <DetailItem label="Best Ask">
          <span className="font-mono text-negative">{formatUsd(position.bestAsk)}</span>
        </DetailItem>
        <DetailItem label="Bid Count">
          <span className="font-mono">{position.bidCount}</span>
        </DetailItem>
        <DetailItem label="Ask Count">
          <span className="font-mono">{position.askCount}</span>
        </DetailItem>
      </div>

      <Separator />

      <div className="space-y-2">
        <h4 className="text-sm font-medium">Inventory</h4>
        <div className="mb-1 flex justify-between text-xs text-muted-foreground">
          <span>{position.baseToken} ({basePercent.toFixed(0)}%)</span>
          <span>{position.quoteToken} ({(100 - basePercent).toFixed(0)}%)</span>
        </div>
        <div className="flex h-3 overflow-hidden rounded-full bg-secondary">
          <div className="bg-info" style={{ width: `${basePercent}%` }} />
          <div className="bg-positive" style={{ width: `${100 - basePercent}%` }} />
        </div>
      </div>

      <Separator />

      <div className="grid grid-cols-2 gap-4">
        <DetailItem label="Spread">
          <span className="font-mono">{position.spreadBps.toFixed(1)} bps</span>
        </DetailItem>
        <DetailItem label="Session P&L">
          <span className={`font-mono ${pnlColor(position.sessionPnl)}`}>
            {formatUsd(position.sessionPnl)}
          </span>
        </DetailItem>
      </div>
    </>
  );
}

function DetailItem({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="mt-0.5 text-sm">{children}</div>
    </div>
  );
}
