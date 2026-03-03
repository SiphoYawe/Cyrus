import { createLogger } from '../utils/logger.js';
import { Store } from '../core/store.js';
import type { Position } from '../core/types.js';
import type {
  PortfolioTier,
  TierConfig,
  TierAllocation,
  TierStatus,
  PortfolioSnapshot,
  RebalancingSuggestion,
} from './types.js';

const logger = createLogger('portfolio-tier-engine');

/**
 * Portfolio Tier Allocation Engine.
 *
 * Manages capital allocation across four tiers: Safe, Growth, Degen, Reserve.
 * Each strategy is classified into a tier via its risk profile.
 * Evaluates current allocation, detects imbalances, and suggests rebalancing.
 */
export class PortfolioTierEngine {
  private readonly lastKnownPrices: Map<string, number> = new Map();
  private strategyTierMap: Map<string, PortfolioTier> = new Map();

  /**
   * Register a strategy's tier classification.
   */
  registerStrategyTier(strategyId: string, tier: PortfolioTier): void {
    this.strategyTierMap.set(strategyId, tier);
  }

  /**
   * Get a strategy's tier classification.
   */
  getStrategyTier(strategyId: string): PortfolioTier {
    return this.strategyTierMap.get(strategyId) ?? 'growth';
  }

  /**
   * Calculate total portfolio value in USD from store data.
   */
  calculateTotalPortfolioValue(): { totalValueUsd: number; hasStalePrices: boolean } {
    const store = Store.getInstance();
    const balances = store.getAllBalances();
    const positions = store.getAllPositions();

    let totalValueUsd = 0;
    let hasStalePrices = false;

    // Sum balance values
    for (const balance of balances) {
      const key = `${balance.chainId}-${balance.tokenAddress}`;
      if (Number.isFinite(balance.usdValue) && balance.usdValue > 0) {
        totalValueUsd += balance.usdValue;
        this.lastKnownPrices.set(key, balance.usdValue);
      } else {
        const lastKnown = this.lastKnownPrices.get(key);
        if (lastKnown !== undefined) {
          totalValueUsd += lastKnown;
          hasStalePrices = true;
          logger.warn(
            { chainId: balance.chainId, token: balance.tokenAddress },
            'Using last known price for balance valuation',
          );
        }
      }
    }

    // Sum position values
    for (const position of positions) {
      const positionValueUsd = position.currentPrice * Number(position.amount) / (10 ** 18); // approximate
      if (Number.isFinite(positionValueUsd)) {
        totalValueUsd += positionValueUsd;
      }
    }

    return { totalValueUsd, hasStalePrices };
  }

  /**
   * Classify positions by their strategy's tier.
   */
  classifyPositions(positions: readonly Position[]): Map<PortfolioTier, Position[]> {
    const result = new Map<PortfolioTier, Position[]>([
      ['safe', []],
      ['growth', []],
      ['degen', []],
      ['reserve', []],
    ]);

    for (const position of positions) {
      const tier = this.getStrategyTier(position.strategyId);
      result.get(tier)!.push(position);
    }

    return result;
  }

  /**
   * Calculate per-tier USD values from classified positions.
   */
  calculateTierValues(positions: readonly Position[]): Map<PortfolioTier, number> {
    const classified = this.classifyPositions(positions);
    const tierValues = new Map<PortfolioTier, number>();

    for (const [tier, tierPositions] of classified) {
      let value = 0;
      for (const pos of tierPositions) {
        value += Math.abs(pos.pnlUsd) + (pos.currentPrice * Number(pos.amount) / (10 ** 18));
      }
      tierValues.set(tier, Number.isFinite(value) ? value : 0);
    }

    return tierValues;
  }

  /**
   * Evaluate portfolio tier allocation against targets.
   */
  evaluate(tierConfigs: readonly TierConfig[]): PortfolioSnapshot {
    // Validate target percentages sum to ~100%
    const totalTarget = tierConfigs.reduce((sum, tc) => sum + tc.targetPercent, 0);
    if (Math.abs(totalTarget - 1.0) > 0.01) {
      logger.error({ totalTarget }, 'Tier target percentages do not sum to 100%');
    }

    const { totalValueUsd, hasStalePrices } = this.calculateTotalPortfolioValue();
    const store = Store.getInstance();
    const positions = store.getAllPositions();
    const tierValues = this.calculateTierValues(positions);

    const tiers: TierAllocation[] = tierConfigs.map((config) => {
      const actualValueUsd = tierValues.get(config.tier) ?? 0;
      const actualPercent = totalValueUsd > 0 ? actualValueUsd / totalValueUsd : 0;
      const deviation = actualPercent - config.targetPercent;

      let status: TierStatus;
      if (deviation > config.tolerance) {
        status = 'overweight';
      } else if (deviation < -config.tolerance) {
        status = 'underweight';
      } else {
        status = 'balanced';
      }

      return {
        tier: config.tier,
        targetPercent: config.targetPercent,
        actualPercent,
        actualValueUsd,
        deviation,
        status,
      };
    });

    return {
      totalValueUsd,
      tiers,
      timestamp: Date.now(),
      hasStalePrices,
    };
  }

