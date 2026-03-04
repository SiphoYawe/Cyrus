import { CrossChainStrategy } from '../cross-chain-strategy.js';
import type {
  StrategySignal,
  ExecutionPlan,
  StrategyContext,
  StrategyFilter,
  ChainId,
  TokenAddress,
  TokenInfo,
} from '../../core/types.js';
import { chainId, tokenAddress } from '../../core/types.js';
import type {
  PerpAction,
  BridgeAction,
  ExecutorAction,
} from '../../core/action-types.js';
import { CHAINS, USDC_ADDRESSES } from '../../core/constants.js';
import { Store } from '../../core/store.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PerpSubStrategy = 'funding_arb' | 'momentum' | 'mean_reversion' | 'auto';
export type RiskTier = 'growth' | 'degen';

export interface HyperliquidPerpsConfig {
  readonly mode: PerpSubStrategy;
  readonly tier: RiskTier;
  readonly markets: readonly string[];
  readonly fundingThreshold: number;
  readonly momentumRocPeriod: number;
  readonly momentumFastMa: number;
  readonly momentumSlowMa: number;
  readonly momentumVolumeMultiplier: number;
  readonly meanReversionWindow: number;
  readonly meanReversionStdDevThreshold: number;
}

export interface PerpMarketData {
  readonly fundingRates: Map<string, { rate: number; premium: number; timestamp: number }>;
  readonly ohlcv: Map<string, { open: number; high: number; low: number; close: number; volume: number }[]>;
  readonly volumes: Map<string, number[]>;
}

// ---------------------------------------------------------------------------
// Risk tier presets
// ---------------------------------------------------------------------------

const GROWTH_TIER = {
  stoploss: -0.05,
  minLeverage: 2,
  maxLeverage: 5,
  defaultLeverage: 3,
  maxPositions: 3,
  takeProfitMultiplier: 2.0,
  timeLimitMs: 4 * 60 * 60 * 1000, // 4 hours
} as const;

const DEGEN_TIER = {
  stoploss: -0.10,
  minLeverage: 5,
  maxLeverage: 20,
  defaultLeverage: 10,
  maxPositions: 5,
  takeProfitMultiplier: 3.0,
  timeLimitMs: 8 * 60 * 60 * 1000, // 8 hours
} as const;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Estimated bridge cost in USD for LI.FI cross-chain transfer. */
const ESTIMATED_BRIDGE_COST_USD = 5;

/** Estimated perp execution cost in USD (gas + exchange fees). */
const ESTIMATED_PERP_COST_USD = 2;

/** Annualized funding periods (8h funding intervals, 3 per day, 365 days). */
const FUNDING_PERIODS_PER_YEAR = 3 * 365;

/** Default position size in USDC (6 decimals). */
const DEFAULT_POSITION_SIZE = 100_000_000n; // 100 USDC

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let actionCounter = 0;
function nextActionId(prefix: string): string {
  actionCounter += 1;
  return `${prefix}-${Date.now()}-${actionCounter}`;
}

/**
 * Compute simple moving average over the last `period` values in an array.
 * Returns NaN if insufficient data.
 */
function sma(values: readonly number[], period: number): number {
  if (values.length < period) return NaN;
  const slice = values.slice(-period);
  return slice.reduce((sum, v) => sum + v, 0) / period;
}

/**
 * Compute rolling standard deviation over the last `window` values.
 * Returns NaN if insufficient data.
 */
function rollingStdDev(values: readonly number[], window: number): number {
  if (values.length < window) return NaN;
  const slice = values.slice(-window);
  const mean = slice.reduce((sum, v) => sum + v, 0) / window;
  const variance = slice.reduce((sum, v) => sum + (v - mean) ** 2, 0) / window;
  return Math.sqrt(variance);
}

/**
 * Compute rate of change (ROC) over the given period.
 * ROC = (current - pastValue) / pastValue
 * Returns NaN if insufficient data.
 */
function rateOfChange(values: readonly number[], period: number): number {
  if (values.length < period + 1) return NaN;
  const current = values[values.length - 1]!;
  const past = values[values.length - 1 - period]!;
  if (past === 0) return NaN;
  return (current - past) / past;
}

