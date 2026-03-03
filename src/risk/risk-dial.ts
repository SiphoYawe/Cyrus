import { createLogger } from '../utils/logger.js';
import type {
  RiskDialLevel,
  RiskDialTierAllocation,
  TierConfig,
  PortfolioTier,
  PortfolioSnapshot,
  RebalancingSuggestion,
} from './types.js';
import { PortfolioTierEngine } from './portfolio-tier-engine.js';

const logger = createLogger('risk-dial');

// --- Anchor point allocations ---

export const DIAL_1_ALLOCATION: RiskDialTierAllocation = {
  safe: 0.90,
  growth: 0.05,
  degen: 0.00,
  reserve: 0.05,
};

export const DIAL_5_ALLOCATION: RiskDialTierAllocation = {
  safe: 0.50,
  growth: 0.30,
  degen: 0.15,
  reserve: 0.05,
};

export const DIAL_10_ALLOCATION: RiskDialTierAllocation = {
  safe: 0.10,
  growth: 0.40,
  degen: 0.45,
  reserve: 0.05,
};

/** Linear interpolation helper */
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Calculate tier allocation for a given risk dial level.
 *
 * Uses piecewise linear interpolation:
 * - Dial 1-5: interpolates between DIAL_1 and DIAL_5
 * - Dial 5-10: interpolates between DIAL_5 and DIAL_10
 * - Reserve always stays at 5%
 *
 * @param dial - Risk dial level (integer 1-10)
 * @returns Tier allocation percentages (sum to 1.0)
 */
export function calculateTierAllocation(dial: RiskDialLevel): RiskDialTierAllocation {
  // Validate dial
  if (!Number.isInteger(dial) || dial < 1 || dial > 10) {
    throw new Error(`Invalid risk dial level: ${dial} (must be integer 1-10)`);
  }

  let safe: number;
  let growth: number;
  let degen: number;

  if (dial <= 5) {
    // Interpolate between dial 1 and dial 5
    const t = (dial - 1) / 4;
    safe = lerp(DIAL_1_ALLOCATION.safe, DIAL_5_ALLOCATION.safe, t);
    growth = lerp(DIAL_1_ALLOCATION.growth, DIAL_5_ALLOCATION.growth, t);
    degen = lerp(DIAL_1_ALLOCATION.degen, DIAL_5_ALLOCATION.degen, t);
  } else {
    // Interpolate between dial 5 and dial 10
    const t = (dial - 5) / 5;
    safe = lerp(DIAL_5_ALLOCATION.safe, DIAL_10_ALLOCATION.safe, t);
    growth = lerp(DIAL_5_ALLOCATION.growth, DIAL_10_ALLOCATION.growth, t);
    degen = lerp(DIAL_5_ALLOCATION.degen, DIAL_10_ALLOCATION.degen, t);
  }

  const reserve = 0.05; // Always constant

  // Validate sum
  const sum = safe + growth + degen + reserve;
  if (Math.abs(sum - 1.0) > 0.001) {
    logger.warn({ safe, growth, degen, reserve, sum }, 'Tier allocation does not sum to 1.0');
  }

  return { safe, growth, degen, reserve };
}

/**
 * Convert a risk dial allocation to TierConfig array.
 *
 * @param allocation - Tier allocation from risk dial
 * @param tolerance - Tolerance band (default 0.03 = ±3%)
 * @returns TierConfig array for use with PortfolioTierEngine
 */
export function toTierConfigs(
  allocation: RiskDialTierAllocation,
  tolerance: number = 0.03,
): TierConfig[] {
  const tiers: PortfolioTier[] = ['safe', 'growth', 'degen', 'reserve'];

  return tiers.map((tier) => {
    const target = allocation[tier];
    return {
      tier,
      targetPercent: target,
      tolerance: tier === 'reserve' ? 0.02 : tolerance,
      minPercent: Math.max(0, target - tolerance),
      maxPercent: target === 0 ? 0 : Math.min(1, target + tolerance),
    };
  });
}

/**
 * Rebalancing plan result from a dial change.
 */
export interface RebalancingPlan {
  readonly oldDial: RiskDialLevel;
  readonly newDial: RiskDialLevel;
  readonly oldAllocation: RiskDialTierAllocation;
  readonly newAllocation: RiskDialTierAllocation;
  readonly suggestions: RebalancingSuggestion[];
}

/**
 * Event emitted when the risk dial changes.
 */
export interface RiskDialChangedEvent {
  readonly type: 'risk_dial_changed';
  readonly oldDial: RiskDialLevel;
  readonly newDial: RiskDialLevel;
  readonly oldAllocation: RiskDialTierAllocation;
  readonly newAllocation: RiskDialTierAllocation;
  readonly timestamp: number;
}

/**
 * Callback for emitting risk dial events.
 */
export type RiskDialEventEmitter = (event: RiskDialChangedEvent) => void;

/**
 * Risk Dial Manager.
 *
 * Manages the current dial level, calculates allocations on change,
 * and triggers rebalancing via the PortfolioTierEngine.
 */
export class RiskDialManager {
  private currentDial: RiskDialLevel;
  private readonly tierEngine: PortfolioTierEngine;
  private readonly eventEmitter?: RiskDialEventEmitter;

  constructor(
    initialDial: RiskDialLevel = 5,
    tierEngine?: PortfolioTierEngine,
    eventEmitter?: RiskDialEventEmitter,
  ) {
    this.currentDial = initialDial;
    this.tierEngine = tierEngine ?? new PortfolioTierEngine();
    this.eventEmitter = eventEmitter;
  }

  /**
   * Get current dial level.
   */
  getDial(): RiskDialLevel {
    return this.currentDial;
  }

  /**
   * Get current tier allocation.
   */
  getCurrentAllocation(): RiskDialTierAllocation {
    return calculateTierAllocation(this.currentDial);
  }

  /**
   * Set a new dial level and compute rebalancing plan.
   *
   * @param newDial - New risk dial level
   * @param currentSnapshot - Current portfolio snapshot for rebalancing suggestions
   * @returns Rebalancing plan with suggestions
   */
  setDial(newDial: RiskDialLevel, currentSnapshot?: PortfolioSnapshot): RebalancingPlan {
    const oldDial = this.currentDial;
    const oldAllocation = calculateTierAllocation(oldDial);
    const newAllocation = calculateTierAllocation(newDial);

    this.currentDial = newDial;

    // Generate rebalancing suggestions
    let suggestions: RebalancingSuggestion[] = [];
    if (currentSnapshot) {
      // Create a modified snapshot with new target percentages
      const newTierConfigs = toTierConfigs(newAllocation);
      const newSnapshot = this.tierEngine.evaluate(newTierConfigs);
      suggestions = this.tierEngine.suggestRebalancing(newSnapshot);
    }

    logger.info(
      {
        oldDial,
        newDial,
        oldAllocation,
        newAllocation,
      },
      'Risk dial changed',
    );

    // Emit event
    if (this.eventEmitter) {
      this.eventEmitter({
        type: 'risk_dial_changed',
        oldDial,
        newDial,
        oldAllocation,
        newAllocation,
        timestamp: Date.now(),
      });
    }

    return {
      oldDial,
      newDial,
      oldAllocation,
      newAllocation,
      suggestions,
    };
  }

  /**
   * Reset for test isolation.
   */
  reset(): void {
    this.currentDial = 5;
  }
}
