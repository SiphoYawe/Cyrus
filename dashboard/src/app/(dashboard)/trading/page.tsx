'use client';

import { useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useTradingPositions } from '@/hooks/use-trading-positions';
import { PerpsTable } from '@/components/trading/perps-table';
import { PairsTable } from '@/components/trading/pairs-table';
import { MarketMakingCard } from '@/components/trading/market-making-card';
import { PositionDetailSheet } from '@/components/trading/position-detail-sheet';
import { formatUsd, pnlColor } from '@/lib/format';
import type { PerpPosition, PairPosition, MarketMakingPosition, PositionType } from '@/components/trading/types';

export default function TradingPage() {
  const {
    perps,
    pairs,
    marketMaking,
    totalOpenPositions,
    unrealizedPnl,
    dailyRealizedPnl,
    totalFunding,
    isLoading,
  } = useTradingPositions();

  const [selectedPosition, setSelectedPosition] = useState<
    PerpPosition | PairPosition | MarketMakingPosition | null
  >(null);
  const [selectedType, setSelectedType] = useState<PositionType>('perp');
  const [sheetOpen, setSheetOpen] = useState(false);

  const openDetail = (type: PositionType, position: PerpPosition | PairPosition | MarketMakingPosition) => {
    setSelectedType(type);
    setSelectedPosition(position);
    setSheetOpen(true);
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <h2 className="text-xl font-semibold">Trading</h2>
        <div className="grid grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i} className="border-border bg-card">
              <CardContent className="pt-6">
                <div className="h-4 w-24 animate-pulse rounded bg-secondary" />
                <div className="mt-2 h-6 w-16 animate-pulse rounded bg-secondary" />
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-semibold">Trading</h2>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <KpiCard label="Open Positions" value={String(totalOpenPositions)} />
        <KpiCard
          label="Unrealized P&L"
          value={formatUsd(unrealizedPnl)}
          colorClass={pnlColor(unrealizedPnl)}
          mono
        />
        <KpiCard
          label="Daily Realized"
          value={formatUsd(dailyRealizedPnl)}
          colorClass={pnlColor(dailyRealizedPnl)}
          mono
        />
        <KpiCard
          label="Total Funding"
          value={formatUsd(totalFunding)}
          colorClass={pnlColor(totalFunding)}
          mono
        />
      </div>

      {/* Tabbed Position Sections */}
      <Tabs defaultValue="perps">
        <TabsList className="bg-secondary">
          <TabsTrigger value="perps">
            Perpetuals{perps.length > 0 && ` (${perps.length})`}
          </TabsTrigger>
          <TabsTrigger value="pairs">
            Pair Trades{pairs.length > 0 && ` (${pairs.length})`}
          </TabsTrigger>
          <TabsTrigger value="mm">
            Market Making{marketMaking.length > 0 && ` (${marketMaking.length})`}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="perps" className="mt-4">
          <Card className="border-border bg-card">
            <CardContent className="pt-6">
              <PerpsTable
                positions={perps}
                onRowClick={(pos) => openDetail('perp', pos)}
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="pairs" className="mt-4">
          <Card className="border-border bg-card">
            <CardContent className="pt-6">
              <PairsTable
                positions={pairs}
                onRowClick={(pos) => openDetail('pair', pos)}
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="mm" className="mt-4">
          {marketMaking.length === 0 ? (
            <Card className="border-border bg-card">
              <CardContent className="py-8 text-center text-sm text-muted-foreground">
                No market making positions active.
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {marketMaking.map((pos) => (
                <MarketMakingCard
                  key={pos.id}
                  position={pos}
                  onClick={(p) => openDetail('mm', p)}
                />
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>

      {/* Detail Sheet */}
      <PositionDetailSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        positionType={selectedType}
        position={selectedPosition}
      />
    </div>
  );
}

function KpiCard({
  label,
  value,
  colorClass,
  mono,
}: {
  label: string;
  value: string;
  colorClass?: string;
  mono?: boolean;
}) {
  return (
    <Card className="border-border bg-card">
      <CardContent className="pt-6">
        <span className="text-xs text-muted-foreground">{label}</span>
        <p className={`mt-1 text-lg font-semibold ${mono ? 'font-mono' : ''} ${colorClass ?? ''}`}>
          {value}
        </p>
      </CardContent>
    </Card>
  );
}
