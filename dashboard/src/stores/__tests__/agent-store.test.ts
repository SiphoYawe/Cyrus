import { describe, it, expect, beforeEach } from 'vitest';
import { useAgentStore } from '../agent-store';
import { WS_EVENT_TYPES } from '@/types/ws';

describe('agent-store', () => {
  beforeEach(() => {
    useAgentStore.setState({
      status: 'unknown',
      regime: 'unknown',
      config: null,
      lastTick: null,
      tickCount: 0,
      error: null,
      activeStrategies: [],
    });
  });

  it('starts with unknown status', () => {
    const state = useAgentStore.getState();
    expect(state.status).toBe('unknown');
    expect(state.regime).toBe('unknown');
  });

  it('handles AGENT_STARTED event', () => {
    useAgentStore.getState().handleWsEvent({
      event: WS_EVENT_TYPES.AGENT_STARTED,
      data: {},
      timestamp: Date.now(),
    });
    expect(useAgentStore.getState().status).toBe('running');
  });

  it('handles AGENT_STOPPED event', () => {
    useAgentStore.getState().setStatus('running');
    useAgentStore.getState().handleWsEvent({
      event: WS_EVENT_TYPES.AGENT_STOPPED,
      data: {},
      timestamp: Date.now(),
    });
    expect(useAgentStore.getState().status).toBe('stopped');
  });

  it('handles AGENT_ERROR event', () => {
    useAgentStore.getState().handleWsEvent({
      event: WS_EVENT_TYPES.AGENT_ERROR,
      data: { message: 'LI.FI rate limit exceeded' },
      timestamp: Date.now(),
    });
    const state = useAgentStore.getState();
    expect(state.status).toBe('error');
    expect(state.error).toBe('LI.FI rate limit exceeded');
  });

  it('handles AGENT_TICK event and increments count', () => {
    useAgentStore.getState().handleWsEvent({
      event: WS_EVENT_TYPES.AGENT_TICK,
      data: {},
      timestamp: 1234567890,
    });
    const state = useAgentStore.getState();
    expect(state.tickCount).toBe(1);
    expect(state.lastTick).toBe(1234567890);
  });

  it('handles AI_REGIME_CHANGED event', () => {
    useAgentStore.getState().handleWsEvent({
      event: WS_EVENT_TYPES.AI_REGIME_CHANGED,
      data: { regime: 'bull' },
      timestamp: Date.now(),
    });
    expect(useAgentStore.getState().regime).toBe('bull');
  });

  it('handles AI_STRATEGY_SELECTION_CHANGED event', () => {
    useAgentStore.getState().handleWsEvent({
      event: WS_EVENT_TYPES.AI_STRATEGY_SELECTION_CHANGED,
      data: { strategies: ['YieldHunter', 'CrossChainArb'] },
      timestamp: Date.now(),
    });
    expect(useAgentStore.getState().activeStrategies).toEqual(['YieldHunter', 'CrossChainArb']);
  });
});