  /**
   * Suggest rebalancing operations to bring tiers closer to targets.
   */
  suggestRebalancing(snapshot: PortfolioSnapshot): RebalancingSuggestion[] {
    const suggestions: RebalancingSuggestion[] = [];

    const overweight = snapshot.tiers
      .filter((t) => t.status === 'overweight')
      .sort((a, b) => b.deviation - a.deviation);

    const underweight = snapshot.tiers
      .filter((t) => t.status === 'underweight')
      .sort((a, b) => a.deviation - b.deviation); // most underweight first

    for (const over of overweight) {
      const excessUsd = over.deviation * snapshot.totalValueUsd;

      for (const under of underweight) {
        const deficitUsd = Math.abs(under.deviation) * snapshot.totalValueUsd;
        const transferAmount = Math.min(excessUsd, deficitUsd);

        if (transferAmount > 0) {
          suggestions.push({
            fromTier: over.tier,
            toTier: under.tier,
            amountUsd: transferAmount,
            reason: `Rebalance: ${over.tier} overweight by ${(over.deviation * 100).toFixed(1)}%, ${under.tier} underweight by ${(Math.abs(under.deviation) * 100).toFixed(1)}%`,
          });
        }
      }
    }

    return suggestions;
  }

  /**
   * Check if Reserve tier is depleted below its minimum.
   */
  isReserveDepleted(snapshot: PortfolioSnapshot, reserveConfig: TierConfig): boolean {
    const reserveTier = snapshot.tiers.find((t) => t.tier === 'reserve');
    if (!reserveTier) return false;

    const depleted = reserveTier.actualPercent < reserveConfig.minPercent;
    if (depleted) {
      logger.error(
        {
          actualPercent: reserveTier.actualPercent,
          minPercent: reserveConfig.minPercent,
        },
        'Reserve tier depleted — blocking new Growth and Degen positions',
      );
    }

    return depleted;
  }

  /**
   * Check if a new position can be allocated to a tier without exceeding caps.
   */
  canAllocateToTier(
    tier: PortfolioTier,
    positionSizeUsd: number,
    snapshot: PortfolioSnapshot,
    tierConfigs: readonly TierConfig[],
  ): boolean {
    const tierConfig = tierConfigs.find((tc) => tc.tier === tier);
    if (!tierConfig) return false;

    // Check Reserve depletion for Growth and Degen
    const reserveConfig = tierConfigs.find((tc) => tc.tier === 'reserve');
    if (reserveConfig && (tier === 'growth' || tier === 'degen')) {
      if (this.isReserveDepleted(snapshot, reserveConfig)) {
        return false;
      }
    }

    // Check if adding this position would exceed max allocation
    const tierAllocation = snapshot.tiers.find((t) => t.tier === tier);
    if (!tierAllocation) return false;

    const newTierValue = tierAllocation.actualValueUsd + positionSizeUsd;
    const newTotalValue = snapshot.totalValueUsd + positionSizeUsd;
    const newPercent = newTotalValue > 0 ? newTierValue / newTotalValue : 0;

    if (newPercent > tierConfig.maxPercent) {
      logger.info(
        { tier, positionSizeUsd, newPercent, maxPercent: tierConfig.maxPercent },
        'Tier cap would be exceeded — rejecting entry',
      );
      return false;
    }

    return true;
  }

  /**
   * Get available capital for a tier based on target allocation headroom.
   */
  getAvailableCapitalForTier(
    tier: PortfolioTier,
    snapshot: PortfolioSnapshot,
    tierConfigs: readonly TierConfig[],
  ): number {
    const tierConfig = tierConfigs.find((tc) => tc.tier === tier);
    if (!tierConfig) return 0;

    // Block Growth and Degen when Reserve is depleted
    const reserveConfig = tierConfigs.find((tc) => tc.tier === 'reserve');
    if (reserveConfig && (tier === 'growth' || tier === 'degen')) {
      if (this.isReserveDepleted(snapshot, reserveConfig)) {
        return 0;
      }
    }

    const tierAllocation = snapshot.tiers.find((t) => t.tier === tier);
    if (!tierAllocation) return 0;

    // Headroom based on target
    const targetHeadroom = (tierConfig.targetPercent * snapshot.totalValueUsd) - tierAllocation.actualValueUsd;

    // Cap at max allocation headroom
    const maxHeadroom = (tierConfig.maxPercent * snapshot.totalValueUsd) - tierAllocation.actualValueUsd;

    const available = Math.min(targetHeadroom, maxHeadroom);
    return Math.max(available, 0);
  }

  /**
   * Reset state for test isolation.
   */
  reset(): void {
    this.lastKnownPrices.clear();
    this.strategyTierMap.clear();
  }
}
