import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StrategyRunner } from '../strategy-runner.js';
import { Store } from '../store.js';
import type { CrossChainStrategy } from '../../strategies/cross-chain-strategy.js';
import type { ActionQueue } from '../action-queue.js';
import type { MarketDataService } from '../../data/market-data-service.js';

// Minimal mocks
function createMockStrategy(name: string): CrossChainStrategy {
  return {
    name,
    timeframe: '5m',
    stoploss: -0.1,
    minimalRoi: { 0: 0.05 },
    trailingStop: false,
    trailingStopPositive: undefined,
    maxPositions: 3,
    shouldExecute: vi.fn().mockReturnValue(null),
    buildExecution: vi.fn().mockReturnValue({ actions: [] }),
    filters: vi.fn().mockReturnValue([]),
    evaluateFilters: vi.fn().mockReturnValue(true),
    confirmTradeEntry: vi.fn().mockReturnValue(true),
    onBotStart: vi.fn().mockResolvedValue(undefined),
    onLoopStart: vi.fn().mockResolvedValue(undefined),
    confirmTradeExit: vi.fn().mockReturnValue(true),
    customStoploss: vi.fn().mockReturnValue(null),
    validate: vi.fn(),
  } as unknown as CrossChainStrategy;
}

function createMockMarketDataService(): MarketDataService {
  return {
    ready: true,
    buildContext: vi.fn().mockResolvedValue({
      timestamp: Date.now(),
      prices: new Map(),
      balances: new Map(),
    }),
    getMarketSnapshot: vi.fn().mockResolvedValue({
      topTokenChanges: [],
      timestamp: Date.now(),
    }),
    fetchYieldOpportunities: vi.fn().mockResolvedValue([]),
    fetchStakingRates: vi.fn().mockResolvedValue([]),
  } as unknown as MarketDataService;
}

function createMockActionQueue(): ActionQueue {
  return {
    enqueue: vi.fn(),
    isEmpty: vi.fn().mockReturnValue(true),
    size: vi.fn().mockReturnValue(0),
  } as unknown as ActionQueue;
}

describe('StrategyRunner AI + Risk Integration', () => {
  beforeEach(() => {
    Store.getInstance().reset();
  });

  it('accepts optional AI and risk deps without errors', () => {
    const runner = new StrategyRunner({
      strategies: [],
      marketDataService: createMockMarketDataService(),
      actionQueue: createMockActionQueue(),
      tickIntervalMs: 5000,
    });
    expect(runner).toBeDefined();
  });

  it('skips regime classification when aiOrchestrator is null', async () => {
    const mockMds = createMockMarketDataService();
    const strategy = createMockStrategy('TestStrategy');

    const runner = new StrategyRunner({
      strategies: [strategy],
      marketDataService: mockMds,
      actionQueue: createMockActionQueue(),
      tickIntervalMs: 5000,
    });

    // Access controlTask via the protected method
    await (runner as unknown as { controlTask: () => Promise<void> }).controlTask();

    // Strategy should still be evaluated (no regime filtering)
    expect(strategy.onLoopStart).toHaveBeenCalled();
  });

  it('blocks entries when circuit breaker is active', async () => {
    const mockMds = createMockMarketDataService();
    const strategy = createMockStrategy('TestStrategy');

    const mockCircuitBreaker = {
      evaluate: vi.fn(),
      shouldRejectEntry: vi.fn().mockReturnValue(true),
      getRejectionReason: vi.fn().mockReturnValue('Drawdown exceeded 15%'),
    };

    const mockTierEngine = {
      calculateTotalPortfolioValue: vi.fn().mockReturnValue({ totalValueUsd: 1000, hasStalePrices: false }),
    };

    const runner = new StrategyRunner({
      strategies: [strategy],
      marketDataService: mockMds,
      actionQueue: createMockActionQueue(),
      tickIntervalMs: 5000,
      circuitBreaker: mockCircuitBreaker as unknown as import('../../risk/circuit-breaker.js').DrawdownCircuitBreaker,
      portfolioTierEngine: mockTierEngine as unknown as import('../../risk/portfolio-tier-engine.js').PortfolioTierEngine,
    });

    await (runner as unknown as { controlTask: () => Promise<void> }).controlTask();

    // Strategy should NOT be evaluated
    expect(strategy.onLoopStart).not.toHaveBeenCalled();
    expect(mockCircuitBreaker.evaluate).toHaveBeenCalledWith(1000);
  });

  it('generates decision report when strategy produces actions', async () => {
    const mockMds = createMockMarketDataService();
    const strategy = createMockStrategy('TestStrategy');
    (strategy.shouldExecute as ReturnType<typeof vi.fn>).mockReturnValue({
      direction: 'long',
      strength: 0.8,
    });
    (strategy.buildExecution as ReturnType<typeof vi.fn>).mockReturnValue({
      actions: [{ type: 'swap', id: '1' }],
    });

    const mockReporter = {
      generateReport: vi.fn().mockResolvedValue({ id: 'report-1' }),
    };

    const queue = createMockActionQueue();
    const runner = new StrategyRunner({
      strategies: [strategy],
      marketDataService: mockMds,
      actionQueue: queue,
      tickIntervalMs: 5000,
      decisionReporter: mockReporter as unknown as import('../../ai/decision-reporter.js').DecisionReporter,
    });

    await (runner as unknown as { controlTask: () => Promise<void> }).controlTask();

    // Action should be enqueued
    expect(queue.enqueue).toHaveBeenCalled();

    // Decision reporter should be called (fire-and-forget, give it a tick)
    await new Promise((r) => setTimeout(r, 50));
    expect(mockReporter.generateReport).toHaveBeenCalledWith(
      'TestStrategy',
      expect.objectContaining({ regime: 'crab' }),
    );
  });
});
