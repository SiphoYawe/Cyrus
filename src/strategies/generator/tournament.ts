// Tournament — ranks strategy variants and selects top performers for paper-trading

import { createLogger } from '../../utils/logger.js';
import type { TournamentResult, GenerationConfig } from './types.js';

const logger = createLogger('tournament');

/**
 * Tournament implements selection logic for strategy variants.
 *
 * Pipeline:
 * 1. Filter: eliminate variants with Sharpe < 0 or max drawdown > threshold
 * 2. Sort: rank remaining by Sharpe ratio descending
 * 3. Promote: top N variants advance to paper-trading
 */
export class Tournament {
  /**
   * Run tournament selection on backtest results.
   *
   * @param results - Map of variantId -> TournamentResult with backtest metrics
   * @param config - Generation config with tournament parameters
   * @returns Full results array with rankings, including eliminated variants
   */
  select(
    results: Map<string, TournamentResult>,
    config: GenerationConfig,
  ): TournamentResult[] {
    const allResults = Array.from(results.values());

    // Phase 1: Elimination — filter out poor performers
    for (const result of allResults) {
      if (result.sharpeRatio < 0) {
        result.eliminated = true;
        result.eliminationReason = 'Sharpe ratio below 0';
      } else if (result.maxDrawdown > config.maxDrawdownThreshold) {
        result.eliminated = true;
        result.eliminationReason = `Max drawdown ${(result.maxDrawdown * 100).toFixed(1)}% exceeds threshold ${(config.maxDrawdownThreshold * 100).toFixed(1)}%`;
      }
    }

    // Phase 2: Sort non-eliminated by Sharpe descending
    const survivors = allResults.filter((r) => !r.eliminated);
    survivors.sort((a, b) => b.sharpeRatio - a.sharpeRatio);

    // Phase 3: Assign ranks and promote top N
    for (let i = 0; i < survivors.length; i++) {
      survivors[i].rank = i + 1;
      if (i < config.tournamentTopN) {
        survivors[i].promotedToPaperTrading = true;
      }
    }

    // Assign rank to eliminated variants (ranked after all survivors)
    const eliminated = allResults.filter((r) => r.eliminated);
    for (let i = 0; i < eliminated.length; i++) {
      eliminated[i].rank = survivors.length + i + 1;
    }

    // Log tournament summary
    const promotedCount = survivors.filter((r) => r.promotedToPaperTrading).length;
    const topSharpe = survivors.length > 0 ? survivors[0].sharpeRatio : 0;

    logger.info(
      {
        totalVariants: allResults.length,
        eliminatedCount: eliminated.length,
        promotedCount,
        topSharpe: topSharpe.toFixed(2),
      },
      'Tournament selection complete',
    );

    return allResults;
  }
}