// ---------------------------------------------------------------------------
// Strategy
// ---------------------------------------------------------------------------

/**
 * HyperliquidPerps -- autonomous perpetuals trading strategy.
 *
 * Supports four sub-strategy modes:
 *  1. funding_arb  -- collect funding by shorting high-funding markets
 *  2. momentum     -- trend-following via ROC + MA crossover + volume
 *  3. mean_reversion -- counter-trend on extreme standard deviation moves
 *  4. auto         -- dynamically picks the best mode based on market regime
 *
 * All perp execution targets Hyperliquid on Arbitrum (chain 42161).
 * If capital is not on Arbitrum, a LI.FI bridge action is prepended.
 *
 * Market data is injected externally via `setMarketData()` because
 * `shouldExecute()` is synchronous and cannot call APIs.
 */
export class HyperliquidPerps extends CrossChainStrategy {
  // --- Identity ---
  readonly name = 'HyperliquidPerps';
  readonly timeframe = '1m';

  // --- Risk parameters (set by tier in constructor) ---
  override readonly stoploss: number;
  override readonly minimalRoi: Readonly<Record<number, number>>;
  override readonly trailingStop: boolean = true;
  override readonly trailingStopPositive: number | undefined = 0.01;
  override readonly maxPositions: number;

  // --- Configuration ---
  readonly config: HyperliquidPerpsConfig;

  // --- Tier presets ---
  private readonly tierPreset: typeof GROWTH_TIER | typeof DEGEN_TIER;

  // --- Injected market data ---
  private marketData: PerpMarketData | null = null;

  constructor(options?: Partial<HyperliquidPerpsConfig>) {
    super();

    this.config = {
      mode: options?.mode ?? 'auto',
      tier: options?.tier ?? 'growth',
      markets: options?.markets ?? ['ETH', 'BTC', 'SOL'],
      fundingThreshold: options?.fundingThreshold ?? 0.0001,
      momentumRocPeriod: options?.momentumRocPeriod ?? 14,
      momentumFastMa: options?.momentumFastMa ?? 9,
      momentumSlowMa: options?.momentumSlowMa ?? 21,
      momentumVolumeMultiplier: options?.momentumVolumeMultiplier ?? 1.5,
      meanReversionWindow: options?.meanReversionWindow ?? 20,
      meanReversionStdDevThreshold: options?.meanReversionStdDevThreshold ?? 2.0,
    };

    this.tierPreset = this.config.tier === 'degen' ? DEGEN_TIER : GROWTH_TIER;
    this.stoploss = this.tierPreset.stoploss;
    this.maxPositions = this.tierPreset.maxPositions;
    this.minimalRoi = { 0: Math.abs(this.tierPreset.stoploss) * this.tierPreset.takeProfitMultiplier };
  }

  // --- Market data injection ---

  /** Inject pre-fetched market data for the strategy to evaluate. */
  setMarketData(data: PerpMarketData): void {
    this.marketData = data;
  }

  // --- Core decision logic ---

  shouldExecute(context: StrategyContext): StrategySignal | null {
    if (!this.marketData) {
      return null;
    }

    // Check max positions
    const ownPositions = context.positions.filter((p) => p.strategyId === this.name);
    if (ownPositions.length >= this.maxPositions) {
      return null;
    }

    const mode = this.resolveMode();

    switch (mode) {
      case 'funding_arb':
        return this.evaluateFundingArb(context);
      case 'momentum':
        return this.evaluateMomentum(context);
      case 'mean_reversion':
        return this.evaluateMeanReversion(context);
      default:
        return null;
    }
  }

  // --- Execution plan builder ---

