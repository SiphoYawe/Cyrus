import { create } from 'zustand';
import type { WsEventEnvelope } from '@/types/ws';
import { WS_EVENT_TYPES } from '@/types/ws';

export interface Transfer {
  id: string;
  txHash?: string;
  fromChainId: number;
  toChainId: number;
  fromToken: { symbol: string; address: string; decimals: number };
  toToken: { symbol: string; address: string; decimals: number };
  fromAmount: string;
  toAmount?: string;
  status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'PARTIAL' | 'REFUNDED' | 'FAILED' | 'NOT_FOUND';
  substatus?: string;
  bridge?: string;
  estimatedTimeMs?: number;
  startedAt: number;
  completedAt?: number;
  error?: string;
}

export interface TransfersState {
  active: Map<string, Transfer>;
  completed: Transfer[];

  addTransfer: (transfer: Transfer) => void;
  updateTransfer: (id: string, update: Partial<Transfer>) => void;
  completeTransfer: (id: string, finalData: Partial<Transfer>) => void;
  handleWsEvent: (event: WsEventEnvelope) => void;
}

export const useTransfersStore = create<TransfersState>()((set) => ({
  active: new Map(),
  completed: [],

  addTransfer: (transfer) =>
    set((state) => {
      const next = new Map(state.active);
      next.set(transfer.id, transfer);
      return { active: next };
    }),

  updateTransfer: (id, update) =>
    set((state) => {
      const existing = state.active.get(id);
      if (!existing) return state;
      const next = new Map(state.active);
      next.set(id, { ...existing, ...update });
      return { active: next };
    }),

  completeTransfer: (id, finalData) =>
    set((state) => {
      const existing = state.active.get(id);
      if (!existing) return state;
      const next = new Map(state.active);
      next.delete(id);
      const completedTransfer = { ...existing, ...finalData, completedAt: Date.now() };
      return {
        active: next,
        completed: [completedTransfer, ...state.completed].slice(0, 50),
      };
    }),

  handleWsEvent: (event) => {
    const data = event.data as Transfer;
    switch (event.event) {
      case WS_EVENT_TYPES.STATE_TRANSFER_CREATED:
        set((state) => {
          const next = new Map(state.active);
          next.set(data.id, data);
          return { active: next };
        });
        break;
      case WS_EVENT_TYPES.STATE_TRANSFER_UPDATED:
        set((state) => {
          const existing = state.active.get(data.id);
          if (!existing) return state;
          const next = new Map(state.active);
          next.set(data.id, { ...existing, ...data });
          return { active: next };
        });
        break;
      case WS_EVENT_TYPES.STATE_TRANSFER_COMPLETED:
        set((state) => {
          const existing = state.active.get(data.id);
          if (!existing) return state;
          const next = new Map(state.active);
          next.delete(data.id);
          return {
            active: next,
            completed: [{ ...existing, ...data, completedAt: Date.now() }, ...state.completed].slice(0, 50),
          };
        });
        break;
    }
  },
}));
