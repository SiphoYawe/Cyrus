import { create } from 'zustand';
import type { WsEventEnvelope } from '@/types/ws';
import { WS_EVENT_TYPES } from '@/types/ws';

export interface Balance {
  chainId: number;
  tokenAddress: string;
  symbol: string;
  amount: string;
  usdValue: number;
  decimals: number;
}

export interface Allocation {
  tier: string;
  percentage: number;
  usdValue: number;
}

export interface ChainAllocation {
  chainId: number;
  name: string;
  percentage: number;
  usdValue: number;
}

export interface PortfolioState {
  balances: Balance[];
  allocations: Allocation[];
  chainAllocations: ChainAllocation[];
  totalValue: number;
  dailyPnl: number;
  dailyPnlPercent: number;
  weightedYield: number;
  isLoading: boolean;

  setPortfolio: (data: Partial<PortfolioState>) => void;
  handleWsEvent: (event: WsEventEnvelope) => void;
}

export const usePortfolioStore = create<PortfolioState>()((set) => ({
  balances: [],
  allocations: [],
  chainAllocations: [],
  totalValue: 0,
  dailyPnl: 0,
  dailyPnlPercent: 0,
  weightedYield: 0,
  isLoading: true,

  setPortfolio: (data) => set((state) => ({ ...state, ...data, isLoading: false })),

  handleWsEvent: (event) => {
    if (event.event === WS_EVENT_TYPES.STATE_BALANCE_UPDATED) {
      const data = event.data as {
        balances?: Balance[];
        totalValue?: number;
        dailyPnl?: number;
        dailyPnlPercent?: number;
        allocations?: Allocation[];
        chainAllocations?: ChainAllocation[];
        weightedYield?: number;
      };
      set((state) => ({
        ...state,
        ...(data.balances && { balances: data.balances }),
        ...(data.totalValue !== undefined && { totalValue: data.totalValue }),
        ...(data.dailyPnl !== undefined && { dailyPnl: data.dailyPnl }),
        ...(data.dailyPnlPercent !== undefined && { dailyPnlPercent: data.dailyPnlPercent }),
        ...(data.allocations && { allocations: data.allocations }),
        ...(data.chainAllocations && { chainAllocations: data.chainAllocations }),
        ...(data.weightedYield !== undefined && { weightedYield: data.weightedYield }),
        isLoading: false,
      }));
    }
  },
}));
