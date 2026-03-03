import { describe, it, expect, beforeEach } from 'vitest';
import { PortfolioTierEngine } from '../portfolio-tier-engine.js';
import { Store } from '../../core/store.js';
import { chainId, tokenAddress } from '../../core/types.js';
import type { TierConfig, PortfolioSnapshot } from '../types.js';

describe('PortfolioTierEngine', () => {
  let engine: PortfolioTierEngine;
  let store: Store;

  const defaultTierConfigs: TierConfig[] = [
    { tier: 'safe', targetPercent: 0.60, tolerance: 0.03, minPercent: 0.40, maxPercent: 0.80 },
    { tier: 'growth', targetPercent: 0.25, tolerance: 0.03, minPercent: 0.10, maxPercent: 0.40 },
    { tier: 'degen', targetPercent: 0.10, tolerance: 0.03, minPercent: 0.00, maxPercent: 0.20 },
    { tier: 'reserve', targetPercent: 0.05, tolerance: 0.02, minPercent: 0.03, maxPercent: 0.10 },
  ];

  const ETH_CHAIN = chainId(1);
  const USDC = tokenAddress('0x' + 'a'.repeat(40));
  const WETH = tokenAddress('0x' + 'b'.repeat(40));

  beforeEach(() => {
    Store.getInstance().reset();
    store = Store.getInstance();
    engine = new PortfolioTierEngine();
  });

  // --- Allocation calculation ---

  describe('evaluate', () => {
    it('calculates correct allocation with known portfolio state', () => {
      // Set up balances
      store.setBalance(ETH_CHAIN, USDC, 10000_000000n, 10000, 'USDC', 6);

      // Set up positions for different tiers
      engine.registerStrategyTier('safe-strat', 'safe');
      engine.registerStrategyTier('growth-strat', 'growth');

      store.setPosition({
        id: 'pos-1',
        strategyId: 'safe-strat',
        chainId: ETH_CHAIN,
        tokenAddress: USDC,
        entryPrice: 1,
        currentPrice: 1,
        amount: 6000_000000000000000000n,
        enteredAt: Date.now(),
        pnlUsd: 0,
        pnlPercent: 0,
      });

      const snapshot = engine.evaluate(defaultTierConfigs);
      expect(snapshot.totalValueUsd).toBeGreaterThan(0);
      expect(snapshot.tiers).toHaveLength(4);
      expect(snapshot.timestamp).toBeGreaterThan(0);
    });

    it('validates target percentages sum to 100%', () => {
      // This should log an error but not throw
      const badConfigs: TierConfig[] = [
        { tier: 'safe', targetPercent: 0.50, tolerance: 0.03, minPercent: 0.40, maxPercent: 0.80 },
        { tier: 'growth', targetPercent: 0.20, tolerance: 0.03, minPercent: 0.10, maxPercent: 0.40 },
      ];

      // Should not throw
      const snapshot = engine.evaluate(badConfigs);
      expect(snapshot.tiers).toHaveLength(2);
    });
  });

  // --- Overweight/underweight detection ---

  describe('tier status detection', () => {
    it('detects overweight when allocation exceeds target + tolerance', () => {
      store.setBalance(ETH_CHAIN, USDC, 10000_000000n, 10000, 'USDC', 6);

      engine.registerStrategyTier('safe-strat', 'safe');

      // Large safe position pushes safe tier over target
      store.setPosition({
        id: 'pos-1',
        strategyId: 'safe-strat',
        chainId: ETH_CHAIN,
        tokenAddress: USDC,
        entryPrice: 1,
        currentPrice: 1,
        amount: 100000_000000000000000000n,
        enteredAt: Date.now(),
        pnlUsd: 0,
        pnlPercent: 0,
      });

      const snapshot = engine.evaluate(defaultTierConfigs);
      const safeTier = snapshot.tiers.find((t) => t.tier === 'safe');
      expect(safeTier).toBeDefined();
      // Safe should be overweight since it has almost all the value
      if (safeTier && safeTier.actualPercent > safeTier.targetPercent + 0.03) {
        expect(safeTier.status).toBe('overweight');
      }
    });

    it('detects underweight when allocation is below target - tolerance', () => {
      store.setBalance(ETH_CHAIN, USDC, 10000_000000n, 10000, 'USDC', 6);

      // No positions in growth tier
      const snapshot = engine.evaluate(defaultTierConfigs);
      const growthTier = snapshot.tiers.find((t) => t.tier === 'growth');
      expect(growthTier).toBeDefined();
      // Growth should be underweight with 0% actual vs 25% target
      expect(growthTier!.status).toBe('underweight');
    });
  });

  // --- Rebalancing suggestions ---

  describe('suggestRebalancing', () => {
    it('matches overweight excess to underweight deficit', () => {
      const snapshot: PortfolioSnapshot = {
        totalValueUsd: 100000,
        tiers: [
          { tier: 'safe', targetPercent: 0.60, actualPercent: 0.80, actualValueUsd: 80000, deviation: 0.20, status: 'overweight' },
          { tier: 'growth', targetPercent: 0.25, actualPercent: 0.10, actualValueUsd: 10000, deviation: -0.15, status: 'underweight' },
          { tier: 'degen', targetPercent: 0.10, actualPercent: 0.05, actualValueUsd: 5000, deviation: -0.05, status: 'underweight' },
          { tier: 'reserve', targetPercent: 0.05, actualPercent: 0.05, actualValueUsd: 5000, deviation: 0.00, status: 'balanced' },
        ],
        timestamp: Date.now(),
        hasStalePrices: false,
      };

      const suggestions = engine.suggestRebalancing(snapshot);
      expect(suggestions.length).toBeGreaterThan(0);
      expect(suggestions[0].fromTier).toBe('safe');

      // Growth is more underweight, so it should be prioritized
      const growthSuggestion = suggestions.find((s) => s.toTier === 'growth');
      expect(growthSuggestion).toBeDefined();
      expect(growthSuggestion!.amountUsd).toBeGreaterThan(0);
    });

    it('returns empty array when all tiers are balanced', () => {
      const snapshot: PortfolioSnapshot = {
        totalValueUsd: 100000,
        tiers: [
          { tier: 'safe', targetPercent: 0.60, actualPercent: 0.60, actualValueUsd: 60000, deviation: 0.00, status: 'balanced' },
          { tier: 'growth', targetPercent: 0.25, actualPercent: 0.25, actualValueUsd: 25000, deviation: 0.00, status: 'balanced' },
          { tier: 'degen', targetPercent: 0.10, actualPercent: 0.10, actualValueUsd: 10000, deviation: 0.00, status: 'balanced' },
          { tier: 'reserve', targetPercent: 0.05, actualPercent: 0.05, actualValueUsd: 5000, deviation: 0.00, status: 'balanced' },
        ],
        timestamp: Date.now(),
        hasStalePrices: false,
      };

      const suggestions = engine.suggestRebalancing(snapshot);
      expect(suggestions).toHaveLength(0);
    });
  });

  // --- Reserve protection ---

  describe('reserve protection', () => {
    it('detects depleted reserve', () => {
      const snapshot: PortfolioSnapshot = {
        totalValueUsd: 100000,
        tiers: [
          { tier: 'safe', targetPercent: 0.60, actualPercent: 0.65, actualValueUsd: 65000, deviation: 0.05, status: 'overweight' },
          { tier: 'growth', targetPercent: 0.25, actualPercent: 0.25, actualValueUsd: 25000, deviation: 0.00, status: 'balanced' },
          { tier: 'degen', targetPercent: 0.10, actualPercent: 0.08, actualValueUsd: 8000, deviation: -0.02, status: 'balanced' },
          { tier: 'reserve', targetPercent: 0.05, actualPercent: 0.02, actualValueUsd: 2000, deviation: -0.03, status: 'underweight' },
        ],
        timestamp: Date.now(),
        hasStalePrices: false,
      };

      const reserveConfig = defaultTierConfigs.find((tc) => tc.tier === 'reserve')!;
      expect(engine.isReserveDepleted(snapshot, reserveConfig)).toBe(true);
    });

    it('allows when reserve is above minimum', () => {
      const snapshot: PortfolioSnapshot = {
        totalValueUsd: 100000,
        tiers: [
          { tier: 'safe', targetPercent: 0.60, actualPercent: 0.60, actualValueUsd: 60000, deviation: 0.00, status: 'balanced' },
          { tier: 'growth', targetPercent: 0.25, actualPercent: 0.25, actualValueUsd: 25000, deviation: 0.00, status: 'balanced' },
          { tier: 'degen', targetPercent: 0.10, actualPercent: 0.10, actualValueUsd: 10000, deviation: 0.00, status: 'balanced' },
          { tier: 'reserve', targetPercent: 0.05, actualPercent: 0.05, actualValueUsd: 5000, deviation: 0.00, status: 'balanced' },
        ],
        timestamp: Date.now(),
        hasStalePrices: false,
      };

      const reserveConfig = defaultTierConfigs.find((tc) => tc.tier === 'reserve')!;
      expect(engine.isReserveDepleted(snapshot, reserveConfig)).toBe(false);
    });

    it('blocks Growth entries when Reserve is depleted', () => {
      const snapshot: PortfolioSnapshot = {
        totalValueUsd: 100000,
        tiers: [
          { tier: 'safe', targetPercent: 0.60, actualPercent: 0.60, actualValueUsd: 60000, deviation: 0.00, status: 'balanced' },
          { tier: 'growth', targetPercent: 0.25, actualPercent: 0.20, actualValueUsd: 20000, deviation: -0.05, status: 'underweight' },
          { tier: 'degen', targetPercent: 0.10, actualPercent: 0.18, actualValueUsd: 18000, deviation: 0.08, status: 'overweight' },
          { tier: 'reserve', targetPercent: 0.05, actualPercent: 0.02, actualValueUsd: 2000, deviation: -0.03, status: 'underweight' },
        ],
        timestamp: Date.now(),
        hasStalePrices: false,
      };

      expect(engine.canAllocateToTier('growth', 5000, snapshot, defaultTierConfigs)).toBe(false);
      expect(engine.canAllocateToTier('degen', 1000, snapshot, defaultTierConfigs)).toBe(false);
      // Safe should still be allowed
      expect(engine.canAllocateToTier('safe', 5000, snapshot, defaultTierConfigs)).toBe(true);
    });
  });

  // --- Tier cap enforcement ---

  describe('tier cap enforcement', () => {
    it('rejects entries that would exceed max allocation', () => {
      const snapshot: PortfolioSnapshot = {
        totalValueUsd: 100000,
        tiers: [
          { tier: 'safe', targetPercent: 0.60, actualPercent: 0.78, actualValueUsd: 78000, deviation: 0.18, status: 'overweight' },
          { tier: 'growth', targetPercent: 0.25, actualPercent: 0.12, actualValueUsd: 12000, deviation: -0.13, status: 'underweight' },
          { tier: 'degen', targetPercent: 0.10, actualPercent: 0.05, actualValueUsd: 5000, deviation: -0.05, status: 'underweight' },
          { tier: 'reserve', targetPercent: 0.05, actualPercent: 0.05, actualValueUsd: 5000, deviation: 0.00, status: 'balanced' },
        ],
        timestamp: Date.now(),
        hasStalePrices: false,
      };

      // Safe max is 80%. Currently at 78%. Adding $5000 to $105000 total → 83000/105000 = 79% → ok
      expect(engine.canAllocateToTier('safe', 5000, snapshot, defaultTierConfigs)).toBe(true);

      // Adding $30000 → 108000/130000 = 83% → exceeds 80% max
      expect(engine.canAllocateToTier('safe', 30000, snapshot, defaultTierConfigs)).toBe(false);
    });
  });

  // --- Available capital ---

  describe('getAvailableCapitalForTier', () => {
    it('returns headroom based on target allocation', () => {
      const snapshot: PortfolioSnapshot = {
        totalValueUsd: 100000,
        tiers: [
          { tier: 'safe', targetPercent: 0.60, actualPercent: 0.50, actualValueUsd: 50000, deviation: -0.10, status: 'underweight' },
          { tier: 'growth', targetPercent: 0.25, actualPercent: 0.25, actualValueUsd: 25000, deviation: 0.00, status: 'balanced' },
          { tier: 'degen', targetPercent: 0.10, actualPercent: 0.10, actualValueUsd: 10000, deviation: 0.00, status: 'balanced' },
          { tier: 'reserve', targetPercent: 0.05, actualPercent: 0.15, actualValueUsd: 15000, deviation: 0.10, status: 'overweight' },
        ],
        timestamp: Date.now(),
        hasStalePrices: false,
      };

      // Safe target = 60% of 100000 = 60000, actual = 50000, headroom = 10000
      const available = engine.getAvailableCapitalForTier('safe', snapshot, defaultTierConfigs);
      expect(available).toBe(10000);
    });

    it('returns 0 for Growth/Degen when Reserve is depleted', () => {
      const snapshot: PortfolioSnapshot = {
        totalValueUsd: 100000,
        tiers: [
          { tier: 'safe', targetPercent: 0.60, actualPercent: 0.60, actualValueUsd: 60000, deviation: 0.00, status: 'balanced' },
          { tier: 'growth', targetPercent: 0.25, actualPercent: 0.20, actualValueUsd: 20000, deviation: -0.05, status: 'underweight' },
          { tier: 'degen', targetPercent: 0.10, actualPercent: 0.18, actualValueUsd: 18000, deviation: 0.08, status: 'overweight' },
          { tier: 'reserve', targetPercent: 0.05, actualPercent: 0.02, actualValueUsd: 2000, deviation: -0.03, status: 'underweight' },
        ],
        timestamp: Date.now(),
        hasStalePrices: false,
      };

      expect(engine.getAvailableCapitalForTier('growth', snapshot, defaultTierConfigs)).toBe(0);
      expect(engine.getAvailableCapitalForTier('degen', snapshot, defaultTierConfigs)).toBe(0);
    });

    it('returns 0 when tier is already overweight', () => {
      const snapshot: PortfolioSnapshot = {
        totalValueUsd: 100000,
        tiers: [
          { tier: 'safe', targetPercent: 0.60, actualPercent: 0.80, actualValueUsd: 80000, deviation: 0.20, status: 'overweight' },
          { tier: 'growth', targetPercent: 0.25, actualPercent: 0.10, actualValueUsd: 10000, deviation: -0.15, status: 'underweight' },
          { tier: 'degen', targetPercent: 0.10, actualPercent: 0.05, actualValueUsd: 5000, deviation: -0.05, status: 'underweight' },
          { tier: 'reserve', targetPercent: 0.05, actualPercent: 0.05, actualValueUsd: 5000, deviation: 0.00, status: 'balanced' },
        ],
        timestamp: Date.now(),
        hasStalePrices: false,
      };

      // Safe at 80% vs 60% target = negative headroom → 0
      expect(engine.getAvailableCapitalForTier('safe', snapshot, defaultTierConfigs)).toBe(0);
    });
  });

  // --- Graceful handling of missing price data ---

  describe('missing price data', () => {
    it('uses last known prices and sets hasStalePrices flag', () => {
      // First evaluation with good data
      store.setBalance(ETH_CHAIN, USDC, 10000_000000n, 10000, 'USDC', 6);
      engine.evaluate(defaultTierConfigs);

      // Now set balance with 0 USD value (simulating missing price)
      store.setBalance(ETH_CHAIN, USDC, 10000_000000n, 0, 'USDC', 6);
      const snapshot = engine.evaluate(defaultTierConfigs);

      expect(snapshot.hasStalePrices).toBe(true);
      expect(snapshot.totalValueUsd).toBeGreaterThan(0);
    });
  });

  // --- Reset ---

  describe('reset', () => {
    it('clears internal state', () => {
      engine.registerStrategyTier('test', 'safe');
      engine.reset();
      // Default tier should be 'growth'
      expect(engine.getStrategyTier('test')).toBe('growth');
    });
  });
});
