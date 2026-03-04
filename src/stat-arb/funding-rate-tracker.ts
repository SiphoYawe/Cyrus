// FundingRateTracker — monitors funding rates on open pair positions
// Tracks per-tick funding, cumulative totals, and excessive funding warnings

import { createLogger } from '../utils/logger.js';
import type { HyperliquidConnectorInterface } from '../connectors/hyperliquid-connector.js';
import type { StatArbPosition } from '../core/store-slices/stat-arb-slice.js';

const logger = createLogger('funding-rate-tracker');

// --- Interfaces ---

export interface FundingTick {
  readonly timestamp: number;
  readonly longSymbol: string;
  readonly shortSymbol: string;
  readonly longRate: number;
  readonly shortRate: number;
  readonly longPayment: bigint;
  readonly shortPayment: bigint;
  readonly netPayment: bigint;
  readonly cumulativeNet: bigint;
}

export interface FundingSummary {
  readonly positionId: string;
  readonly longTotal: bigint;
  readonly shortTotal: bigint;
  readonly netTotal: bigint;
  readonly tickCount: number;
  readonly dailyRate: number;
  readonly history: readonly FundingTick[];
}

export interface FundingExposureResult {
  readonly fundingExcessive: boolean;
  readonly dailyNetRate: number;
  readonly tightenedMaxLossPercent: number;
}

export interface FundingTrackerConfig {
  readonly excessiveFundingThreshold: number; // daily % threshold (default -1.0)
  readonly stoplossAdjustment: number; // percentage points to tighten (default 5)
}

const DEFAULT_CONFIG: FundingTrackerConfig = {
  excessiveFundingThreshold: -1.0,
  stoplossAdjustment: 5,
} as const;

// Funding rate scaling: rates are 8-hour decimals (e.g., 0.0001 = 0.01% per 8h)
// Convert to bigint-compatible by scaling to 18 decimal precision
const RATE_PRECISION = 10n ** 18n;

function rateToBigint(rate: number): bigint {
  // Scale the rate to 18 decimal precision for bigint multiplication
  return BigInt(Math.round(rate * Number(RATE_PRECISION)));
}

function bigintToNumber(value: bigint, decimals: number = 18): number {
  const divisor = 10n ** BigInt(decimals);
  const intPart = value / divisor;
  const fracPart = value % divisor;
  return Number(intPart) + Number(fracPart) / Number(divisor);
}

// --- FundingRateTracker ---

export class FundingRateTracker {
  private readonly connector: HyperliquidConnectorInterface;
  private readonly config: FundingTrackerConfig;
  private readonly fundingHistory = new Map<string, FundingTick[]>();
  private readonly completedFunding = new Map<string, FundingSummary>();

