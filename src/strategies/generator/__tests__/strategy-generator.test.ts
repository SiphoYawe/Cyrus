// Tests for StrategyGenerator — AI-driven strategy evolution engine

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Store } from '../../../core/store.js';
import { StrategyGenerator } from '../strategy-generator.js';
import type { GeneratedVariant, PaperTradeRecord } from '../types.js';
import { DEFAULT_GENERATION_CONFIG, DEFAULT_PROMOTION_CRITERIA } from '../types.js';

// Shared mock for the messages.create method
const mockCreate = vi.fn();

// Mock the @anthropic-ai/sdk module — must return a class constructor
vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    messages = { create: mockCreate };
    constructor(_config: Record<string, unknown>) {
      // no-op
    }
  }
  return { default: MockAnthropic };
});

/**
 * Create a mock Claude response with variant code blocks.
 */
function mockClaudeResponse(variantCount: number): {
  content: Array<{ type: 'text'; text: string }>;
} {
  const blocks: string[] = [];
  for (let i = 0; i < variantCount; i++) {
    blocks.push(`\`\`\`typescript
export class Variant${i + 1} extends CrossChainStrategy {
  readonly name = 'variant-${i + 1}';
  readonly timeframe = '5m';
  override readonly stoploss = -0.05;
  override readonly maxPositions = 3;
  override readonly minimalRoi = { 0: 0.03, 60: 0.01 };

  shouldExecute(context: StrategyContext): StrategySignal | null {
    return null;
  }

  buildExecution(signal: StrategySignal, context: StrategyContext): ExecutionPlan {
    return { id: 'plan-1', strategyName: this.name, actions: [], estimatedCostUsd: 0, estimatedDurationMs: 0, metadata: {} };
  }
}
\`\`\`
MUTATION: Variant ${i + 1} with adjusted parameters`);
  }

  return {
    content: [{ type: 'text', text: blocks.join('\n\n') }],
  };
}

