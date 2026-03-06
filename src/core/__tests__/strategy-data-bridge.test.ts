import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StrategyDataBridge } from '../strategy-data-bridge.js';
import { Store } from '../store.js';
import type { CrossChainStrategy } from '../../strategies/cross-chain-strategy.js';
import type { MarketDataService } from '../../data/market-data-service.js';

function createMockMds(): MarketDataService {
  return {
    ready: true,
    buildContext: vi.fn().mockResolvedValue({ timestamp: Date.now(), prices: new Map(), balances: new Map() }),
    fetchYieldOpportunities: vi.fn().mockResolvedValue([]),
    fetchStakingRates: vi.fn().mockResolvedValue([]),
    getFundingRate: vi.fn().mockResolvedValue({
      market: 'ETH', currentRate: 0.001, predictedNextRate: 0.0012,
      avg7d: 0.0008, annualizedYield: 0.1, nextFundingTime: Date.now(), timestamp: Date.now(),
    }),
    getOrderBook: vi.fn().mockResolvedValue({
      market: 'ETH-USD', bids: [{ price: 3000, size: 1, sizeUsd: 3000 }],
      asks: [{ price: 3001, size: 1, sizeUsd: 3001 }], spread: 1, spreadPercent: 0.03,
      midPrice: 3000.5, timestamp: Date.now(),
    }),
    getMarketSnapshot: vi.fn().mockResolvedValue({ topTokenChanges: [], timestamp: Date.now() }),
  } as unknown as MarketDataService;
}

describe('StrategyDataBridge', () => {
  beforeEach(() => {
    Store.getInstance().reset();
  });

  it('initializes with empty strategies without error', () => {
    const bridge = new StrategyDataBridge({
      strategies: [],
      marketDataService: createMockMds(),
    });
    expect(bridge).toBeDefined();
  });

  it('feedStrategies completes without errors when no matching strategies', async () => {
    const bridge = new StrategyDataBridge({
      strategies: [],
      marketDataService: createMockMds(),
    });
    await bridge.feedStrategies();
    expect(bridge.getDataStatus()).toEqual({
      yieldData: false,
      fundingRates: false,
      socialSignals: false,
      orderBook: false,
    });
  });

  it('reports data status after feed', async () => {
    const bridge = new StrategyDataBridge({
      strategies: [],
      marketDataService: createMockMds(),
    });
    await bridge.feedStrategies();
    const status = bridge.getDataStatus();
    expect(status).toHaveProperty('yieldData');
    expect(status).toHaveProperty('fundingRates');
    expect(status).toHaveProperty('socialSignals');
    expect(status).toHaveProperty('orderBook');
  });

  it('handles data service errors gracefully', async () => {
    const failingMds = createMockMds();
    (failingMds.fetchYieldOpportunities as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('API error'));
    (failingMds.getFundingRate as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('API error'));
    (failingMds.getOrderBook as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('API error'));

    const bridge = new StrategyDataBridge({
      strategies: [],
      marketDataService: failingMds,
    });

    // Should not throw
    await bridge.feedStrategies();
    expect(bridge.getDataStatus().yieldData).toBe(false);
  });
});
