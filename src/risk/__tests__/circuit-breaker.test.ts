import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DrawdownCircuitBreaker } from '../circuit-breaker.js';
import type { CircuitBreakerCloseAction } from '../circuit-breaker.js';
import type { CircuitBreakerConfig, CircuitBreakerEvent, PortfolioTier } from '../types.js';
import type { Position } from '../../core/types.js';
import { chainId, tokenAddress } from '../../core/types.js';

describe('DrawdownCircuitBreaker', () => {
  const defaultConfig: CircuitBreakerConfig = {
    activationThreshold: -0.10, // -10%
    resetThreshold: -0.05, // -5%
    aggressiveMode: false,
    enabled: true,
  };

  const makePosition = (overrides?: Partial<Position> & { tier?: PortfolioTier }): Position => ({
    id: 'pos-1',
    strategyId: 'test-strat',
    chainId: chainId(1),
    tokenAddress: tokenAddress('0x' + 'a'.repeat(40)),
    entryPrice: 100,
    currentPrice: 95,
    amount: 1000000000000000000n,
    enteredAt: Date.now(),
    pnlUsd: -50,
    pnlPercent: -5,
    ...overrides,
  });

  let breaker: DrawdownCircuitBreaker;
  let emittedEvents: CircuitBreakerEvent[];
  let emitter: (event: CircuitBreakerEvent) => void;

  beforeEach(() => {
    emittedEvents = [];
    emitter = (event) => emittedEvents.push(event);
    breaker = new DrawdownCircuitBreaker(defaultConfig, emitter);
  });

  // --- Activation ---

  describe('activation', () => {
    it('activates when drawdown crosses threshold', () => {
      breaker.evaluate(100000); // set peak
      const state = breaker.evaluate(89000); // -11% drawdown

      expect(state.active).toBe(true);
      expect(state.currentDrawdown).toBeCloseTo(-0.11);
      expect(state.activatedAt).not.toBeNull();
    });

    it('activates within 1 tick cycle (no delay)', () => {
      breaker.evaluate(100000); // set peak
      const state = breaker.evaluate(85000); // -15% — immediate activation

      expect(state.active).toBe(true);
    });

    it('does not activate when drawdown is within threshold', () => {
      breaker.evaluate(100000); // set peak
      const state = breaker.evaluate(95000); // -5% — within -10% threshold

      expect(state.active).toBe(false);
    });

    it('activates at exact threshold', () => {
      breaker.evaluate(100000); // set peak
      const state = breaker.evaluate(90000); // exactly -10%

      expect(state.active).toBe(true);
    });
  });

  // --- Entry rejection ---

  describe('entry rejection', () => {
    it('rejects entries while breaker is active', () => {
      breaker.evaluate(100000);
      breaker.evaluate(85000); // activate

      expect(breaker.shouldRejectEntry()).toBe(true);
    });

    it('allows entries when breaker is inactive', () => {
      breaker.evaluate(100000);
      breaker.evaluate(95000);

      expect(breaker.shouldRejectEntry()).toBe(false);
    });

    it('rejection reason includes actual drawdown', () => {
      breaker.evaluate(100000);
      breaker.evaluate(85000); // -15%

      const reason = breaker.getRejectionReason();
      expect(reason).toContain('-15.00%');
      expect(reason).toContain('Circuit breaker active');
    });
  });

  // --- Aggressive mode ---

  describe('aggressive mode', () => {
    it('generates close actions for Growth and Degen positions only', () => {
      const aggressiveConfig: CircuitBreakerConfig = {
        ...defaultConfig,
        aggressiveMode: true,
      };

      const tierMap = new Map<string, PortfolioTier>();
      tierMap.set('safe-strat', 'safe');
      tierMap.set('growth-strat', 'growth');
      tierMap.set('degen-strat', 'degen');

      const resolver = (pos: Position) => tierMap.get(pos.strategyId) ?? 'growth';
      const aggBreaker = new DrawdownCircuitBreaker(aggressiveConfig, emitter, resolver);

      aggBreaker.evaluate(100000);
      aggBreaker.evaluate(85000); // activate

      const positions = [
        makePosition({ id: 'pos-safe', strategyId: 'safe-strat' }),
        makePosition({ id: 'pos-growth', strategyId: 'growth-strat' }),
        makePosition({ id: 'pos-degen', strategyId: 'degen-strat' }),
      ];

      const actions = aggBreaker.getAggressiveCloseActions(positions);
      expect(actions).toHaveLength(2);
      expect(actions.map((a) => a.positionId)).toContain('pos-growth');
      expect(actions.map((a) => a.positionId)).toContain('pos-degen');
      expect(actions.map((a) => a.positionId)).not.toContain('pos-safe');
    });

    it('preserves Safe tier positions', () => {
      const aggressiveConfig: CircuitBreakerConfig = {
        ...defaultConfig,
        aggressiveMode: true,
      };
      const resolver = () => 'safe' as PortfolioTier;
      const aggBreaker = new DrawdownCircuitBreaker(aggressiveConfig, emitter, resolver);

      aggBreaker.evaluate(100000);
      aggBreaker.evaluate(85000);

      const positions = [makePosition({ id: 'pos-safe' })];
      const actions = aggBreaker.getAggressiveCloseActions(positions);
      expect(actions).toHaveLength(0);
    });

    it('skips aggressive mode when config.aggressiveMode is false', () => {
      breaker.evaluate(100000);
      breaker.evaluate(85000); // activate but not aggressive

      const positions = [makePosition()];
      const actions = breaker.getAggressiveCloseActions(positions);
      expect(actions).toHaveLength(0);
    });

    it('returns empty when breaker is not active', () => {
      const aggressiveConfig: CircuitBreakerConfig = {
        ...defaultConfig,
        aggressiveMode: true,
      };
      const aggBreaker = new DrawdownCircuitBreaker(aggressiveConfig, emitter);

      aggBreaker.evaluate(100000);
      aggBreaker.evaluate(95000); // no activation

      const positions = [makePosition()];
      const actions = aggBreaker.getAggressiveCloseActions(positions);
      expect(actions).toHaveLength(0);
    });
  });

  // --- Deactivation ---

  describe('deactivation', () => {
    it('deactivates when portfolio recovers above reset threshold', () => {
      breaker.evaluate(100000); // peak
      breaker.evaluate(85000); // activate at -15%
      expect(breaker.shouldRejectEntry()).toBe(true);

      const state = breaker.evaluate(96000); // -4% → above -5% reset threshold
      expect(state.active).toBe(false);
      expect(state.activatedAt).toBeNull();
    });

    it('does NOT reset peak value on deactivation', () => {
      breaker.evaluate(100000); // peak = 100000
      breaker.evaluate(85000); // activate
      breaker.evaluate(96000); // deactivate

      const state = breaker.getState();
      expect(state.peakPortfolioValueUsd).toBe(100000); // peak preserved
    });
  });

  // --- Peak tracking ---

  describe('peak tracking', () => {
    it('peak only ratchets upward', () => {
      breaker.evaluate(80000);
      expect(breaker.getState().peakPortfolioValueUsd).toBe(80000);

      breaker.evaluate(100000);
      expect(breaker.getState().peakPortfolioValueUsd).toBe(100000);

      breaker.evaluate(90000);
      expect(breaker.getState().peakPortfolioValueUsd).toBe(100000); // no decrease
    });
  });

  // --- Hysteresis ---

  describe('hysteresis', () => {
    it('prevents rapid activation/deactivation cycling', () => {
      breaker.evaluate(100000); // peak

      // Drop to -10% → activate
      breaker.evaluate(90000);
      expect(breaker.shouldRejectEntry()).toBe(true);

      // Recover to -6% → still active (need > -5% to deactivate)
      breaker.evaluate(94000);
      expect(breaker.shouldRejectEntry()).toBe(true);

      // Recover to -4% → deactivate
      breaker.evaluate(96000);
      expect(breaker.shouldRejectEntry()).toBe(false);

      // Drop to -7% → still inactive (need <= -10% to reactivate)
      breaker.evaluate(93000);
      expect(breaker.shouldRejectEntry()).toBe(false);
    });
  });

  // --- Store events ---

  describe('store events', () => {
    it('emits activation event', () => {
      breaker.evaluate(100000);
      breaker.evaluate(85000); // activate

      expect(emittedEvents).toHaveLength(1);
      expect(emittedEvents[0].type).toBe('circuit_breaker_activated');
      expect(emittedEvents[0].drawdown).toBeCloseTo(-0.15);
      expect(emittedEvents[0].peakValue).toBe(100000);
      expect(emittedEvents[0].currentValue).toBe(85000);
    });

    it('emits deactivation event', () => {
      breaker.evaluate(100000);
      breaker.evaluate(85000); // activate
      breaker.evaluate(96000); // deactivate

      expect(emittedEvents).toHaveLength(2);
      expect(emittedEvents[1].type).toBe('circuit_breaker_deactivated');
    });
  });

  // --- Drawdown calculation ---

  describe('drawdown calculation', () => {
    it('calculates accurate drawdown with concrete USD values', () => {
      breaker.evaluate(100000); // peak
      const state = breaker.evaluate(87500); // -12.5%

      expect(state.currentDrawdown).toBeCloseTo(-0.125);
    });
  });

  // --- Disabled breaker ---

  describe('disabled', () => {
    it('does not activate when disabled', () => {
      const disabledBreaker = new DrawdownCircuitBreaker({
        ...defaultConfig,
        enabled: false,
      });

      disabledBreaker.evaluate(100000);
      const state = disabledBreaker.evaluate(50000); // -50% drawdown

      expect(state.active).toBe(false);
    });
  });

  // --- Reset ---

  describe('reset', () => {
    it('clears all state for test isolation', () => {
      breaker.evaluate(100000);
      breaker.evaluate(85000); // activate
      expect(breaker.shouldRejectEntry()).toBe(true);

      breaker.reset();
      expect(breaker.shouldRejectEntry()).toBe(false);
      expect(breaker.getState().peakPortfolioValueUsd).toBe(0);
    });
  });
});