  constructor(connector: HyperliquidConnectorInterface, config?: Partial<FundingTrackerConfig>) {
    this.connector = connector;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async updateFunding(position: StatArbPosition): Promise<FundingTick | null> {
    const longSymbol = position.legA.side === 'long' ? position.legA.symbol : position.legB.symbol;
    const shortSymbol = position.legA.side === 'short' ? position.legA.symbol : position.legB.symbol;
    const longLeg = position.legA.side === 'long' ? position.legA : position.legB;
    const shortLeg = position.legA.side === 'short' ? position.legA : position.legB;

    try {
      const fundingRates = await this.connector.queryFundingRates();

      const longFundingData = fundingRates.get(longSymbol);
      const shortFundingData = fundingRates.get(shortSymbol);

      const longRate = longFundingData ? parseFloat(longFundingData.fundingRate) : 0;
      const shortRate = shortFundingData ? parseFloat(shortFundingData.fundingRate) : 0;

      // Log predicted rates if available (informational only, AC7)
      if (longFundingData?.premium !== undefined || shortFundingData?.premium !== undefined) {
        logger.debug(
          {
            longSymbol,
            shortSymbol,
            longPremium: longFundingData?.premium,
            shortPremium: shortFundingData?.premium,
          },
          'Predicted next funding rates (informational only)',
        );
      }

      // Calculate funding payments
      // Long pays positive funding, receives negative
      // longPayment = longSize * longRate * longEntryPrice
      const longSizeBig = BigInt(Math.round(longLeg.size * 1e18));
      const longEntryBig = BigInt(Math.round(longLeg.entryPrice * 1e18));
      const longRateBig = rateToBigint(longRate);
      const longPayment = -(longSizeBig * longRateBig * longEntryBig / RATE_PRECISION / RATE_PRECISION);

      // Short receives positive funding, pays negative (inverse)
      const shortSizeBig = BigInt(Math.round(shortLeg.size * 1e18));
      const shortEntryBig = BigInt(Math.round(shortLeg.entryPrice * 1e18));
      const shortRateBig = rateToBigint(shortRate);
      const shortPayment = shortSizeBig * shortRateBig * shortEntryBig / RATE_PRECISION / RATE_PRECISION;

      const netPayment = longPayment + shortPayment;

      // Get previous cumulative
      const history = this.fundingHistory.get(position.positionId) ?? [];
      const prevCumulative = history.length > 0 ? history[history.length - 1].cumulativeNet : 0n;
      const cumulativeNet = prevCumulative + netPayment;

      const tick: FundingTick = {
        timestamp: Date.now(),
        longSymbol,
        shortSymbol,
        longRate,
        shortRate,
        longPayment,
        shortPayment,
        netPayment,
        cumulativeNet,
      };

      if (!this.fundingHistory.has(position.positionId)) {
        this.fundingHistory.set(position.positionId, []);
      }
      this.fundingHistory.get(position.positionId)!.push(tick);

      return tick;
    } catch (error) {
      logger.warn(
        { positionId: position.positionId, error: error instanceof Error ? error.message : String(error) },
        'Failed to query funding rates, skipping tick',
      );
      return null;
    }
  }

  getCumulativeFunding(positionId: string): FundingSummary {
    const history = this.fundingHistory.get(positionId) ?? [];

    let longTotal = 0n;
    let shortTotal = 0n;
    let netTotal = 0n;

    for (const tick of history) {
      longTotal += tick.longPayment;
      shortTotal += tick.shortPayment;
      netTotal += tick.netPayment;
    }

    // Calculate daily rate by extrapolating from tick data
    let dailyRate = 0;
    if (history.length >= 2) {
      const firstTimestamp = history[0].timestamp;
      const lastTimestamp = history[history.length - 1].timestamp;
      const durationMs = lastTimestamp - firstTimestamp;
      if (durationMs > 0) {
        const netPerMs = bigintToNumber(netTotal) / durationMs;
        dailyRate = netPerMs * 86_400_000; // ms per day
      }
    }

    return {
      positionId,
      longTotal,
      shortTotal,
      netTotal,
      tickCount: history.length,
      dailyRate,
      history,
    };
  }

  checkFundingExposure(position: StatArbPosition, maxLossPercent: number): FundingExposureResult {
    const summary = this.getCumulativeFunding(position.positionId);

    // Calculate daily net funding rate as % of margin
    const marginValue = position.marginUsed;
    let dailyNetRate = 0;

    if (marginValue > 0 && summary.tickCount >= 2) {
      const history = summary.history;
      const firstTs = history[0].timestamp;
      const lastTs = history[history.length - 1].timestamp;
      const durationDays = (lastTs - firstTs) / 86_400_000;

      if (durationDays > 0) {
        const netFundingValue = bigintToNumber(summary.netTotal);
        dailyNetRate = (netFundingValue / marginValue / durationDays) * 100;
      }
    }

    const fundingExcessive = dailyNetRate < this.config.excessiveFundingThreshold;

    if (fundingExcessive) {
      logger.warn(
        {
          positionId: position.positionId,
          pair: position.pair.key,
          dailyNetRate: `${dailyNetRate.toFixed(3)}%`,
          threshold: `${this.config.excessiveFundingThreshold}%`,
        },
        'Excessive funding cost detected. Tightening stoploss.',
      );
    }

    // Tighten stoploss: e.g., from -30% to -25% (add adjustment to make less negative = tighter)
    const tightenedMaxLossPercent = fundingExcessive
      ? maxLossPercent + this.config.stoplossAdjustment
      : maxLossPercent;

    return {
      fundingExcessive,
      dailyNetRate,
      tightenedMaxLossPercent,
    };
  }

  finalizeFunding(positionId: string): FundingSummary {
    const summary = this.getCumulativeFunding(positionId);

    // Archive and clean up
    this.completedFunding.set(positionId, summary);
    this.fundingHistory.delete(positionId);

    return summary;
  }

  getCompletedFunding(positionId: string): FundingSummary | undefined {
    return this.completedFunding.get(positionId);
  }
}
