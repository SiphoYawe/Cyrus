import { useState, useEffect, useCallback } from 'react';
import type { PerpPosition, PairPosition, MarketMakingPosition } from '@/components/trading/types';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

interface TradingData {
  perps: PerpPosition[];
  pairs: PairPosition[];
  marketMaking: MarketMakingPosition[];
  totalOpenPositions: number;
  unrealizedPnl: number;
  dailyRealizedPnl: number;
  totalFunding: number;
  isLoading: boolean;
  error: string | null;
}

export function useTradingPositions(): TradingData {
  const [data, setData] = useState<TradingData>({
    perps: [],
    pairs: [],
    marketMaking: [],
    totalOpenPositions: 0,
    unrealizedPnl: 0,
    dailyRealizedPnl: 0,
    totalFunding: 0,
    isLoading: true,
    error: null,
  });

  const fetchPositions = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/api/portfolio`);
      if (!res.ok) throw new Error('Failed to fetch');
      const json = await res.json();
      const portfolio = json.ok ? json.data : json;

      setData({
        perps: portfolio.perps ?? [],
        pairs: portfolio.pairs ?? [],
        marketMaking: portfolio.marketMaking ?? [],
        totalOpenPositions: (portfolio.perps?.length ?? 0) + (portfolio.pairs?.length ?? 0) + (portfolio.marketMaking?.length ?? 0),
        unrealizedPnl: portfolio.unrealizedPnl ?? 0,
        dailyRealizedPnl: portfolio.dailyRealizedPnl ?? 0,
        totalFunding: portfolio.totalFunding ?? 0,
        isLoading: false,
        error: null,
      });
    } catch {
      setData((prev) => ({ ...prev, isLoading: false, error: 'Failed to load positions' }));
    }
  }, []);

  useEffect(() => {
    fetchPositions();
  }, [fetchPositions]);

  return data;
}