  buildExecution(signal: StrategySignal, context: StrategyContext): ExecutionPlan {
    const now = Date.now();
    const actions: ExecutorAction[] = [];
    let estimatedCostUsd = 0;
    let estimatedDurationMs = 0;

    // Determine if capital needs bridging to Arbitrum
    const capitalChain = signal.sourceChain;
    const needsBridge = (capitalChain as number) !== (CHAINS.ARBITRUM as number);

    if (needsBridge) {
      const fromUsdcAddress = USDC_ADDRESSES[capitalChain as number];
      const toUsdcAddress = USDC_ADDRESSES[CHAINS.ARBITRUM as number];

      if (fromUsdcAddress && toUsdcAddress) {
        const bridgeAction: BridgeAction = {
          id: nextActionId('hl-bridge'),
          type: 'bridge',
          priority: 1,
          createdAt: now,
          strategyId: this.name,
          fromChain: capitalChain,
          toChain: CHAINS.ARBITRUM,
          fromToken: fromUsdcAddress,
          toToken: toUsdcAddress,
          amount: 0n, // executor resolves actual amount
          metadata: { reason: 'bridge_to_arbitrum_for_perps' },
        };
        actions.push(bridgeAction);
        estimatedCostUsd += ESTIMATED_BRIDGE_COST_USD;
        estimatedDurationMs += 120_000;
      }
    }

    // Build the PerpAction
    const symbol = signal.metadata['symbol'] as string;
    const side = signal.direction === 'long' ? 'long' : 'short';
    const leverage = this.computeLeverage(signal.strength);

    const perpAction: PerpAction = {
      id: nextActionId('hl-perp'),
      type: 'perp',
      priority: actions.length + 1,
      createdAt: now,
      strategyId: this.name,
      symbol,
      side,
      size: DEFAULT_POSITION_SIZE,
      leverage,
      orderType: 'market',
      metadata: {
        subStrategy: signal.metadata['subStrategy'],
        stoploss: this.stoploss,
        takeProfit: this.minimalRoi[0],
        timeLimitMs: this.tierPreset.timeLimitMs,
        tier: this.config.tier,
        signalStrength: signal.strength,
        reason: signal.reason,
      },
    };
    actions.push(perpAction);
    estimatedCostUsd += ESTIMATED_PERP_COST_USD;
    estimatedDurationMs += 5_000;

    return {
      id: nextActionId('hl-plan'),
      strategyName: this.name,
      actions,
      estimatedCostUsd,
      estimatedDurationMs,
      metadata: {
        symbol,
        side,
        leverage,
        subStrategy: signal.metadata['subStrategy'],
        tier: this.config.tier,
        needsBridge,
      },
    };
  }

  // --- Filters ---

  override filters(): StrategyFilter[] {
    return [
      // Must have market data
      (_ctx: StrategyContext) => this.marketData !== null,

      // Max positions gate
      (ctx: StrategyContext) => {
        const ownPositions = ctx.positions.filter((p) => p.strategyId === this.name);
        return ownPositions.length < this.maxPositions;
      },
    ];
  }

  // --- Trade confirmation ---

  override confirmTradeEntry(plan: ExecutionPlan): boolean {
    const subStrategy = plan.metadata['subStrategy'] as string | undefined;
    if (!subStrategy) return false;
    return true;
  }

  // ---------------------------------------------------------------------------
  // Private: sub-strategy evaluators
  // ---------------------------------------------------------------------------

  /**
   * Funding arb: scan funding rates, find markets with significantly positive
   * funding, generate short signal to collect funding.
   * Net yield = annualized funding - estimated costs.
   * Returns null if net yield is negative.
   */
  private evaluateFundingArb(_context: StrategyContext): StrategySignal | null {
    if (!this.marketData) return null;

    const { fundingRates } = this.marketData;
    if (fundingRates.size === 0) return null;

    let bestSymbol: string | null = null;
    let bestNetYield = 0;
    let bestRate = 0;

    for (const symbol of this.config.markets) {
      const funding = fundingRates.get(symbol);
      if (!funding) continue;

      // Only consider significantly positive funding rates (longs pay shorts)
      if (funding.rate < this.config.fundingThreshold) continue;

      // Annualize the funding rate
      const annualizedFunding = funding.rate * FUNDING_PERIODS_PER_YEAR;

      // Estimate annualized costs: gas + exchange fees as % of position
      const estimatedAnnualCostPercent = 0.02; // ~2% annualized cost
      const netYield = annualizedFunding - estimatedAnnualCostPercent;

      if (netYield > bestNetYield) {
        bestNetYield = netYield;
        bestSymbol = symbol;
        bestRate = funding.rate;
      }
    }

    if (bestSymbol === null || bestNetYield <= 0) {
      return null;
    }

    // Build USDC token info for the signal's tokenPair
    const usdcAddress = USDC_ADDRESSES[CHAINS.ARBITRUM as number]!;
    const usdcToken: TokenInfo = {
      address: usdcAddress,
      symbol: 'USDC',
      decimals: 6,
    };

    return {
      direction: 'short',
      tokenPair: { from: usdcToken, to: usdcToken },
      sourceChain: CHAINS.ARBITRUM,
      destChain: CHAINS.ARBITRUM,
      strength: Math.min(bestNetYield / 0.5, 1.0), // normalize: 50% annualized yield = strength 1.0
      reason: `funding_arb: short ${bestSymbol} to collect ${(bestRate * 100).toFixed(4)}% funding (${(bestNetYield * 100).toFixed(1)}% net annualized)`,
      metadata: {
        subStrategy: 'funding_arb',
        symbol: bestSymbol,
        fundingRate: bestRate,
        annualizedNetYield: bestNetYield,
      },
    };
  }

