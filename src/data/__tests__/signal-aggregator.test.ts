import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SignalAggregator } from '../signal-aggregator.js';
import { TechnicalEvaluator } from '../evaluators/technical-evaluator.js';
import { DEFAULT_WEIGHTS, DEFAULT_THRESHOLDS } from '../signal-types.js';
import type { Evaluator, EvaluatorContext, EvaluatorScore, EvaluatorWeightConfig } from '../signal-types.js';
import type { StrategyContext } from '../../core/types.js';

function makeEvaluator(name: string, score: number, confidence: number): Evaluator {
  return {
    name,
    description: `Test evaluator: ${name}`,
    evaluate: vi.fn().mockResolvedValue({
      score,
      confidence,
      reasoning: `${name} score: ${score}`,
      components: [{ name: `${name}_main`, score, weight: 1, detail: 'test' }],
    } satisfies EvaluatorScore),
  };
}

function makeFailingEvaluator(name: string): Evaluator {
  return {
    name,
    description: `Failing evaluator: ${name}`,
    evaluate: vi.fn().mockRejectedValue(new Error(`${name} failed`)),
  };
}

function makeContext(token = 'ETH'): EvaluatorContext {
  return {
    token,
    tokenAddress: null,
    chainId: null,
    timestamp: Date.now(),
    strategyContext: {
      timestamp: Date.now(),
      balances: new Map(),
      positions: [],
      prices: new Map(),
      activeTransfers: [],
    } as StrategyContext,
  };
}

