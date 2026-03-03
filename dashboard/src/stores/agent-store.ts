import { create } from 'zustand';
import type { WsEventEnvelope } from '@/types/ws';
import { WS_EVENT_TYPES } from '@/types/ws';

export type AgentStatus = 'running' | 'stopped' | 'error' | 'unknown';
export type MarketRegime = 'bull' | 'bear' | 'sideways' | 'volatile' | 'unknown';

export interface AgentConfig {
  mode: string;
  tickIntervalMs: number;
  chains: number[];
  strategies: string[];
  riskLevel: number;
  [key: string]: unknown;
}

export interface AgentState {
  status: AgentStatus;
  regime: MarketRegime;
  config: AgentConfig | null;
  lastTick: number | null;
  tickCount: number;
  error: string | null;
  activeStrategies: string[];

  setStatus: (status: AgentStatus) => void;
  setRegime: (regime: MarketRegime) => void;
  setConfig: (config: AgentConfig) => void;
  handleWsEvent: (event: WsEventEnvelope) => void;
}

export const useAgentStore = create<AgentState>()((set) => ({
  status: 'unknown',
  regime: 'unknown',
  config: null,
  lastTick: null,
  tickCount: 0,
  error: null,
  activeStrategies: [],

  setStatus: (status) => set({ status, error: null }),
  setRegime: (regime) => set({ regime }),
  setConfig: (config) => set({ config }),

  handleWsEvent: (event) => {
    switch (event.event) {
      case WS_EVENT_TYPES.AGENT_STARTED:
        set({ status: 'running', error: null });
        break;
      case WS_EVENT_TYPES.AGENT_STOPPED:
        set({ status: 'stopped' });
        break;
      case WS_EVENT_TYPES.AGENT_TICK:
        set((state) => ({
          lastTick: event.timestamp,
          tickCount: state.tickCount + 1,
        }));
        break;
      case WS_EVENT_TYPES.AGENT_ERROR:
        set({
          status: 'error',
          error: (event.data as { message?: string })?.message ?? 'Unknown error',
        });
        break;
      case WS_EVENT_TYPES.AI_REGIME_CHANGED:
        set({ regime: (event.data as { regime: MarketRegime }).regime });
        break;
      case WS_EVENT_TYPES.AI_STRATEGY_SELECTION_CHANGED:
        set({
          activeStrategies: (event.data as { strategies: string[] }).strategies,
        });
        break;
    }
  },
}));