  /**
   * Momentum: calculate ROC over lookback, MA crossover (fast vs slow),
   * volume confirmation.
   * Long when ROC > 0, fast MA > slow MA, volume > multiplier * avg.
   * Short when ROC < 0, fast MA < slow MA, volume > multiplier * avg.
   */
  private evaluateMomentum(_context: StrategyContext): StrategySignal | null {
    if (!this.marketData) return null;

    const { ohlcv, volumes } = this.marketData;
    let bestSignal: StrategySignal | null = null;
    let bestStrength = 0;

    for (const symbol of this.config.markets) {
      const candles = ohlcv.get(symbol);
      const volumeArr = volumes.get(symbol);

      if (!candles || !volumeArr) continue;

      // Extract close prices
      const closes = candles.map((c) => c.close);

      // Need enough data for the slow MA and ROC
      const minRequired = Math.max(
        this.config.momentumSlowMa,
        this.config.momentumRocPeriod + 1,
      );
      if (closes.length < minRequired) continue;

      // Calculate indicators
      const roc = rateOfChange(closes, this.config.momentumRocPeriod);
      const fastMa = sma(closes, this.config.momentumFastMa);
      const slowMa = sma(closes, this.config.momentumSlowMa);

      if (isNaN(roc) || isNaN(fastMa) || isNaN(slowMa)) continue;

      // Volume confirmation
      const avgVolume = sma(volumeArr, this.config.momentumSlowMa);
      const currentVolume = volumeArr[volumeArr.length - 1];
      if (
        isNaN(avgVolume) ||
        avgVolume === 0 ||
        currentVolume === undefined ||
        currentVolume < avgVolume * this.config.momentumVolumeMultiplier
      ) {
        continue;
      }

      // Determine direction
      let direction: 'long' | 'short' | null = null;
      if (roc > 0 && fastMa > slowMa) {
        direction = 'long';
      } else if (roc < 0 && fastMa < slowMa) {
        direction = 'short';
      }

      if (direction === null) continue;

      // Compute signal strength based on ROC magnitude and volume ratio
      const volumeRatio = currentVolume / avgVolume;
      const rocMagnitude = Math.abs(roc);
      const strength = Math.min((rocMagnitude * 10 + volumeRatio * 0.1), 1.0);

      if (strength > bestStrength) {
        bestStrength = strength;

        const usdcAddress = USDC_ADDRESSES[CHAINS.ARBITRUM as number]!;
        const usdcToken: TokenInfo = {
          address: usdcAddress,
          symbol: 'USDC',
          decimals: 6,
        };

        const currentPrice = closes[closes.length - 1]!;

        bestSignal = {
          direction,
          tokenPair: { from: usdcToken, to: usdcToken },
          sourceChain: CHAINS.ARBITRUM,
          destChain: CHAINS.ARBITRUM,
          strength,
          reason: `momentum: ${direction} ${symbol} ROC=${(roc * 100).toFixed(2)}% fastMA=${fastMa.toFixed(2)} slowMA=${slowMa.toFixed(2)} vol=${volumeRatio.toFixed(1)}x`,
          metadata: {
            subStrategy: 'momentum',
            symbol,
            roc,
            fastMa,
            slowMa,
            volumeRatio,
            currentPrice,
          },
        };
      }
    }

    return bestSignal;
  }

