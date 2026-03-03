import { describe, it, expect, beforeEach } from 'vitest';
import { usePortfolioStore } from '../portfolio-store';
import { WS_EVENT_TYPES } from '@/types/ws';

describe('portfolio-store', () => {
  beforeEach(() => {
    usePortfolioStore.setState({
      balances: [],
      allocations: [],
      chainAllocations: [],
      totalValue: 0,
      dailyPnl: 0,
      dailyPnlPercent: 0,
      weightedYield: 0,
      isLoading: true,
    });
  });

  it('starts in loading state', () => {
    const state = usePortfolioStore.getState();
    expect(state.isLoading).toBe(true);
    expect(state.totalValue).toBe(0);
    expect(state.balances).toEqual([]);
  });

  it('setPortfolio updates state and clears loading', () => {
    usePortfolioStore.getState().setPortfolio({
      totalValue: 50000,
      dailyPnl: 250,
      dailyPnlPercent: 0.5,
    });

    const state = usePortfolioStore.getState();
    expect(state.totalValue).toBe(50000);
    expect(state.dailyPnl).toBe(250);
    expect(state.isLoading).toBe(false);
  });

  it('handleWsEvent updates balances on STATE_BALANCE_UPDATED', () => {
    usePortfolioStore.getState().handleWsEvent({
      event: WS_EVENT_TYPES.STATE_BALANCE_UPDATED,
      data: {
        totalValue: 75000,
        dailyPnl: -100,
        balances: [
          { chainId: 1, tokenAddress: '0x0', symbol: 'ETH', amount: '1000000000000000000', usdValue: 3000, decimals: 18 },
        ],
      },
      timestamp: Date.now(),
    });

    const state = usePortfolioStore.getState();
    expect(state.totalValue).toBe(75000);
    expect(state.dailyPnl).toBe(-100);
    expect(state.balances).toHaveLength(1);
    expect(state.balances[0].symbol).toBe('ETH');
    expect(state.isLoading).toBe(false);
  });

  it('ignores unrelated events', () => {
    usePortfolioStore.getState().handleWsEvent({
      event: 'agent.tick',
      data: {},
      timestamp: Date.now(),
    });
    expect(usePortfolioStore.getState().isLoading).toBe(true);
  });
});
