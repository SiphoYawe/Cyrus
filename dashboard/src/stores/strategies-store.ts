import { create } from 'zustand';
import type { WsEventEnvelope } from '@/types/ws';
import { WS_EVENT_TYPES } from '@/types/ws';

export type StrategyTier = 'Safe' | 'Growth' | 'Degen';

export interface StrategyPerformancePoint {
  timestamp: number;
  pnl: number;
}

export interface StrategyMetrics {
  totalPnl: number;
  winRate: number;
  totalTrades: number;
  openPositions: number;
  lastSignalAt: number | null;
  performanceHistory: StrategyPerformancePoint[];
}

export interface StrategyParam {
  key: string;
  value: string | number | boolean;
  description?: string;
}

export interface Strategy {
  name: string;
  enabled: boolean;
  tier: StrategyTier;
  metrics: StrategyMetrics;
  params: StrategyParam[];
}

export interface StrategiesState {
  strategies: Strategy[];
  isLoading: boolean;

  setStrategies: (strategies: Strategy[]) => void;
  setLoading: (loading: boolean) => void;
  toggleStrategy: (name: string, enabled: boolean) => void;
  handleWsEvent: (event: WsEventEnvelope) => void;
}

export const useStrategiesStore = create<StrategiesState>()((set) => ({
  strategies: [],
  isLoading: true,

  setStrategies: (strategies) => set({ strategies, isLoading: false }),
  setLoading: (isLoading) => set({ isLoading }),

  toggleStrategy: (name, enabled) =>
    set((state) => ({
      strategies: state.strategies.map((s) =>
        s.name === name ? { ...s, enabled } : s
      ),
    })),

  handleWsEvent: (event) => {
    if (event.event === WS_EVENT_TYPES.STRATEGY_STATUS_UPDATED) {
      const data = event.data as Partial<Strategy> & { name: string };
      set((state) => ({
        strategies: state.strategies.map((s) =>
          s.name === data.name ? { ...s, ...data } : s
        ),
      }));
    }
  },
}));
