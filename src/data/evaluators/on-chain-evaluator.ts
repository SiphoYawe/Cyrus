// OnChainEvaluator — scores on-chain signals from OnChainIndexer (Story 7.4)

import type { Evaluator, EvaluatorContext, EvaluatorScore, EvaluatorComponent } from '../signal-types.js';
import type { OnChainIndexer } from '../on-chain-indexer.js';
import type { TvlChangeEvent, WhaleTradeEvent, LiquidityChangeEvent, FlowPatternEvent } from '../on-chain-types.js';

const COMPONENT_WEIGHTS = { tvl: 0.25, whale: 0.30, liquidity: 0.20, accumulation: 0.25 } as const;

export class OnChainEvaluator implements Evaluator {
  readonly name = 'onchain';
  readonly description = 'Scores on-chain activity: TVL flows, whale movements, liquidity changes, accumulation patterns';

  constructor(private readonly indexer: OnChainIndexer) {}

  async evaluate(context: EvaluatorContext): Promise<EvaluatorScore> {
    const lookbackMs = 4 * 3600_000; // 4 hours
    const fromTs = context.timestamp - lookbackMs;

    const events = this.indexer.queryEvents({
      fromTimestamp: fromTs,
      toTimestamp: context.timestamp,
    });

    if (events.length === 0) {
      return { score: 0, confidence: 0.1, reasoning: 'No recent on-chain events', components: [] };
    }

    const components: EvaluatorComponent[] = [];

    // TVL component — use discriminated union narrowing
    const tvlEvents = events.filter((e): e is TvlChangeEvent => e.type === 'tvl_change');
    let tvlScore = 0;
    if (tvlEvents.length > 0) {
      const netChange = tvlEvents.reduce((sum, e) => sum + e.changePercent, 0);
      tvlScore = Math.max(-1, Math.min(1, netChange / 10)); // 10% = max score
    }
    components.push({ name: 'tvl', score: tvlScore, weight: COMPONENT_WEIGHTS.tvl, detail: `${tvlEvents.length} TVL events` });

    // Whale component
    const whaleEvents = events.filter((e): e is WhaleTradeEvent => e.type === 'whale_trade');
    let whaleScore = 0;
    if (whaleEvents.length > 0) {
      let buyVol = 0;
      let sellVol = 0;
      for (const e of whaleEvents) {
        if (e.direction === 'buy') buyVol += e.amountUsd;
        else sellVol += e.amountUsd;
      }
      const total = buyVol + sellVol;
      whaleScore = total > 0 ? Math.max(-1, Math.min(1, (buyVol - sellVol) / total)) : 0;
    }
    components.push({ name: 'whale', score: whaleScore, weight: COMPONENT_WEIGHTS.whale, detail: `${whaleEvents.length} whale trades` });

    // Liquidity component
    const liqEvents = events.filter((e): e is LiquidityChangeEvent => e.type === 'liquidity_change');
    let liqScore = 0;
    if (liqEvents.length > 0) {
      let adds = 0;
      let removes = 0;
      for (const e of liqEvents) {
        if (e.direction === 'add') adds++;
        else removes++;
      }
      const total = adds + removes;
      liqScore = total > 0 ? Math.max(-1, Math.min(1, (adds - removes) / total)) : 0;
    }
    components.push({ name: 'liquidity', score: liqScore, weight: COMPONENT_WEIGHTS.liquidity, detail: `${liqEvents.length} liquidity events` });

    // Accumulation/distribution component
    const flowEvents = events.filter((e): e is FlowPatternEvent => e.type === 'flow_pattern');
    let accScore = 0;
    if (flowEvents.length > 0) {
      let accCount = 0;
      let distCount = 0;
      for (const e of flowEvents) {
        if (e.patternType === 'accumulation') accCount++;
        else if (e.patternType === 'distribution') distCount++;
      }
      const total = accCount + distCount;
      accScore = total > 0 ? Math.max(-1, Math.min(1, (accCount - distCount) / total)) : 0;
    }
    components.push({ name: 'accumulation', score: accScore, weight: COMPONENT_WEIGHTS.accumulation, detail: `${flowEvents.length} flow patterns` });

    // Combine
    const score = components.reduce((s, c) => s + c.score * c.weight, 0) /
      components.reduce((s, c) => s + c.weight, 0);

    // Confidence based on event count and freshness
    const eventFreshness = events.length > 0
      ? 1 - (context.timestamp - Math.max(...events.map(e => e.timestamp))) / lookbackMs
      : 0;
    const confidence = Math.min(1, Math.max(0,
      (Math.min(events.length, 20) / 20) * 0.7 + eventFreshness * 0.3,
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
