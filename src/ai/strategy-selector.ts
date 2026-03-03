import { createLogger } from '../utils/logger.js';
import { Store } from '../core/store.js';
import type { MarketRegime, StrategyTier, StrategySelectionResult } from './types.js';

const logger = createLogger('strategy-selector');

// Regime-to-tier compatibility mapping (deterministic, not AI)
const REGIME_TIER_MAP: Record<MarketRegime, readonly StrategyTier[]> = {
  bull: ['growth', 'degen', 'yield'],
  bear: ['safe', 'hedging'],
  crab: ['yield', 'safe'],
  volatile: ['hedging', 'safe'],
} as const;

export interface StrategyMetadata {
  readonly name: string;
  readonly tier: StrategyTier;
  isActive: boolean;
}

export class StrategySelector {
  private readonly store: Store;

  constructor() {
    this.store = Store.getInstance();
  }

  selectStrategies(
    regime: MarketRegime,
    availableStrategies: readonly StrategyMetadata[],
  ): StrategySelectionResult {
    const compatibleTiers = REGIME_TIER_MAP[regime];
    const activate: string[] = [];
    const deactivate: string[] = [];

    for (const strategy of availableStrategies) {
      if (compatibleTiers.includes(strategy.tier)) {
        if (!strategy.isActive) {
          activate.push(strategy.name);
        }
      } else {
        if (strategy.isActive) {
          deactivate.push(strategy.name);
        }
      }
    }

    const reasoning = `Regime "${regime}" favors ${compatibleTiers.join(', ')} tiers. ` +
      `Activating ${activate.length} strategies, deactivating ${deactivate.length} strategies.`;

    const result: StrategySelectionResult = {
      activate,
      deactivate,
      reasoning,
      timestamp: Date.now(),
    };

    // Store decision report for strategy changes
    if (activate.length > 0 || deactivate.length > 0) {
      const activeNames = availableStrategies
        .filter(s => s.isActive)
        .map(s => s.name);

      const newActive = [...activeNames.filter(n => !deactivate.includes(n)), ...activate];

      this.store.emitter.emit('strategy_selection_changed', {
        previous: activeNames,
        current: newActive,
        regime,
      });

      logger.info(
        { regime, activated: activate, deactivated: deactivate },
        'Strategy selection updated',
      );
    }

    return result;
  }

  getCompatibleTiers(regime: MarketRegime): readonly StrategyTier[] {
    return REGIME_TIER_MAP[regime];
  }
}

export { REGIME_TIER_MAP };
