// Signal matrix types for Story 7.4 — OctoBot Multi-Evaluator Scoring

import type { ChainId, TokenAddress, StrategyContext } from '../core/types.js';

// String literal unions — no enums
export type SignalRecommendation = 'strong_buy' | 'buy' | 'neutral' | 'sell' | 'strong_sell';

export interface EvaluatorComponent {
  readonly name: string;
  readonly score: number; // -1 to +1
  readonly weight: number;
  readonly detail: string;
}

export interface EvaluatorScore {
  readonly score: number; // -1 to +1
  readonly confidence: number; // 0 to 1
  readonly reasoning: string;
  readonly components: readonly EvaluatorComponent[];
}

export interface EvaluatorContext {
  readonly token: string;
  readonly tokenAddress: TokenAddress | null;
  readonly chainId: ChainId | null;
  readonly timestamp: number;
  readonly strategyContext: StrategyContext;
}

export interface Evaluator {
  readonly name: string;
  readonly description: string;
  evaluate(context: EvaluatorContext): Promise<EvaluatorScore>;
}

export interface EvaluatorBreakdownEntry {
  readonly evaluatorName: string;
  readonly score: number;
  readonly confidence: number;
  readonly weight: number;
  readonly reasoning: string;
}

export interface CompositeScore {
  readonly overallScore: number; // -1 to +1
  readonly aggregateConfidence: number; // 0 to 1
  readonly recommendation: SignalRecommendation;
  readonly evaluatorBreakdown: readonly EvaluatorBreakdownEntry[];
  readonly timestamp: number;
  readonly token: string;
}

export type EvaluatorWeightConfig = Record<string, number>;

export interface RecommendationThresholds {
  readonly strongBuy: number;
  readonly buy: number;
  readonly sell: number;
  readonly strongSell: number;
}

export const DEFAULT_WEIGHTS: EvaluatorWeightConfig = {
  onchain: 0.25,
  market: 0.30,
  social: 0.20,
  technical: 0.25,
} as const;

export const DEFAULT_THRESHOLDS: RecommendationThresholds = {
  strongBuy: 0.6,
  buy: 0.2,
  sell: -0.2,
  strongSell: -0.6,
} as const;
