import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TripleBarrierEngine } from '../triple-barrier.js';
import type { BarrierPosition, CustomStoplossHook } from '../triple-barrier.js';
import type { BarrierConfig } from '../types.js';
import { chainId, tokenAddress } from '../../core/types.js';

describe('TripleBarrierEngine', () => {
  let engine: TripleBarrierEngine;

  const makePosition = (overrides?: Partial<BarrierPosition>): BarrierPosition => ({
    id: 'pos-1',
    strategyId: 'yield-hunter',
    chainId: chainId(1),
    tokenAddress: tokenAddress('0x' + 'a'.repeat(40)),
    entryPrice: 100,
    currentPrice: 100,
    amount: 1000000000000000000n,
    enteredAt: Date.now() - 60_000, // 1 minute ago
    pnlUsd: 0,
    pnlPercent: 0,
    ...overrides,
  });

  const defaultConfig: BarrierConfig = {
    stopLoss: -0.10, // -10%
    takeProfit: 0.15, // +15%
    timeLimit: 3600, // 1 hour
  };

  beforeEach(() => {
    engine = new TripleBarrierEngine();
  });

  // --- Stop-loss ---

  describe('stop-loss', () => {
    it('triggers close when loss exceeds threshold', () => {
      const position = makePosition({ entryPrice: 100, currentPrice: 100 });
      const result = engine.evaluate(position, 89, defaultConfig);

      expect(result.type).toBe('close');
      if (result.type === 'close') {
        expect(result.reason).toBe('stop-loss');
        expect(result.details).toContain('Stop-loss triggered');
      }
    });

    it('holds when loss is within threshold', () => {
      const position = makePosition({ entryPrice: 100, currentPrice: 100 });
      const result = engine.evaluate(position, 95, defaultConfig);
      expect(result.type).toBe('hold');
    });

    it('triggers close at exact threshold', () => {
      const position = makePosition({ entryPrice: 100, currentPrice: 100 });
      const result = engine.evaluate(position, 90, defaultConfig);
      expect(result.type).toBe('close');
      if (result.type === 'close') {
        expect(result.reason).toBe('stop-loss');
      }
    });
  });

  // --- Take-profit ---

  describe('take-profit', () => {
    it('triggers close when profit exceeds threshold', () => {
      const position = makePosition({ entryPrice: 100, currentPrice: 100 });
      const result = engine.evaluate(position, 120, defaultConfig);

      expect(result.type).toBe('close');
      if (result.type === 'close') {
        expect(result.reason).toBe('take-profit');
        expect(result.details).toContain('Take-profit triggered');
      }
    });

    it('holds when profit is within threshold', () => {
      const position = makePosition({ entryPrice: 100, currentPrice: 100 });
      const result = engine.evaluate(position, 110, defaultConfig);
      expect(result.type).toBe('hold');
    });

    it('triggers close at exact threshold', () => {
      const position = makePosition({ entryPrice: 100, currentPrice: 100 });
      const result = engine.evaluate(position, 115, defaultConfig);
      expect(result.type).toBe('close');
      if (result.type === 'close') {
        expect(result.reason).toBe('take-profit');
      }
    });
  });

  // --- Time-limit ---

  describe('time-limit', () => {
    it('triggers close when duration exceeds limit', () => {
      const position = makePosition({
        entryPrice: 100,
        currentPrice: 100,
        enteredAt: Date.now() - 7200_000, // 2 hours ago
      });
      const result = engine.evaluate(position, 105, defaultConfig);

      expect(result.type).toBe('close');
      if (result.type === 'close') {
        expect(result.reason).toBe('time-limit');
        expect(result.details).toContain('Time-limit triggered');
      }
    });

    it('holds when duration is within limit', () => {
      const position = makePosition({
        entryPrice: 100,
        currentPrice: 100,
        enteredAt: Date.now() - 1800_000, // 30 minutes ago
      });
      const result = engine.evaluate(position, 105, defaultConfig);
      expect(result.type).toBe('hold');
    });
  });

  // --- Custom stoploss ---

  describe('custom stoploss', () => {
    it('overrides declarative stoploss when non-null', () => {
      const position = makePosition({ entryPrice: 100, currentPrice: 100 });
      // Custom stoploss at -5% (tighter than default -10%)
      const customSL: CustomStoplossHook = () => -0.05;

      const result = engine.evaluate(position, 94, defaultConfig, customSL);

      expect(result.type).toBe('close');
      if (result.type === 'close') {
        expect(result.reason).toBe('custom-stoploss');
      }
    });

    it('falls through to declarative stoploss when returning null', () => {
      const position = makePosition({ entryPrice: 100, currentPrice: 100 });
      const customSL: CustomStoplossHook = () => null;

      // Price at -6%: within declarative -10% but would have triggered custom -5%
      const result = engine.evaluate(position, 94, defaultConfig, customSL);

      // With null, falls to declarative -10%, so -6% holds
      expect(result.type).toBe('hold');
    });

    it('does not trigger when custom stoploss is not breached', () => {
      const position = makePosition({ entryPrice: 100, currentPrice: 100 });
      const customSL: CustomStoplossHook = () => -0.05;

      // Price at -3%, within custom -5% threshold
      const result = engine.evaluate(position, 97, defaultConfig, customSL);
      expect(result.type).toBe('hold');
    });
  });

  // --- Trailing stop ---

  describe('trailing stop', () => {
    const trailingConfig: BarrierConfig = {
      ...defaultConfig,
      trailingStop: {
        enabled: true,
        activationPrice: 110,
        trailingDelta: 0.05, // 5%
      },
    };

    it('does not activate before reaching activation price', () => {
      const position = makePosition({ entryPrice: 100, currentPrice: 100 });
      const result = engine.evaluate(position, 105, trailingConfig);
      expect(result.type).toBe('hold');
    });

    it('triggers close after activation when price drops below trailing level', () => {
      const position = makePosition({ entryPrice: 100, currentPrice: 100, highWaterMark: 120 });
      // Trailing stop level = 120 * (1 - 0.05) = 114
      // Current price 113 < 114 → trigger
      const result = engine.evaluate(position, 113, trailingConfig);

      expect(result.type).toBe('close');
      if (result.type === 'close') {
        expect(result.reason).toBe('trailing-stop');
        expect(result.details).toContain('Trailing stop triggered');
      }
    });

    it('holds when price is above trailing level', () => {
      const config: BarrierConfig = {
        ...trailingConfig,
        takeProfit: 0.30, // 30% to avoid TP triggering
      };
      const position = makePosition({ entryPrice: 100, currentPrice: 100, highWaterMark: 120 });
      // Trailing stop level = 120 * (1 - 0.05) = 114
      // Current price 116 > 114 → hold
      const result = engine.evaluate(position, 116, config);
      expect(result.type).toBe('hold');
    });

    it('ratchets high water mark upward only', () => {
      const position = makePosition({ entryPrice: 100, currentPrice: 100, highWaterMark: 115 });

      // Price goes higher → HWM should update
      engine.evaluate(position, 120, trailingConfig);
      expect(position.highWaterMark).toBe(120);

      // Price goes lower → HWM should not decrease
      engine.evaluate(position, 118, trailingConfig);
      expect(position.highWaterMark).toBe(120);
    });
  });

  // --- Stale data safety ---

  describe('stale data safety', () => {
    it('does not trigger false barrier breach on NaN price', () => {
      const position = makePosition({ entryPrice: 100, currentPrice: 100 });
      const result = engine.evaluate(position, NaN, defaultConfig);
      expect(result.type).toBe('hold');
    });

    it('does not trigger false barrier breach on zero price', () => {
      const position = makePosition({ entryPrice: 100, currentPrice: 100 });
      const result = engine.evaluate(position, 0, defaultConfig);
      expect(result.type).toBe('hold');
    });

    it('does not trigger false barrier breach on negative price', () => {
      const position = makePosition({ entryPrice: 100, currentPrice: 100 });
      const result = engine.evaluate(position, -10, defaultConfig);
      expect(result.type).toBe('hold');
    });

    it('does not trigger false barrier breach on Infinity price', () => {
      const position = makePosition({ entryPrice: 100, currentPrice: 100 });
      const result = engine.evaluate(position, Infinity, defaultConfig);
      expect(result.type).toBe('hold');
    });

    it('does not trigger false barrier breach on invalid entry price', () => {
      const position = makePosition({ entryPrice: 0, currentPrice: 100 });
      const result = engine.evaluate(position, 100, defaultConfig);
      expect(result.type).toBe('hold');
    });
  });

  // --- Volatility adjustment ---

  describe('adjustForVolatility', () => {
    it('scales SL and TP by volatility factor', () => {
      const adjusted = engine.adjustForVolatility(defaultConfig, 1.5);
      // SL: -0.10 * 1.5 = -0.15
      expect(adjusted.stopLoss).toBeCloseTo(-0.15);
      // TP: 0.15 * 1.5 = 0.225
      expect(adjusted.takeProfit).toBeCloseTo(0.225);
    });

    it('clamps SL to max -20%', () => {
      const adjusted = engine.adjustForVolatility(defaultConfig, 3.0);
      // SL: -0.10 * 3.0 = -0.30, clamped to -0.20
      expect(adjusted.stopLoss).toBe(-0.20);
    });

    it('clamps TP to min 0.5%', () => {
      const tightConfig: BarrierConfig = {
        ...defaultConfig,
        takeProfit: 0.002,
      };
      const adjusted = engine.adjustForVolatility(tightConfig, 1.0);
      // TP: 0.002 * 1.0 = 0.002, clamped to 0.005
      expect(adjusted.takeProfit).toBe(0.005);
    });

    it('preserves time limit and other config', () => {
      const adjusted = engine.adjustForVolatility(defaultConfig, 2.0);
      expect(adjusted.timeLimit).toBe(defaultConfig.timeLimit);
    });
  });

  // --- Error catch path ---

  describe('error catch safety', () => {
    it('returns hold when custom stoploss hook throws', () => {
      const position = makePosition({ entryPrice: 100, currentPrice: 100 });
      const throwingHook: CustomStoplossHook = () => {
        throw new Error('hook failed');
      };
      const result = engine.evaluate(position, 95, defaultConfig, throwingHook);
      expect(result.type).toBe('hold');
    });
  });

  // --- Priority order ---

  describe('exit evaluation priority order', () => {
    it('custom stoploss has higher priority than declarative stoploss', () => {
      // Both custom stoploss (-5%) and declarative stoploss (-10%) would trigger at -12%
      const position = makePosition({ entryPrice: 100, currentPrice: 100 });
      const customSL: CustomStoplossHook = () => -0.05;

      const result = engine.evaluate(position, 88, defaultConfig, customSL);

      expect(result.type).toBe('close');
      if (result.type === 'close') {
        // Custom stoploss should trigger first
        expect(result.reason).toBe('custom-stoploss');
      }
    });

    it('stop-loss has higher priority than take-profit when both could trigger', () => {
      // This shouldn't happen in practice but tests priority
      const config: BarrierConfig = {
        stopLoss: -0.01, // -1%
        takeProfit: -0.05, // Nonsensical but tests priority
        timeLimit: 3600,
      };
      const position = makePosition({ entryPrice: 100, currentPrice: 100 });
      const result = engine.evaluate(position, 98, config);

      expect(result.type).toBe('close');
      if (result.type === 'close') {
        expect(result.reason).toBe('stop-loss');
      }
    });

    it('trailing stop has lower priority than take-profit', () => {
      // Take-profit at +15%, trailing stop at +12% activation with 5% delta
      const config: BarrierConfig = {
        ...defaultConfig,
        trailingStop: {
          enabled: true,
          activationPrice: 112,
          trailingDelta: 0.05,
        },
      };
      const position = makePosition({
        entryPrice: 100,
        currentPrice: 100,
        highWaterMark: 120,
      });
      // Price at 115 → +15% → take-profit triggers before trailing stop
      const result = engine.evaluate(position, 115, config);

      expect(result.type).toBe('close');
      if (result.type === 'close') {
        expect(result.reason).toBe('take-profit');
      }
    });
  });
});
