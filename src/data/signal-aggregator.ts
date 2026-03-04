// Signal Aggregator — OctoBot-inspired multi-evaluator weighted scoring (Story 7.4)

import { createLogger } from '../utils/logger.js';
import { DEFAULT_WEIGHTS, DEFAULT_THRESHOLDS } from './signal-types.js';
import type {
  Evaluator,
  EvaluatorContext,
  EvaluatorScore,
  EvaluatorWeightConfig,
  CompositeScore,
  EvaluatorBreakdownEntry,
  SignalRecommendation,
  RecommendationThresholds,
} from './signal-types.js';

const logger = createLogger('signal-aggregator');

export class SignalAggregator {
  private readonly evaluators = new Map<string, Evaluator>();
  private readonly defaultWeights: EvaluatorWeightConfig;
  private readonly thresholds: RecommendationThresholds;

  constructor(
    defaultWeights: EvaluatorWeightConfig = DEFAULT_WEIGHTS,
    evaluators: Evaluator[] = [],
    thresholds: RecommendationThresholds = DEFAULT_THRESHOLDS,
  ) {
    this.defaultWeights = { ...defaultWeights };
    this.thresholds = thresholds;
    for (const ev of evaluators) {
      this.evaluators.set(ev.name, ev);
    }
  }

  registerEvaluator(evaluator: Evaluator): void {
    this.evaluators.set(evaluator.name, evaluator);
  }

  unregisterEvaluator(name: string): void {
    this.evaluators.delete(name);
  }

  getRegisteredEvaluators(): readonly Evaluator[] {
    return [...this.evaluators.values()];
  }

  async evaluate(
    context: EvaluatorContext,
    weightOverrides?: EvaluatorWeightConfig,
  ): Promise<CompositeScore> {
    const evaluatorList = [...this.evaluators.values()];
    if (evaluatorList.length === 0) {
      return this.neutralResult(context.token, context.timestamp);
    }

    // Run all evaluators concurrently
    const results = await Promise.allSettled(
      evaluatorList.map(ev => ev.evaluate(context)),
    );

    // Collect successful results
    const scores: Array<{ evaluator: Evaluator; score: EvaluatorScore; weight: number }> = [];
    const breakdown: EvaluatorBreakdownEntry[] = [];
    let failedCount = 0;

    for (let i = 0; i < results.length; i++) {
      const result = results[i]!;
      const evaluator = evaluatorList[i]!;
      const weight = this.resolveWeight(evaluator.name, weightOverrides);

      if (result.status === 'fulfilled') {
        scores.push({ evaluator, score: result.value, weight });
        breakdown.push({
          evaluatorName: evaluator.name,
          score: result.value.score,
          confidence: result.value.confidence,
          weight,
          reasoning: result.value.reasoning,
        });
      } else {
        failedCount++;
        logger.warn(
          { evaluator: evaluator.name, error: result.reason },
          'Evaluator failed, excluding from composite',
        );
        breakdown.push({
          evaluatorName: evaluator.name,
          score: 0,
          confidence: 0,
          weight,
          reasoning: `Failed: ${(result.reason as Error)?.message ?? 'unknown error'}`,
        });
      }
    }

    if (scores.length === 0) {
      return this.neutralResult(context.token, context.timestamp, breakdown);
    }

    // Weighted average: compositeScore = sum(score * weight) / sum(weight)
    let weightedSum = 0;
    let totalWeight = 0;
    let weightedConfidence = 0;

    for (const { score, weight } of scores) {
      weightedSum += score.score * weight;
      totalWeight += weight;
      weightedConfidence += score.confidence * weight;
    }

    const compositeScore = Math.max(-1, Math.min(1, weightedSum / totalWeight));

    // Confidence penalized by failed evaluator ratio
    const successRatio = scores.length / evaluatorList.length;
    const aggregateConfidence = Math.max(0, Math.min(1,
      (weightedConfidence / totalWeight) * successRatio,
    ));

    return {
      overallScore: compositeScore,
      aggregateConfidence,
      recommendation: this.getRecommendation(compositeScore),
      evaluatorBreakdown: breakdown,
      timestamp: context.timestamp,
      token: context.token,
    };
  }

  getRecommendation(score: number, thresholds?: RecommendationThresholds): SignalRecommendation {
    const t = thresholds ?? this.thresholds;
    if (score >= t.strongBuy) return 'strong_buy';
    if (score >= t.buy) return 'buy';
    if (score > t.sell) return 'neutral';
    if (score > t.strongSell) return 'sell';
    return 'strong_sell';
  }

  private resolveWeight(name: string, overrides?: EvaluatorWeightConfig): number {
    if (overrides && name in overrides) return overrides[name]!;
    if (name in this.defaultWeights) return this.defaultWeights[name]!;
    return 1.0;
  }

  private neutralResult(
    token: string,
    timestamp: number,
    breakdown: EvaluatorBreakdownEntry[] = [],
  ): CompositeScore {
    return {
      overallScore: 0,
      aggregateConfidence: 0,
      recommendation: 'neutral',
      evaluatorBreakdown: breakdown,
      timestamp,
      token,
    };
  }
}