describe('SignalAggregator', () => {
  describe('initialization', () => {
    it('creates with default weights and no evaluators', () => {
      const agg = new SignalAggregator();
      expect(agg.getRegisteredEvaluators().length).toBe(0);
    });

    it('creates with initial evaluators', () => {
      const ev1 = makeEvaluator('test1', 0.5, 0.8);
      const ev2 = makeEvaluator('test2', -0.3, 0.6);
      const agg = new SignalAggregator(DEFAULT_WEIGHTS, [ev1, ev2]);
      expect(agg.getRegisteredEvaluators().length).toBe(2);
    });
  });

  describe('evaluator registration', () => {
    it('registers and unregisters evaluators', () => {
      const agg = new SignalAggregator();
      const ev = makeEvaluator('test', 0.5, 0.8);

      agg.registerEvaluator(ev);
      expect(agg.getRegisteredEvaluators().length).toBe(1);

      agg.unregisterEvaluator('test');
      expect(agg.getRegisteredEvaluators().length).toBe(0);
    });

    it('replaces evaluator with same name', () => {
      const agg = new SignalAggregator();
      agg.registerEvaluator(makeEvaluator('test', 0.5, 0.8));
      agg.registerEvaluator(makeEvaluator('test', 0.9, 1.0));
      expect(agg.getRegisteredEvaluators().length).toBe(1);
    });
  });

  describe('composite score calculation', () => {
    it('computes weighted average with known inputs', async () => {
      const agg = new SignalAggregator({
        onchain: 0.25,
        market: 0.30,
        social: 0.20,
        technical: 0.25,
      }, [
        makeEvaluator('onchain', 0.8, 0.9),
        makeEvaluator('market', 0.6, 0.8),
        makeEvaluator('social', -0.2, 0.7),
        makeEvaluator('technical', 0.4, 0.85),
      ]);

      const result = await agg.evaluate(makeContext());

      // Expected: (0.8*0.25 + 0.6*0.30 + (-0.2)*0.20 + 0.4*0.25) / (0.25+0.30+0.20+0.25)
      // = (0.2 + 0.18 - 0.04 + 0.1) / 1.0 = 0.44
      expect(result.overallScore).toBeCloseTo(0.44, 2);
      expect(result.recommendation).toBe('buy'); // 0.44 >= 0.2
      expect(result.evaluatorBreakdown.length).toBe(4);
      expect(result.token).toBe('ETH');
    });

    it('applies weight overrides over defaults', async () => {
      const agg = new SignalAggregator({ a: 0.5, b: 0.5 }, [
        makeEvaluator('a', 1.0, 1.0),
        makeEvaluator('b', -1.0, 1.0),
      ]);

      // With equal weights: (1*0.5 + (-1)*0.5) / 1.0 = 0.0
      const defaultResult = await agg.evaluate(makeContext());
      expect(defaultResult.overallScore).toBeCloseTo(0.0, 2);

      // With override: heavily weight 'a'
      const overrideResult = await agg.evaluate(makeContext(), { a: 0.9, b: 0.1 });
      // (1*0.9 + (-1)*0.1) / 1.0 = 0.8
      expect(overrideResult.overallScore).toBeCloseTo(0.8, 2);
    });

    it('clamps composite score to [-1, +1]', async () => {
      const agg = new SignalAggregator({ extreme: 1.0 }, [
        makeEvaluator('extreme', 1.0, 1.0),
      ]);

      const result = await agg.evaluate(makeContext());
      expect(result.overallScore).toBeLessThanOrEqual(1);
      expect(result.overallScore).toBeGreaterThanOrEqual(-1);
    });
  });

  describe('failed evaluator handling', () => {
    it('excludes failed evaluator and applies confidence penalty', async () => {
      const agg = new SignalAggregator({ good: 0.5, bad: 0.5 }, [
        makeEvaluator('good', 0.8, 1.0),
        makeFailingEvaluator('bad'),
      ]);

      const result = await agg.evaluate(makeContext());
      // Only 'good' contributes: score = 0.8
      expect(result.overallScore).toBeCloseTo(0.8, 2);
      // Confidence penalized: (1.0 * 0.5) / 0.5 * (1/2) = 0.5
      expect(result.aggregateConfidence).toBeLessThan(1.0);
      // Breakdown includes both
      expect(result.evaluatorBreakdown.length).toBe(2);
      expect(result.evaluatorBreakdown[1]!.reasoning).toContain('Failed');
    });

    it('returns neutral when all evaluators fail', async () => {
      const agg = new SignalAggregator({}, [
        makeFailingEvaluator('fail1'),
        makeFailingEvaluator('fail2'),
      ]);

      const result = await agg.evaluate(makeContext());
      expect(result.overallScore).toBe(0);
      expect(result.aggregateConfidence).toBe(0);
      expect(result.recommendation).toBe('neutral');
    });

    it('returns neutral when no evaluators registered', async () => {
      const agg = new SignalAggregator();
      const result = await agg.evaluate(makeContext());
      expect(result.overallScore).toBe(0);
      expect(result.aggregateConfidence).toBe(0);
      expect(result.recommendation).toBe('neutral');
    });
  });

  describe('recommendation thresholds', () => {
    it('maps scores to correct recommendations', () => {
      const agg = new SignalAggregator();

      expect(agg.getRecommendation(0.8)).toBe('strong_buy');
      expect(agg.getRecommendation(0.6)).toBe('strong_buy');
      expect(agg.getRecommendation(0.4)).toBe('buy');
      expect(agg.getRecommendation(0.2)).toBe('buy');
      expect(agg.getRecommendation(0.0)).toBe('neutral');
      expect(agg.getRecommendation(-0.1)).toBe('neutral');
      expect(agg.getRecommendation(-0.3)).toBe('sell');
      expect(agg.getRecommendation(-0.5)).toBe('sell');
      expect(agg.getRecommendation(-0.6)).toBe('strong_sell');
      expect(agg.getRecommendation(-0.9)).toBe('strong_sell');
    });

    it('supports custom thresholds', () => {
      const agg = new SignalAggregator();
      const custom = { strongBuy: 0.8, buy: 0.3, sell: -0.3, strongSell: -0.8 };

      expect(agg.getRecommendation(0.5, custom)).toBe('buy');
      expect(agg.getRecommendation(0.9, custom)).toBe('strong_buy');
      expect(agg.getRecommendation(-0.5, custom)).toBe('sell');
    });
  });

  describe('composite score includes breakdown', () => {
    it('includes per-evaluator breakdown entries', async () => {
      const agg = new SignalAggregator(DEFAULT_WEIGHTS, [
        makeEvaluator('onchain', 0.5, 0.8),
        makeEvaluator('market', 0.3, 0.9),
      ]);

      const result = await agg.evaluate(makeContext());
      expect(result.evaluatorBreakdown.length).toBe(2);

      const onchainEntry = result.evaluatorBreakdown.find(e => e.evaluatorName === 'onchain');
      expect(onchainEntry).toBeDefined();
      expect(onchainEntry!.score).toBe(0.5);
      expect(onchainEntry!.confidence).toBe(0.8);
      expect(onchainEntry!.weight).toBe(0.25);
    });
  });
});