  /**
   * Mean reversion: calculate rolling mean and std dev.
   * If price > mean + threshold*stddev -> short signal.
   * If price < mean - threshold*stddev -> long signal.
   */
  private evaluateMeanReversion(_context: StrategyContext): StrategySignal | null {
    if (!this.marketData) return null;

    const { ohlcv } = this.marketData;
    let bestSignal: StrategySignal | null = null;
    let bestDeviation = 0;

    for (const symbol of this.config.markets) {
      const candles = ohlcv.get(symbol);
      if (!candles) continue;

      const closes = candles.map((c) => c.close);
      if (closes.length < this.config.meanReversionWindow) continue;

      const mean = sma(closes, this.config.meanReversionWindow);
      const stdDev = rollingStdDev(closes, this.config.meanReversionWindow);

      if (isNaN(mean) || isNaN(stdDev) || stdDev === 0) continue;

      const currentPrice = closes[closes.length - 1]!;
      const zScore = (currentPrice - mean) / stdDev;
      const absZ = Math.abs(zScore);

      if (absZ < this.config.meanReversionStdDevThreshold) continue;

      // Direction is counter-trend
      const direction: 'long' | 'short' = zScore > 0 ? 'short' : 'long';

      if (absZ > bestDeviation) {
        bestDeviation = absZ;

        const usdcAddress = USDC_ADDRESSES[CHAINS.ARBITRUM as number]!;
        const usdcToken: TokenInfo = {
          address: usdcAddress,
          symbol: 'USDC',
          decimals: 6,
        };

        const strength = Math.min(absZ / (this.config.meanReversionStdDevThreshold * 2), 1.0);

        bestSignal = {
          direction,
          tokenPair: { from: usdcToken, to: usdcToken },
          sourceChain: CHAINS.ARBITRUM,
          destChain: CHAINS.ARBITRUM,
          strength,
          reason: `mean_reversion: ${direction} ${symbol} z=${zScore.toFixed(2)} price=${currentPrice.toFixed(2)} mean=${mean.toFixed(2)} stdDev=${stdDev.toFixed(2)}`,
          metadata: {
            subStrategy: 'mean_reversion',
            symbol,
            zScore,
            currentPrice,
            mean,
            stdDev,
          },
        };
      }
    }

    return bestSignal;
  }

  // ---------------------------------------------------------------------------
  // Private: auto mode
  // ---------------------------------------------------------------------------

  /**
   * Resolve the active sub-strategy mode.
   * In 'auto' mode, consults the store's regime classification:
   *   crab -> funding_arb, trending (bull/bear) -> momentum, volatile -> mean_reversion
   * Falls back to funding_arb if no regime data available.
   */
  private resolveMode(): PerpSubStrategy {
    if (this.config.mode !== 'auto') {
      return this.config.mode;
    }

    return this.evaluateAutoMode();
  }

  /**
   * Auto mode: get market regime from store and map to sub-strategy.
   */
  private evaluateAutoMode(): PerpSubStrategy {
    const store = Store.getInstance();
    const regime = store.getLatestRegime();

    if (!regime) {
      return 'funding_arb'; // safe fallback
    }

    switch (regime.regime) {
      case 'crab':
        return 'funding_arb';
      case 'bull':
      case 'bear':
        return 'momentum';
      case 'volatile':
        return 'mean_reversion';
      default:
        return 'funding_arb';
    }
  }

  // ---------------------------------------------------------------------------
  // Private: leverage computation
  // ---------------------------------------------------------------------------

  /**
   * Compute leverage based on signal strength and tier.
   * Stronger signals get higher leverage within tier bounds.
   */
  private computeLeverage(strength: number): number {
    const { minLeverage, maxLeverage } = this.tierPreset;
    const range = maxLeverage - minLeverage;
    const leverage = minLeverage + Math.round(strength * range);
    return Math.max(minLeverage, Math.min(maxLeverage, leverage));
  }
}
