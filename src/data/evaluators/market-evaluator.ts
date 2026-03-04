// MarketEvaluator — scores market microstructure data (Story 7.4)

import { createLogger } from '../../utils/logger.js';
import type { Evaluator, EvaluatorContext, EvaluatorScore, EvaluatorComponent } from '../signal-types.js';
import type { MarketDataService } from '../market-data-service.js';
import type { ChainId, TokenAddress } from '../../core/types.js';

const logger = createLogger('market-evaluator');

const COMPONENT_WEIGHTS = { priceTrend: 0.35, volumeConfirmation: 0.25, fundingRate: 0.20, volatility: 0.20 } as const;

export class MarketEvaluator implements Evaluator {
  readonly name = 'market';
  readonly description = 'Scores market conditions: price trend, volume confirmation, funding rates, volatility regime';

  constructor(private readonly marketData: MarketDataService) {}

  async evaluate(context: EvaluatorContext): Promise<EvaluatorScore> {
    const components: EvaluatorComponent[] = [];
    let availableComponents = 0;
    let totalComponents = 4;

    // Price trend
    const chainId = context.chainId;
    const tokenAddress = context.tokenAddress;
    let priceTrendScore = 0;
    if (chainId && tokenAddress) {
      try {
        const currentPrice = await this.marketData.getTokenPrice(chainId, tokenAddress);
        // Simple price-based trend — in production, compare to historical prices
        priceTrendScore = currentPrice > 0 ? 0.1 : 0; // stub: slightly positive when price exists
        availableComponents++;
      } catch (err) {
        logger.debug({ err, component: 'priceTrend' }, 'Price trend data unavailable');
      }
    }
    components.push({ name: 'priceTrend', score: priceTrendScore, weight: COMPONENT_WEIGHTS.priceTrend, detail: 'Price trend analysis' });

    // Volume confirmation
    let volumeScore = 0;
    if (chainId && tokenAddress) {
      try {
        const volume = await this.marketData.getVolume(tokenAddress, chainId, '24h');
        // buySellRatio > 1 = buying pressure (bullish), < 1 = selling pressure (bearish)
        volumeScore = Math.max(-1, Math.min(1, (volume.buySellRatio - 1) * 2));
        // Volume vs 7d avg confirms trend
        if (volume.volumeVs7dAvg > 1.5) {
          volumeScore *= 1.2; // amplify in high volume
        }
        volumeScore = Math.max(-1, Math.min(1, volumeScore));
        availableComponents++;
      } catch (err) {
        logger.debug({ err, component: 'volumeConfirmation' }, 'Volume data unavailable');
      }
    }
    components.push({ name: 'volumeConfirmation', score: volumeScore, weight: COMPONENT_WEIGHTS.volumeConfirmation, detail: 'Volume confirmation' });

    // Funding rate
    let fundingScore = 0;
    const market = context.token ? `${context.token}-PERP` : null;
    if (market) {
      try {
        const funding = await this.marketData.getFundingRate(market);
        // Positive funding = longs pay shorts (bullish sentiment but reversal risk at extremes)
        if (Math.abs(funding.currentRate) > 0.001) {
          fundingScore = Math.max(-1, Math.min(1, -funding.currentRate * 1000)); // contrarian at extremes
        } else {
          fundingScore = funding.currentRate > 0 ? 0.1 : -0.1;
        }
        availableComponents++;
      } catch (err) {
        logger.debug({ err, component: 'fundingRate' }, 'Funding rate data unavailable');
      }
    }
    components.push({ name: 'fundingRate', score: fundingScore, weight: COMPONENT_WEIGHTS.fundingRate, detail: 'Funding rate signal' });

    // Volatility regime
    let volScore = 0;
    if (tokenAddress) {
      try {
        const vol = await this.marketData.getVolatility(tokenAddress, '24h');
        // High volatility = lower confidence, but direction depends on Bollinger position
        if (vol.bollingerWidth > 0) {
          // Price below middle = bearish, above = bullish, width indicates magnitude
          volScore = vol.bollingerWidth > 0.1 ? -0.1 : 0.1; // high width = uncertainty
        }
        availableComponents++;
      } catch (err) {
        logger.debug({ err, component: 'volatility' }, 'Volatility data unavailable');
      }
    }
    components.push({ name: 'volatility', score: volScore, weight: COMPONENT_WEIGHTS.volatility, detail: 'Volatility regime' });

    // Combine
    const totalWeight = components.reduce((s, c) => s + c.weight, 0);
    const score = totalWeight > 0
      ? components.reduce((s, c) => s + c.score * c.weight, 0) / totalWeight
      : 0;

    const confidence = Math.max(0, Math.min(1, availableComponents / totalComponents));

    const reasoning = components.map(c => `${c.name}: ${c.score > 0 ? '+' : ''}${c.score.toFixed(2)}`).join('; ');

    return {
      score: Math.max(-1, Math.min(1, score)),
      confidence,
      reasoning,
      components,
    };
  }
}