describe('TechnicalEvaluator', () => {
  describe('RSI calculation', () => {
    it('returns oversold (< 30) as positive score', () => {
      // Generate prices that create oversold RSI
      const prices = Array.from({ length: 20 }, (_, i) => 100 - i * 2); // steady decline
      const rsi = TechnicalEvaluator.calculateRSI(prices, 14);
      expect(rsi).not.toBeNull();
      expect(rsi!).toBeLessThan(30);
    });

    it('returns overbought (> 70) as negative score', () => {
      // Generate prices that create overbought RSI
      const prices = Array.from({ length: 20 }, (_, i) => 50 + i * 2); // steady rise
      const rsi = TechnicalEvaluator.calculateRSI(prices, 14);
      expect(rsi).not.toBeNull();
      expect(rsi!).toBeGreaterThan(70);
    });

    it('returns null with insufficient data', () => {
      expect(TechnicalEvaluator.calculateRSI([1, 2, 3], 14)).toBeNull();
    });
  });

  describe('MACD calculation', () => {
    it('returns bullish histogram for uptrending prices', () => {
      const prices = Array.from({ length: 30 }, (_, i) => 100 + i * 2);
      const macd = TechnicalEvaluator.calculateMACD(prices);
      expect(macd).not.toBeNull();
      expect(macd!.macd).toBeGreaterThan(0); // EMA12 > EMA26 in uptrend
    });

    it('returns bearish histogram for downtrending prices', () => {
      const prices = Array.from({ length: 30 }, (_, i) => 200 - i * 2);
      const macd = TechnicalEvaluator.calculateMACD(prices);
      expect(macd).not.toBeNull();
      expect(macd!.macd).toBeLessThan(0); // EMA12 < EMA26 in downtrend
    });

    it('returns null with insufficient data', () => {
      expect(TechnicalEvaluator.calculateMACD([1, 2, 3])).toBeNull();
    });
  });

  describe('Bollinger Bands', () => {
    it('calculates upper/middle/lower correctly', () => {
      const prices = Array.from({ length: 20 }, () => 100);
      const bb = TechnicalEvaluator.calculateBollinger(prices, 20, 2);
      expect(bb).not.toBeNull();
      expect(bb!.middle).toBe(100);
      expect(bb!.upper).toBe(100); // no variance = no band width
      expect(bb!.lower).toBe(100);
    });

    it('price below lower band scores positive (oversold)', () => {
      // Flat prices then sudden drop
      const prices = [...Array.from({ length: 19 }, () => 100), 80];
      const bb = TechnicalEvaluator.calculateBollinger(prices, 20, 2);
      expect(bb).not.toBeNull();
      expect(bb!.lower).toBeGreaterThan(80); // price is below lower band
    });

    it('returns null with insufficient data', () => {
      expect(TechnicalEvaluator.calculateBollinger([1, 2], 20, 2)).toBeNull();
    });
  });

  describe('MA alignment', () => {
    it('ascending MAs (20 > 50 > 200) = bullish', () => {
      // Long uptrend
      const prices = Array.from({ length: 250 }, (_, i) => 100 + i);
      const ma20 = TechnicalEvaluator.sma(prices, 20);
      const ma50 = TechnicalEvaluator.sma(prices, 50);
      const ma200 = TechnicalEvaluator.sma(prices, 200);

      expect(ma20).toBeGreaterThan(ma50);
      expect(ma50).toBeGreaterThan(ma200);
    });

    it('descending MAs (20 < 50 < 200) = bearish', () => {
      // Long downtrend
      const prices = Array.from({ length: 250 }, (_, i) => 400 - i);
      const ma20 = TechnicalEvaluator.sma(prices, 20);
      const ma50 = TechnicalEvaluator.sma(prices, 50);
      const ma200 = TechnicalEvaluator.sma(prices, 200);

      expect(ma20).toBeLessThan(ma50);
      expect(ma50).toBeLessThan(ma200);
    });
  });

  describe('insufficient data handling', () => {
    it('returns low confidence with < 14 bars', async () => {
      const marketData = {} as any;
      const evaluator = new TechnicalEvaluator(marketData);
      evaluator.getPriceHistory = vi.fn().mockReturnValue([1, 2, 3, 4, 5]);

      // Supply tokenAddress so we reach the insufficient-data branch, not the no-tokenAddress early return
      const ctx = makeContext();
      const ctxWithAddress = { ...ctx, tokenAddress: '0xabc' as any };
      const result = await evaluator.evaluate(ctxWithAddress);
      expect(result.score).toBe(0);
      expect(result.confidence).toBeLessThanOrEqual(0.1);
      expect(result.reasoning).toContain('Insufficient data');
    });
  });

  describe('EMA calculation', () => {
    it('computes EMA correctly', () => {
      const prices = [10, 11, 12, 11, 13, 14, 13, 15, 16, 14];
      const ema5 = TechnicalEvaluator.ema(prices, 5);
      expect(ema5).not.toBeNull();
      expect(ema5!).toBeGreaterThan(0);
    });

    it('returns null with insufficient data', () => {
      expect(TechnicalEvaluator.ema([1, 2], 5)).toBeNull();
    });
  });
});