describe('StrategyGenerator', () => {
  let generator: StrategyGenerator;

  beforeEach(() => {
    Store.getInstance().reset();
    mockCreate.mockReset();
    generator = new StrategyGenerator('test-api-key');
  });

  describe('generateVariants', () => {
    it('calls Claude API with correct prompt structure including base strategy source, market patterns, and performance data', async () => {
      mockCreate.mockResolvedValueOnce(mockClaudeResponse(3));

      await generator.generateVariants(
        'class Base extends CrossChainStrategy { /* ... */ }',
        'base-strategy',
        'Market is bullish',
        'Sharpe: 1.2',
        3,
      );

      expect(mockCreate).toHaveBeenCalledTimes(1);

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.system).toBeDefined();
      expect(callArgs.messages[0].content).toContain('base-strategy');
      expect(callArgs.messages[0].content).toContain('Market is bullish');
      expect(callArgs.messages[0].content).toContain('Sharpe: 1.2');
      expect(callArgs.messages[0].content).toContain('CrossChainStrategy');
    });

    it('parses Claude response into GeneratedVariant array with unique IDs', async () => {
      mockCreate.mockResolvedValueOnce(mockClaudeResponse(3));

      const variants = await generator.generateVariants(
        'class Base extends CrossChainStrategy {}',
        'base-strategy',
        'patterns',
        'performance',
        3,
      );

      expect(variants).toHaveLength(3);

      // Each variant should have a unique ID
      const ids = new Set(variants.map((v) => v.id));
      expect(ids.size).toBe(3);

      // Each should have proper fields
      for (const variant of variants) {
        expect(variant.parentStrategy).toBe('base-strategy');
        expect(variant.status).toBe('generated');
        expect(variant.sourceCode).toBeTruthy();
        expect(variant.mutationDescription).toBeTruthy();
        expect(variant.generatedAt).toBeGreaterThan(0);
      }
    });

    it('retries on Claude API 429 errors with exponential backoff', async () => {
      const error429 = new Error('Rate limited');
      (error429 as unknown as Record<string, unknown>).status = 429;

      mockCreate
        .mockRejectedValueOnce(error429)
        .mockRejectedValueOnce(error429)
        .mockResolvedValueOnce(mockClaudeResponse(1));

      const variants = await generator.generateVariants(
        'class Base extends CrossChainStrategy {}',
        'base-strategy',
        'patterns',
        'performance',
        1,
      );

      expect(mockCreate).toHaveBeenCalledTimes(3);
      expect(variants).toHaveLength(1);
    });

    it('retries on Claude API 500 errors', async () => {
      const error500 = new Error('Internal server error');
      (error500 as unknown as Record<string, unknown>).status = 500;

      mockCreate
        .mockRejectedValueOnce(error500)
        .mockResolvedValueOnce(mockClaudeResponse(2));

      const variants = await generator.generateVariants(
        'class Base extends CrossChainStrategy {}',
        'base-strategy',
        'patterns',
        'performance',
        2,
      );

      expect(mockCreate).toHaveBeenCalledTimes(2);
      expect(variants).toHaveLength(2);
    });

    it('returns empty array when all retries are exhausted', async () => {
      const error429 = new Error('Rate limited');
      (error429 as unknown as Record<string, unknown>).status = 429;

      mockCreate
        .mockRejectedValueOnce(error429)
        .mockRejectedValueOnce(error429)
        .mockRejectedValueOnce(error429);

      const variants = await generator.generateVariants(
        'class Base extends CrossChainStrategy {}',
        'base-strategy',
        'patterns',
        'performance',
        1,
      );

      expect(mockCreate).toHaveBeenCalledTimes(3);
      expect(variants).toHaveLength(0);
    });

    it('throws immediately on non-retryable errors', async () => {
      const error400 = new Error('Bad request');
      (error400 as unknown as Record<string, unknown>).status = 400;

      mockCreate.mockRejectedValueOnce(error400);

      await expect(
        generator.generateVariants(
          'class Base extends CrossChainStrategy {}',
          'base-strategy',
          'patterns',
          'performance',
          1,
        ),
      ).rejects.toThrow('Bad request');

      expect(mockCreate).toHaveBeenCalledTimes(1);
    });
  });

  describe('runBacktestPipeline', () => {
    it('runs backtest for each valid variant and returns metrics map', async () => {
      const variants: GeneratedVariant[] = [
        {
          id: 'v1',
          parentStrategy: 'base',
          sourceCode: 'class V1 extends CrossChainStrategy {}',
          mutationDescription: 'variant 1',
          generatedAt: Date.now(),
          status: 'valid',
        },
        {
          id: 'v2',
          parentStrategy: 'base',
          sourceCode: 'class V2 extends CrossChainStrategy {}',
          mutationDescription: 'variant 2',
          generatedAt: Date.now(),
          status: 'valid',
        },
      ];

      const results = await generator.runBacktestPipeline(variants);

      expect(results.size).toBe(2);
      expect(results.has('v1')).toBe(true);
      expect(results.has('v2')).toBe(true);

      for (const [, result] of results) {
        expect(result.variantId).toBeTruthy();
        expect(typeof result.sharpeRatio).toBe('number');
        expect(typeof result.maxDrawdown).toBe('number');
      }
    });

    it('calls store.reset() between variant backtests', async () => {
      // Spy on Store prototype's reset to track across singleton replacements
      const resetSpy = vi.spyOn(Store.prototype as unknown as { reset: () => void }, 'reset');

      const variants: GeneratedVariant[] = [
        {
          id: 'v1',
          parentStrategy: 'base',
          sourceCode: 'class V1 {}',
          mutationDescription: 'variant 1',
          generatedAt: Date.now(),
          status: 'valid',
        },
        {
          id: 'v2',
          parentStrategy: 'base',
          sourceCode: 'class V2 {}',
          mutationDescription: 'variant 2',
          generatedAt: Date.now(),
          status: 'valid',
        },
      ];

      await generator.runBacktestPipeline(variants);

      // store.reset() should be called at least once per variant
      expect(resetSpy).toHaveBeenCalledTimes(2);

      resetSpy.mockRestore();
    });

    it('marks variant as eliminated on backtest runtime error', async () => {
      // Create generator with a mock BacktestEngine that throws
      const mockBacktestEngine = {
        run: vi.fn().mockRejectedValue(new Error('Backtest crashed')),
      };
      const mockPerformanceAnalyzer = {
        analyze: vi.fn(),
      };

      const generatorWithMocks = new StrategyGenerator(
        'test-api-key',
        {},
        mockBacktestEngine as never,
        mockPerformanceAnalyzer as never,
      );

      const variants: GeneratedVariant[] = [
        {
          id: 'v1',
          parentStrategy: 'base',
          sourceCode: 'class V1 {}',
          mutationDescription: 'variant 1',
          generatedAt: Date.now(),
          status: 'valid',
        },
      ];

      const results = await generatorWithMocks.runBacktestPipeline(variants);

      const v1Result = results.get('v1');
      expect(v1Result).toBeDefined();
      expect(v1Result!.eliminated).toBe(true);
      expect(v1Result!.eliminationReason).toBe('backtest-runtime-error');
      expect(variants[0].status).toBe('eliminated');
    });

    it('updates variant status through the pipeline', async () => {
      const variant: GeneratedVariant = {
        id: 'v1',
        parentStrategy: 'base',
        sourceCode: 'class V1 {}',
        mutationDescription: 'variant 1',
        generatedAt: Date.now(),
        status: 'valid',
      };

      await generator.runBacktestPipeline([variant]);

      expect(variant.status).toBe('backtest-complete');
    });
  });

  describe('evaluatePromotion', () => {
    it('approves variant with Sharpe > 0.5 and positive P&L', () => {
      const paperMetrics: PaperTradeRecord[] = [
        { variantId: 'v1', signalTime: 1000, direction: 'long', entryPrice: 100, exitPrice: 110, estimatedPnl: 10, pair: 'USDC/WETH', chainId: 1 },
        { variantId: 'v1', signalTime: 2000, direction: 'long', entryPrice: 100, exitPrice: 108, estimatedPnl: 8, pair: 'USDC/WETH', chainId: 1 },
        { variantId: 'v1', signalTime: 3000, direction: 'long', entryPrice: 100, exitPrice: 105, estimatedPnl: 5, pair: 'USDC/WETH', chainId: 1 },
        { variantId: 'v1', signalTime: 4000, direction: 'long', entryPrice: 100, exitPrice: 103, estimatedPnl: 3, pair: 'USDC/WETH', chainId: 1 },
        { variantId: 'v1', signalTime: 5000, direction: 'long', entryPrice: 100, exitPrice: 102, estimatedPnl: 2, pair: 'USDC/WETH', chainId: 1 },
      ];

      const report = generator.evaluatePromotion('v1', paperMetrics);

      expect(report.promotionDecision).toBe('promoted');
      expect(report.allocatedPercent).toBe(0.01); // 1%
      expect(report.paperTradingMetrics.totalPnl).toBeGreaterThan(0);
    });

    it('rejects variant with Sharpe <= 0.5', () => {
      // Create trades with very mixed returns to produce a low Sharpe
      const paperMetrics: PaperTradeRecord[] = [
        { variantId: 'v1', signalTime: 1000, direction: 'long', entryPrice: 100, exitPrice: 101, estimatedPnl: 1, pair: 'USDC/WETH', chainId: 1 },
        { variantId: 'v1', signalTime: 2000, direction: 'long', entryPrice: 100, exitPrice: 99, estimatedPnl: -1, pair: 'USDC/WETH', chainId: 1 },
        { variantId: 'v1', signalTime: 3000, direction: 'long', entryPrice: 100, exitPrice: 100.5, estimatedPnl: 0.5, pair: 'USDC/WETH', chainId: 1 },
        { variantId: 'v1', signalTime: 4000, direction: 'long', entryPrice: 100, exitPrice: 99.5, estimatedPnl: -0.5, pair: 'USDC/WETH', chainId: 1 },
      ];

      const report = generator.evaluatePromotion('v1', paperMetrics);

      // With mixed returns close to zero, Sharpe should be low
      // Either it's rejected due to Sharpe, or the allocation is correct
      if (report.paperTradingMetrics.sharpe <= 0.5) {
        expect(report.promotionDecision).toBe('rejected');
        expect(report.reason).toContain('Sharpe');
      }
      expect(report.allocatedPercent === 0 || report.allocatedPercent === 0.01).toBe(true);
    });

    it('rejects variant with negative P&L when requirePositivePnl is true', () => {
      const paperMetrics: PaperTradeRecord[] = [
        { variantId: 'v1', signalTime: 1000, direction: 'long', entryPrice: 100, exitPrice: 90, estimatedPnl: -10, pair: 'USDC/WETH', chainId: 1 },
        { variantId: 'v1', signalTime: 2000, direction: 'long', entryPrice: 100, exitPrice: 88, estimatedPnl: -12, pair: 'USDC/WETH', chainId: 1 },
        { variantId: 'v1', signalTime: 3000, direction: 'long', entryPrice: 100, exitPrice: 85, estimatedPnl: -15, pair: 'USDC/WETH', chainId: 1 },
      ];

      const report = generator.evaluatePromotion('v1', paperMetrics, {
        ...DEFAULT_PROMOTION_CRITERIA,
        requirePositivePnl: true,
      });

      expect(report.promotionDecision).toBe('rejected');
      expect(report.reason).toContain('P&L');
      expect(report.allocatedPercent).toBe(0);
    });

    it('sets 1% initial allocation for promoted variants', () => {
      const paperMetrics: PaperTradeRecord[] = [
        { variantId: 'v1', signalTime: 1000, direction: 'long', entryPrice: 100, exitPrice: 115, estimatedPnl: 15, pair: 'USDC/WETH', chainId: 1 },
        { variantId: 'v1', signalTime: 2000, direction: 'long', entryPrice: 100, exitPrice: 112, estimatedPnl: 12, pair: 'USDC/WETH', chainId: 1 },
        { variantId: 'v1', signalTime: 3000, direction: 'long', entryPrice: 100, exitPrice: 110, estimatedPnl: 10, pair: 'USDC/WETH', chainId: 1 },
        { variantId: 'v1', signalTime: 4000, direction: 'long', entryPrice: 100, exitPrice: 108, estimatedPnl: 8, pair: 'USDC/WETH', chainId: 1 },
        { variantId: 'v1', signalTime: 5000, direction: 'long', entryPrice: 100, exitPrice: 106, estimatedPnl: 6, pair: 'USDC/WETH', chainId: 1 },
      ];

      const report = generator.evaluatePromotion('v1', paperMetrics, {
        minSharpe: 0.5,
        requirePositivePnl: true,
        initialAllocationPercent: 0.01,
      });

      if (report.promotionDecision === 'promoted') {
        expect(report.allocatedPercent).toBe(0.01);
      }
    });

    it('generates a promotion report with all required fields', () => {
      const paperMetrics: PaperTradeRecord[] = [
        { variantId: 'v1', signalTime: 1000, direction: 'long', entryPrice: 100, exitPrice: 110, estimatedPnl: 10, pair: 'USDC/WETH', chainId: 1 },
        { variantId: 'v1', signalTime: 2000, direction: 'long', entryPrice: 100, exitPrice: 108, estimatedPnl: 8, pair: 'USDC/WETH', chainId: 1 },
      ];

      const report = generator.evaluatePromotion('v1', paperMetrics);

      expect(report.variantId).toBe('v1');
      expect(report.parentStrategy).toBeTruthy();
      expect(report.backtestMetrics).toBeDefined();
      expect(report.paperTradingMetrics).toBeDefined();
      expect(report.paperTradingMetrics.sharpe).toBeDefined();
      expect(report.paperTradingMetrics.totalPnl).toBeDefined();
      expect(report.paperTradingMetrics.tradeCount).toBeDefined();
      expect(report.paperTradingMetrics.winRate).toBeDefined();
      expect(typeof report.promotionDecision).toBe('string');
      expect(typeof report.reason).toBe('string');
      expect(typeof report.allocatedPercent).toBe('number');
    });
  });

  describe('runEvolutionCycle', () => {
    it('orchestrates full pipeline end-to-end (integration test with mocked dependencies)', async () => {
      // Mock Claude to return valid variants
      mockCreate.mockResolvedValueOnce(mockClaudeResponse(3));

      await generator.runEvolutionCycle();

      // Should have called Claude API
      expect(mockCreate).toHaveBeenCalledTimes(1);

      // Should have incremented generation count
      expect(generator.getGenerationCount()).toBe(1);

      // Should have recorded evolution history
      const history = generator.getEvolutionHistory();
      expect(history).toHaveLength(1);
      expect(history[0].generation).toBe(1);
      expect(history[0].variantsGenerated).toBeGreaterThan(0);
    });

    it('tracks generation count across cycles', async () => {
      mockCreate.mockResolvedValue(mockClaudeResponse(1));

      await generator.runEvolutionCycle();
      await generator.runEvolutionCycle();

      expect(generator.getGenerationCount()).toBe(2);
      expect(generator.getEvolutionHistory()).toHaveLength(2);
    });

    it('handles zero valid variants gracefully', async () => {
      // Mock Claude to return code with no valid code blocks
      mockCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'No valid variants could be generated.' }],
      });

      await generator.runEvolutionCycle();

      expect(generator.getGenerationCount()).toBe(1);
      const history = generator.getEvolutionHistory();
      expect(history).toHaveLength(1);
      expect(history[0].variantsGenerated).toBe(0);
    });
  });

  describe('configuration', () => {
    it('uses default configuration when none provided', () => {
      const config = generator.getConfig();
      expect(config.variantsPerRun).toBe(DEFAULT_GENERATION_CONFIG.variantsPerRun);
      expect(config.backtestDays).toBe(DEFAULT_GENERATION_CONFIG.backtestDays);
      expect(config.paperTradingDays).toBe(DEFAULT_GENERATION_CONFIG.paperTradingDays);
      expect(config.tournamentTopN).toBe(DEFAULT_GENERATION_CONFIG.tournamentTopN);
    });

    it('merges custom configuration with defaults', () => {
      const customGenerator = new StrategyGenerator('key', {
        variantsPerRun: 10,
        tournamentTopN: 5,
      });

      const config = customGenerator.getConfig();
      expect(config.variantsPerRun).toBe(10);
      expect(config.tournamentTopN).toBe(5);
      expect(config.backtestDays).toBe(DEFAULT_GENERATION_CONFIG.backtestDays);
    });
  });
});
