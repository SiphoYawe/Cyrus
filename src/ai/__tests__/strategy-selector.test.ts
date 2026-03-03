import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Store } from '../../core/store.js';
import { StrategySelector, REGIME_TIER_MAP } from '../strategy-selector.js';
import type { StrategyMetadata } from '../strategy-selector.js';
import type { MarketRegime, StrategyTier } from '../types.js';

function createStrategy(
  name: string,
  tier: StrategyTier,
  isActive = false,
): StrategyMetadata {
  return { name, tier, isActive };
}

// A full set of strategies covering all tiers
function createFullStrategySet(activeNames: string[] = []): StrategyMetadata[] {
  return [
    createStrategy('growth-momentum', 'growth', activeNames.includes('growth-momentum')),
    createStrategy('degen-ape', 'degen', activeNames.includes('degen-ape')),
    createStrategy('yield-farmer', 'yield', activeNames.includes('yield-farmer')),
    createStrategy('stablecoin-park', 'safe', activeNames.includes('stablecoin-park')),
    createStrategy('hedge-delta', 'hedging', activeNames.includes('hedge-delta')),
  ];
}

describe('StrategySelector', () => {
  let store: Store;
  let selector: StrategySelector;

  beforeEach(() => {
    Store.getInstance().reset();
    store = Store.getInstance();
    selector = new StrategySelector();
  });

  describe('REGIME_TIER_MAP', () => {
    it('maps bull to growth, degen, yield', () => {
      expect(REGIME_TIER_MAP.bull).toEqual(['growth', 'degen', 'yield']);
    });

    it('maps bear to safe, hedging', () => {
      expect(REGIME_TIER_MAP.bear).toEqual(['safe', 'hedging']);
    });

    it('maps crab to yield, safe', () => {
      expect(REGIME_TIER_MAP.crab).toEqual(['yield', 'safe']);
    });

    it('maps volatile to hedging, safe', () => {
      expect(REGIME_TIER_MAP.volatile).toEqual(['hedging', 'safe']);
    });

    it('covers all market regimes', () => {
      const regimes: MarketRegime[] = ['bull', 'bear', 'crab', 'volatile'];
      for (const regime of regimes) {
        expect(REGIME_TIER_MAP[regime]).toBeDefined();
        expect(REGIME_TIER_MAP[regime].length).toBeGreaterThan(0);
      }
    });
  });

  describe('getCompatibleTiers', () => {
    it('returns compatible tiers for each regime', () => {
      expect(selector.getCompatibleTiers('bull')).toEqual(['growth', 'degen', 'yield']);
      expect(selector.getCompatibleTiers('bear')).toEqual(['safe', 'hedging']);
      expect(selector.getCompatibleTiers('crab')).toEqual(['yield', 'safe']);
      expect(selector.getCompatibleTiers('volatile')).toEqual(['hedging', 'safe']);
    });
  });

  describe('selectStrategies — bull regime', () => {
    it('activates growth, degen, yield strategies that are inactive', () => {
      const strategies = createFullStrategySet(); // all inactive
      const result = selector.selectStrategies('bull', strategies);

      expect(result.activate).toContain('growth-momentum');
      expect(result.activate).toContain('degen-ape');
      expect(result.activate).toContain('yield-farmer');
      expect(result.activate).not.toContain('stablecoin-park');
      expect(result.activate).not.toContain('hedge-delta');
    });

    it('deactivates safe and hedging strategies that are active', () => {
      const strategies = createFullStrategySet(['stablecoin-park', 'hedge-delta']);
      const result = selector.selectStrategies('bull', strategies);

      expect(result.deactivate).toContain('stablecoin-park');
      expect(result.deactivate).toContain('hedge-delta');
      expect(result.deactivate).not.toContain('growth-momentum');
    });

    it('does not activate already-active compatible strategies', () => {
      const strategies = createFullStrategySet(['growth-momentum', 'degen-ape', 'yield-farmer']);
      const result = selector.selectStrategies('bull', strategies);

      expect(result.activate).toHaveLength(0);
    });

    it('does not deactivate already-inactive incompatible strategies', () => {
      const strategies = createFullStrategySet(); // all inactive
      const result = selector.selectStrategies('bull', strategies);

      expect(result.deactivate).toHaveLength(0);
    });
  });

  describe('selectStrategies — bear regime', () => {
    it('activates safe and hedging, deactivates growth and degen', () => {
      const strategies = createFullStrategySet(['growth-momentum', 'degen-ape', 'yield-farmer']);
      const result = selector.selectStrategies('bear', strategies);

      expect(result.activate).toContain('stablecoin-park');
      expect(result.activate).toContain('hedge-delta');
      expect(result.deactivate).toContain('growth-momentum');
      expect(result.deactivate).toContain('degen-ape');
      expect(result.deactivate).toContain('yield-farmer');
    });
  });

  describe('selectStrategies — crab regime', () => {
    it('activates yield and safe strategies', () => {
      const strategies = createFullStrategySet();
      const result = selector.selectStrategies('crab', strategies);

      expect(result.activate).toContain('yield-farmer');
      expect(result.activate).toContain('stablecoin-park');
      expect(result.activate).not.toContain('growth-momentum');
      expect(result.activate).not.toContain('degen-ape');
      expect(result.activate).not.toContain('hedge-delta');
    });

    it('deactivates growth, degen, and hedging strategies that are active', () => {
      const strategies = createFullStrategySet([
        'growth-momentum',
        'degen-ape',
        'hedge-delta',
      ]);
      const result = selector.selectStrategies('crab', strategies);

      expect(result.deactivate).toContain('growth-momentum');
      expect(result.deactivate).toContain('degen-ape');
      expect(result.deactivate).toContain('hedge-delta');
    });
  });

  describe('selectStrategies — volatile regime', () => {
    it('activates hedging and safe strategies', () => {
      const strategies = createFullStrategySet();
      const result = selector.selectStrategies('volatile', strategies);

      expect(result.activate).toContain('hedge-delta');
      expect(result.activate).toContain('stablecoin-park');
      expect(result.activate).not.toContain('growth-momentum');
      expect(result.activate).not.toContain('yield-farmer');
    });

    it('deactivates growth, degen, and yield strategies that are active', () => {
      const strategies = createFullStrategySet([
        'growth-momentum',
        'degen-ape',
        'yield-farmer',
      ]);
      const result = selector.selectStrategies('volatile', strategies);

      expect(result.deactivate).toContain('growth-momentum');
      expect(result.deactivate).toContain('degen-ape');
      expect(result.deactivate).toContain('yield-farmer');
    });
  });

  describe('regime transitions', () => {
    it('correctly swaps strategies from bull to bear', () => {
      // Phase 1: Bull regime — activate growth/degen/yield
      const strategies = createFullStrategySet();
      const bullResult = selector.selectStrategies('bull', strategies);

      expect(bullResult.activate).toEqual(['growth-momentum', 'degen-ape', 'yield-farmer']);
      expect(bullResult.deactivate).toHaveLength(0);

      // Simulate activation: mark bull strategies as active
      const afterBull = createFullStrategySet([
        'growth-momentum',
        'degen-ape',
        'yield-farmer',
      ]);

      // Phase 2: Bear regime — deactivate growth/degen/yield, activate safe/hedging
      const bearResult = selector.selectStrategies('bear', afterBull);

      expect(bearResult.activate).toContain('stablecoin-park');
      expect(bearResult.activate).toContain('hedge-delta');
      expect(bearResult.deactivate).toContain('growth-momentum');
      expect(bearResult.deactivate).toContain('degen-ape');
      expect(bearResult.deactivate).toContain('yield-farmer');
    });

    it('correctly swaps strategies from bear to crab', () => {
      const strategies = createFullStrategySet(['stablecoin-park', 'hedge-delta']);
      const result = selector.selectStrategies('crab', strategies);

      // yield is new for crab, safe is already active — hedge gets deactivated
      expect(result.activate).toContain('yield-farmer');
      expect(result.deactivate).toContain('hedge-delta');
      // stablecoin-park is safe tier and already active, so not in activate
      expect(result.activate).not.toContain('stablecoin-park');
    });
  });

  describe('deactivation semantics', () => {
    it('only lists strategies for deactivation; does not close positions directly', () => {
      const strategies = createFullStrategySet([
        'growth-momentum',
        'degen-ape',
        'yield-farmer',
      ]);
      const result = selector.selectStrategies('bear', strategies);

      // The result only contains string names — no side effects on positions
      expect(result.deactivate).toEqual(
        expect.arrayContaining(['growth-momentum', 'degen-ape', 'yield-farmer']),
      );
      // Result is just data, caller decides how to wind down
      expect(typeof result.deactivate[0]).toBe('string');
    });
  });

  describe('result metadata', () => {
    it('includes reasoning string', () => {
      const strategies = createFullStrategySet();
      const result = selector.selectStrategies('bull', strategies);

      expect(result.reasoning).toContain('Regime "bull"');
      expect(result.reasoning).toContain('growth');
      expect(result.reasoning).toContain('Activating');
    });

    it('includes timestamp', () => {
      const before = Date.now();
      const strategies = createFullStrategySet();
      const result = selector.selectStrategies('bull', strategies);

      expect(result.timestamp).toBeGreaterThanOrEqual(before);
      expect(result.timestamp).toBeLessThanOrEqual(Date.now());
    });
  });

  describe('event emission', () => {
    it('emits strategy_selection_changed when there are activations', () => {
      const listener = vi.fn();
      store.emitter.on('strategy_selection_changed', listener);

      const strategies = createFullStrategySet();
      selector.selectStrategies('bull', strategies);

      expect(listener).toHaveBeenCalledTimes(1);
      const event = listener.mock.calls[0][0] as {
        previous: string[];
        current: string[];
        regime: string;
      };
      expect(event.regime).toBe('bull');
      expect(event.previous).toEqual([]); // none were active
      expect(event.current).toEqual(['growth-momentum', 'degen-ape', 'yield-farmer']);
    });

    it('emits strategy_selection_changed when there are deactivations', () => {
      const listener = vi.fn();
      store.emitter.on('strategy_selection_changed', listener);

      const strategies = createFullStrategySet(['growth-momentum', 'degen-ape']);
      selector.selectStrategies('bear', strategies);

      expect(listener).toHaveBeenCalledTimes(1);
      const event = listener.mock.calls[0][0] as {
        previous: string[];
        current: string[];
        regime: string;
      };
      expect(event.previous).toEqual(['growth-momentum', 'degen-ape']);
      expect(event.current).toContain('stablecoin-park');
      expect(event.current).toContain('hedge-delta');
      expect(event.current).not.toContain('growth-momentum');
      expect(event.current).not.toContain('degen-ape');
    });

    it('emits event with both activations and deactivations', () => {
      const listener = vi.fn();
      store.emitter.on('strategy_selection_changed', listener);

      const strategies = createFullStrategySet(['growth-momentum']);
      selector.selectStrategies('bear', strategies);

      expect(listener).toHaveBeenCalledTimes(1);
      const event = listener.mock.calls[0][0] as {
        previous: string[];
        current: string[];
        regime: string;
      };
      expect(event.previous).toEqual(['growth-momentum']);
      // growth-momentum deactivated, safe + hedging activated
      expect(event.current).toEqual(['stablecoin-park', 'hedge-delta']);
    });

    it('does NOT emit event when no changes occur', () => {
      const listener = vi.fn();
      store.emitter.on('strategy_selection_changed', listener);

      // All bull-compatible strategies already active, non-compatible already inactive
      const strategies = createFullStrategySet([
        'growth-momentum',
        'degen-ape',
        'yield-farmer',
      ]);
      selector.selectStrategies('bull', strategies);

      expect(listener).not.toHaveBeenCalled();
    });

    it('does NOT emit event when strategies list is empty', () => {
      const listener = vi.fn();
      store.emitter.on('strategy_selection_changed', listener);

      selector.selectStrategies('bull', []);

      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('edge cases', () => {
    it('handles empty strategy list', () => {
      const result = selector.selectStrategies('bull', []);

      expect(result.activate).toHaveLength(0);
      expect(result.deactivate).toHaveLength(0);
      expect(result.reasoning).toContain('Activating 0');
      expect(result.reasoning).toContain('deactivating 0');
    });

    it('handles strategies with duplicate tiers', () => {
      const strategies: StrategyMetadata[] = [
        createStrategy('yield-a', 'yield'),
        createStrategy('yield-b', 'yield'),
        createStrategy('yield-c', 'yield', true),
      ];

      const result = selector.selectStrategies('bull', strategies);

      // yield-a and yield-b should be activated; yield-c already active
      expect(result.activate).toContain('yield-a');
      expect(result.activate).toContain('yield-b');
      expect(result.activate).not.toContain('yield-c');
    });

    it('handles all strategies already in correct state', () => {
      const strategies = createFullStrategySet(['stablecoin-park', 'hedge-delta']);
      const result = selector.selectStrategies('bear', strategies);

      expect(result.activate).toHaveLength(0);
      expect(result.deactivate).toHaveLength(0);
    });
  });
});
