// SocialEvaluator — scores social sentiment from SocialSentinel (Story 7.4)

import type { Evaluator, EvaluatorContext, EvaluatorScore, EvaluatorComponent } from '../signal-types.js';
import type { SocialSentinel } from '../social-sentinel.js';
import { URGENCY_ORDINAL } from '../social-types.js';

const COMPONENT_WEIGHTS = { sentiment: 0.30, volume: 0.25, influencer: 0.25, urgency: 0.20 } as const;

export class SocialEvaluator implements Evaluator {
  readonly name = 'social';
  readonly description = 'Scores social sentiment: aggregate sentiment, signal volume, influencer weight, urgency level';

  constructor(private readonly sentinel: SocialSentinel) {}

  async evaluate(context: EvaluatorContext): Promise<EvaluatorScore> {
    const token = context.token;
    if (!token) {
      return { score: 0, confidence: 0, reasoning: 'No token specified', components: [] };
    }

    const signals = this.sentinel.getSignalsForToken(token);
    if (signals.length === 0) {
      return { score: 0, confidence: 0.1, reasoning: `No social signals for ${token}`, components: [] };
    }

    const components: EvaluatorComponent[] = [];

    // Aggregate sentiment — mean sentiment across all signals
    const meanSentiment = signals.reduce((sum, s) => sum + s.sentimentScore, 0) / signals.length;
    components.push({
      name: 'sentiment',
      score: Math.max(-1, Math.min(1, meanSentiment)),
      weight: COMPONENT_WEIGHTS.sentiment,
      detail: `Mean sentiment: ${meanSentiment.toFixed(2)} from ${signals.length} signals`,
    });

    // Signal volume — more signals = higher confidence in direction
    const volumeScore = Math.max(-1, Math.min(1, meanSentiment * Math.min(signals.length / 10, 1)));
    components.push({
      name: 'volume',
      score: volumeScore,
      weight: COMPONENT_WEIGHTS.volume,
      detail: `${signals.length} signals detected`,
    });

    // Influencer weight — follower-weighted sentiment average
    let followerWeightedSum = 0;
    let totalFollowers = 0;
    for (const s of signals) {
      const followers = s.context.authorFollowers ?? 1;
      followerWeightedSum += s.sentimentScore * followers;
      totalFollowers += followers;
    }
    const influencerScore = totalFollowers > 0 ? followerWeightedSum / totalFollowers : 0;
    components.push({
      name: 'influencer',
      score: Math.max(-1, Math.min(1, influencerScore)),
      weight: COMPONENT_WEIGHTS.influencer,
      detail: `Follower-weighted sentiment: ${influencerScore.toFixed(2)}`,
    });

    // Urgency level — high/critical urgency amplifies score
    const highUrgencyCount = signals.filter(s => URGENCY_ORDINAL[s.urgency] >= 2).length;
    const urgencyMultiplier = highUrgencyCount > 0 ? 1.0 + (highUrgencyCount / signals.length) * 0.5 : 0.5;
    const urgencyScore = Math.max(-1, Math.min(1, meanSentiment * urgencyMultiplier));
    components.push({
      name: 'urgency',
      score: urgencyScore,
      weight: COMPONENT_WEIGHTS.urgency,
      detail: `${highUrgencyCount}/${signals.length} high/critical urgency`,
    });

    // Combine
    const totalWeight = components.reduce((s, c) => s + c.weight, 0);
    const score = totalWeight > 0
      ? components.reduce((s, c) => s + c.score * c.weight, 0) / totalWeight
      : 0;

    // Confidence based on signal count and source diversity
    const uniqueSources = new Set(signals.map(s => s.source));
    const sourceDiversity = uniqueSources.size / 4; // max 4 sources
    const confidence = Math.min(1, Math.max(0,
      (Math.min(signals.length, 10) / 10) * 0.6 + sourceDiversity * 0.4,
    ));

    const reasoning = components.map(c => `${c.name}: ${c.score > 0 ? '+' : ''}${c.score.toFixed(2)} (${c.detail})`).join('; ');

    return {
      score: Math.max(-1, Math.min(1, score)),
      confidence,
      reasoning,
      components,
    };
  }
}
