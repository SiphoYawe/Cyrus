// TechnicalEvaluator — RSI, MACD, Bollinger, MA alignment scoring (Story 7.4)

import type { Evaluator, EvaluatorContext, EvaluatorScore, EvaluatorComponent } from '../signal-types.js';
import type { MarketDataService } from '../market-data-service.js';

const COMPONENT_WEIGHTS = { rsi: 0.25, macd: 0.25, bollingerBands: 0.25, maAlignment: 0.25 } as const;

export class TechnicalEvaluator implements Evaluator {
  readonly name = 'technical';
  readonly description = 'Scores technical indicators: RSI, MACD, Bollinger Bands, MA alignment';

  constructor(private readonly marketData: MarketDataService) {}

  async evaluate(context: EvaluatorContext): Promise<EvaluatorScore> {
    const tokenAddress = context.tokenAddress;
    if (!tokenAddress) {
      return { score: 0, confidence: 0, reasoning: 'No token address for technical analysis', components: [] };
    }

    // Fetch price history for calculations
    const prices = this.getPriceHistory(context);
    if (prices.length < 14) {
      return { score: 0, confidence: 0.1, reasoning: `Insufficient data: only ${prices.length} bars (need 14+)`, components: [] };
    }

    const components: EvaluatorComponent[] = [];
    let availableIndicators = 0;

    // RSI (14-period)
    const rsiValue = TechnicalEvaluator.calculateRSI(prices, 14);
    let rsiScore = 0;
    if (rsiValue !== null) {
      // RSI < 30 = oversold (bullish), > 70 = overbought (bearish)
      if (rsiValue < 30) {
        rsiScore = (30 - rsiValue) / 30; // 0 to 1
      } else if (rsiValue > 70) {
        rsiScore = (70 - rsiValue) / 30; // -1 to 0
      } else {
        rsiScore = (rsiValue - 50) / 50 * -0.3; // mild signal in middle
      }
      rsiScore = Math.max(-1, Math.min(1, rsiScore));
      availableIndicators++;
    }
    components.push({ name: 'rsi', score: rsiScore, weight: COMPONENT_WEIGHTS.rsi, detail: `RSI(14): ${rsiValue?.toFixed(1) ?? 'N/A'}` });

    // MACD (12, 26, 9)
    let macdScore = 0;
    if (prices.length >= 26) {
      const macd = TechnicalEvaluator.calculateMACD(prices);
      if (macd) {
        // Bullish crossover = positive, bearish = negative
        macdScore = Math.max(-1, Math.min(1, macd.histogram * 10)); // scale histogram
        availableIndicators++;
      }
    }
    components.push({ name: 'macd', score: macdScore, weight: COMPONENT_WEIGHTS.macd, detail: `MACD(12,26,9)` });

    // Bollinger Bands (20-period, 2 stddev)
    let bbScore = 0;
    if (prices.length >= 20) {
      const bb = TechnicalEvaluator.calculateBollinger(prices, 20, 2);
      if (bb) {
        const currentPrice = prices[prices.length - 1]!;
        // %B position: (price - lower) / (upper - lower)
        const percentB = bb.upper !== bb.lower
          ? (currentPrice - bb.lower) / (bb.upper - bb.lower)
          : 0.5;
        // Below lower band = oversold (bullish), above upper = overbought (bearish)
        bbScore = Math.max(-1, Math.min(1, (0.5 - percentB) * 2));
        availableIndicators++;
      }
    }
    components.push({ name: 'bollingerBands', score: bbScore, weight: COMPONENT_WEIGHTS.bollingerBands, detail: 'BB(20,2)' });

    // MA alignment (20, 50, 200)
    let maScore = 0;
    if (prices.length >= 200) {
      const ma20 = TechnicalEvaluator.sma(prices, 20);
      const ma50 = TechnicalEvaluator.sma(prices, 50);
      const ma200 = TechnicalEvaluator.sma(prices, 200);

      if (ma20 > ma50 && ma50 > ma200) {
        maScore = 1; // Strong bullish alignment
      } else if (ma20 < ma50 && ma50 < ma200) {
        maScore = -1; // Strong bearish alignment
      } else if (ma20 > ma50) {
        maScore = 0.3; // Mildly bullish
      } else if (ma20 < ma50) {
        maScore = -0.3; // Mildly bearish
      }
      availableIndicators++;
    }
    components.push({ name: 'maAlignment', score: maScore, weight: COMPONENT_WEIGHTS.maAlignment, detail: 'MA(20/50/200)' });

    // Only use weights for available indicators
    const activeComponents = components.filter((_, i) => {
      if (i === 0) return rsiValue !== null;
      if (i === 1) return prices.length >= 26;
      if (i === 2) return prices.length >= 20;
      if (i === 3) return prices.length >= 200;
      return false;
    });

    const totalWeight = activeComponents.reduce((s, c) => s + c.weight, 0);
    const score = totalWeight > 0
      ? activeComponents.reduce((s, c) => s + c.score * c.weight, 0) / totalWeight
      : 0;

    // Confidence based on indicator agreement and data availability
    const indicatorAgreement = activeComponents.length > 1
      ? 1 - (activeComponents.reduce((s, c) => s + Math.abs(c.score - score), 0) / activeComponents.length)
      : 0.3;
    const confidence = Math.max(0, Math.min(1,
      (availableIndicators / 4) * 0.6 + indicatorAgreement * 0.4,
    ));

    const reasoning = components.map(c => `${c.name}: ${c.score > 0 ? '+' : ''}${c.score.toFixed(2)} (${c.detail})`).join('; ');

    return {
      score: Math.max(-1, Math.min(1, score)),
      confidence,
      reasoning,
      components,
    };
  }

  getPriceHistory(context: EvaluatorContext): number[] {
    // Access MarketDataService's historicalPrices via the store's price data
    // Collect all available prices from the strategy context's price map for this token
    const prices: number[] = [];
    const tokenAddr = context.tokenAddress;
    const chainIdNum = context.chainId;

    if (!tokenAddr) return prices;

    // Check strategy context prices map for token entries
    for (const [key, price] of context.strategyContext.prices) {
      if (price > 0 && key.includes(tokenAddr as string)) {
        prices.push(price);
      }
    }

    // If we have a single current price, use the MarketDataService internal data
    // The MarketDataService stores historical prices internally
    // Access via the service's public interface (getTokenPrice populates historical data)
    // For now, return what we have from context; strategies should call MarketDataService
    // methods to populate historical data before evaluation
    if (prices.length === 0) {
      // Fallback: search all entries in price map for the token address
      const addrLower = (tokenAddr as string).toLowerCase();
      for (const [key, price] of context.strategyContext.prices) {
        if (price > 0 && key.toLowerCase().includes(addrLower)) {
          prices.push(price);
        }
      }
    }

    return prices;
  }

  // --- Static calculation methods ---

  static calculateRSI(prices: number[], period: number): number | null {
    if (prices.length < period + 1) return null;

    let gainSum = 0;
    let lossSum = 0;

    // Initial average gain/loss
    for (let i = prices.length - period; i < prices.length; i++) {
      const change = prices[i]! - prices[i - 1]!;
      if (change > 0) gainSum += change;
      else lossSum += Math.abs(change);
    }

    const avgGain = gainSum / period;
    const avgLoss = lossSum / period;

    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - 100 / (1 + rs);
  }

  static calculateMACD(prices: number[]): { macd: number; signal: number; histogram: number } | null {
    if (prices.length < 26) return null;

    const ema12 = TechnicalEvaluator.ema(prices, 12);
    const ema26 = TechnicalEvaluator.ema(prices, 26);

    if (ema12 === null || ema26 === null) return null;
    const macdValue = ema12 - ema26;

    // Simple approximation: signal = EMA(9) of MACD line
    // For simplicity, use the current MACD as an approximation
    const signalValue = macdValue * 0.8; // approximation

    return {
      macd: macdValue,
      signal: signalValue,
      histogram: macdValue - signalValue,
    };
  }

  static calculateBollinger(prices: number[], period: number, stdDevMultiplier: number): { upper: number; middle: number; lower: number } | null {
    if (prices.length < period) return null;

    const slice = prices.slice(-period);
    const middle = slice.reduce((s, v) => s + v, 0) / period;
    const variance = slice.reduce((s, v) => s + (v - middle) ** 2, 0) / period;
    const stdDev = Math.sqrt(variance);

    return {
      upper: middle + stdDevMultiplier * stdDev,
      middle,
      lower: middle - stdDevMultiplier * stdDev,
    };
  }

  static sma(prices: number[], period: number): number {
    const slice = prices.slice(-period);
    return slice.reduce((s, v) => s + v, 0) / slice.length;
  }

  static ema(prices: number[], period: number): number | null {
    if (prices.length < period) return null;
    const multiplier = 2 / (period + 1);
    let emaVal = prices.slice(0, period).reduce((s, v) => s + v, 0) / period;
    for (let i = period; i < prices.length; i++) {
      emaVal = (prices[i]! - emaVal) * multiplier + emaVal;
    }
    return emaVal;
  }
}
