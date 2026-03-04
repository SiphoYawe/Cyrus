import { CrossChainStrategy } from '../cross-chain-strategy.js';
import type {
  StrategySignal,
  ExecutionPlan,
  StrategyContext,
  StrategyFilter,
  TokenInfo,
} from '../../core/types.js';
import type {
  PairAction,
  BridgeAction,
  ExecutorAction,
} from '../../core/action-types.js';
import { CHAINS, USDC_ADDRESSES } from '../../core/constants.js';
import type { SpreadData } from '../../connectors/pear-protocol-connector.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PearPairTraderConfig {
  readonly pairs: readonly string[];
  readonly zScoreEntryThreshold: number;
  readonly zScoreExitThreshold: number;
  readonly minCorrelation: number;
  readonly minDataPoints: number;
  readonly defaultLeverage: number;
  readonly maxLeverage: number;
  readonly minLeverage: number;
  readonly positionSizeUsdc: bigint;
}

// ---------------------------------------------------------------------------
// Risk tier preset — Growth tier
// ---------------------------------------------------------------------------

const GROWTH_TIER = {
  stoploss: -0.08,
  maxPositions: 3,
  minLeverage: 2,
  maxLeverage: 5,
  defaultLeverage: 3,
  takeProfitMultiplier: 2.0,
  timeLimitMs: 4 * 60 * 60 * 1000, // 4 hours
} as const;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Estimated pair trade execution cost in USD (two-legged execution). */
const ESTIMATED_PAIR_COST_USD = 4;

/** Estimated bridge cost in USD for LI.FI cross-chain transfer. */
const ESTIMATED_BRIDGE_COST_USD = 5;

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

// ---------------------------------------------------------------------------
// Strategy
// ---------------------------------------------------------------------------

/**
 * PearPairTrader — statistical pair trading strategy using Pear Protocol.
 *
 * Monitors spread z-scores between correlated pairs.
 * When spread diverges beyond the entry threshold (>2 std devs by default),
 * goes long the underperformer and short the outperformer with equal notional.
 *
 * Spread data is injected externally via `setSpreadData()` because
 * `shouldExecute()` is synchronous and cannot call APIs.
 */
export class PearPairTrader extends CrossChainStrategy {
  // --- Identity ---
  readonly name = 'PearPairTrader';
  readonly timeframe = '1m';

  // --- Risk parameters (Growth tier) ---
  override readonly stoploss: number = GROWTH_TIER.stoploss;
  override readonly minimalRoi: Readonly<Record<number, number>> = {
    0: Math.abs(GROWTH_TIER.stoploss) * GROWTH_TIER.takeProfitMultiplier,
  };
  override readonly trailingStop: boolean = false;
  override readonly trailingStopPositive: number | undefined = undefined;
  override readonly maxPositions: number = GROWTH_TIER.maxPositions;

  // --- Configuration ---
  readonly config: PearPairTraderConfig;

  // --- Injected spread data ---
  private spreadDataMap: Map<string, SpreadData> = new Map();

  constructor(options?: Partial<PearPairTraderConfig>) {
    super();

    this.config = {
      pairs: options?.pairs ?? ['ETH-BTC', 'SOL-ETH', 'ARB-OP'],
      zScoreEntryThreshold: options?.zScoreEntryThreshold ?? 2.0,
      zScoreExitThreshold: options?.zScoreExitThreshold ?? 0.5,
      minCorrelation: options?.minCorrelation ?? 0.6,
      minDataPoints: options?.minDataPoints ?? 100,
      defaultLeverage: options?.defaultLeverage ?? GROWTH_TIER.defaultLeverage,
      maxLeverage: options?.maxLeverage ?? GROWTH_TIER.maxLeverage,
      minLeverage: options?.minLeverage ?? GROWTH_TIER.minLeverage,
      positionSizeUsdc: options?.positionSizeUsdc ?? DEFAULT_POSITION_SIZE,
    };
  }

  // --- Spread data injection ---

  /** Inject pre-fetched spread data for a specific pair. */
  setSpreadData(pairId: string, data: SpreadData): void {
    this.spreadDataMap.set(pairId, data);
  }

  /** Clear all injected spread data. */
  clearSpreadData(): void {
    this.spreadDataMap.clear();
  }

  // --- Core decision logic ---

  shouldExecute(context: StrategyContext): StrategySignal | null {
    if (this.spreadDataMap.size === 0) {
      return null;
    }

    // Check max positions
    const ownPositions = context.positions.filter((p) => p.strategyId === this.name);
    if (ownPositions.length >= this.maxPositions) {
      return null;
    }

    let bestSignal: StrategySignal | null = null;
    let bestAbsZ = 0;

    for (const pairId of this.config.pairs) {
      const spread = this.spreadDataMap.get(pairId);
      if (!spread) continue;

      // Validate data quality
      if (spread.dataPoints < this.config.minDataPoints) continue;
      if (spread.correlation < this.config.minCorrelation) continue;
      if (spread.standardDeviation === 0) continue;

      const absZ = Math.abs(spread.zScore);

      // Must exceed entry threshold
      if (absZ < this.config.zScoreEntryThreshold) continue;

      if (absZ > bestAbsZ) {
        bestAbsZ = absZ;

        // Parse pair symbols from pairId (e.g. "ETH-BTC" -> ["ETH", "BTC"])
        const [symbolA, symbolB] = pairId.split('-');
        if (!symbolA || !symbolB) continue;

        // Determine which leg is long and which is short:
        // If z-score > 0: spread is above mean -> A outperformed B
        //   -> short A (outperformer), long B (underperformer)
        // If z-score < 0: spread is below mean -> B outperformed A
        //   -> short B (outperformer), long A (underperformer)
        const longSymbol = spread.zScore > 0 ? symbolB : symbolA;
        const shortSymbol = spread.zScore > 0 ? symbolA : symbolB;

        const usdcAddress = USDC_ADDRESSES[CHAINS.ARBITRUM as number]!;
        const usdcToken: TokenInfo = {
          address: usdcAddress,
          symbol: 'USDC',
          decimals: 6,
        };

        const strength = Math.min(absZ / (this.config.zScoreEntryThreshold * 2), 1.0);

        bestSignal = {
          direction: 'long', // pair trade is market-neutral; direction indicates the long leg
          tokenPair: { from: usdcToken, to: usdcToken },
          sourceChain: CHAINS.ARBITRUM,
          destChain: CHAINS.ARBITRUM,
          strength,
          reason: `pair_trade: long ${longSymbol} / short ${shortSymbol} z=${spread.zScore.toFixed(2)} correlation=${spread.correlation.toFixed(2)}`,
          metadata: {
            pairId,
            longSymbol,
            shortSymbol,
            zScore: spread.zScore,
            correlation: spread.correlation,
            currentSpread: spread.currentSpread,
            historicalMean: spread.historicalMean,
            standardDeviation: spread.standardDeviation,
          },
        };
      }
    }

    return bestSignal;
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
          id: nextActionId('pear-bridge'),
          type: 'bridge',
          priority: 1,
          createdAt: now,
          strategyId: this.name,
          fromChain: capitalChain,
          toChain: CHAINS.ARBITRUM,
          fromToken: fromUsdcAddress,
          toToken: toUsdcAddress,
          amount: 0n, // executor resolves actual amount
          metadata: { reason: 'bridge_to_arbitrum_for_pair_trade' },
        };
        actions.push(bridgeAction);
        estimatedCostUsd += ESTIMATED_BRIDGE_COST_USD;
        estimatedDurationMs += 120_000;
      }
    }

    // Build the PairAction
    const pairId = signal.metadata['pairId'] as string;
    const longSymbol = signal.metadata['longSymbol'] as string;
    const shortSymbol = signal.metadata['shortSymbol'] as string;
    const leverage = this.computeLeverage(signal.strength);

    // Equal notional: both legs same USDC size
    const legSize = this.config.positionSizeUsdc;

    const pairAction: PairAction = {
      id: nextActionId('pear-pair'),
      type: 'pair',
      priority: actions.length + 1,
      createdAt: now,
      strategyId: this.name,
      pairId,
      longSymbol,
      shortSymbol,
      longSize: legSize,
      shortSize: legSize,
      leverage,
      metadata: {
        stoploss: this.stoploss,
        takeProfit: this.minimalRoi[0],
        timeLimitMs: GROWTH_TIER.timeLimitMs,
        zScore: signal.metadata['zScore'],
        correlation: signal.metadata['correlation'],
        currentSpread: signal.metadata['currentSpread'],
        signalStrength: signal.strength,
        reason: signal.reason,
      },
    };
    actions.push(pairAction);
    estimatedCostUsd += ESTIMATED_PAIR_COST_USD;
    estimatedDurationMs += 5_000;

    return {
      id: nextActionId('pear-plan'),
      strategyName: this.name,
      actions,
      estimatedCostUsd,
      estimatedDurationMs,
      metadata: {
        pairId,
        longSymbol,
        shortSymbol,
        leverage,
        zScore: signal.metadata['zScore'],
        needsBridge,
      },
    };
  }

  // --- Filters ---

  override filters(): StrategyFilter[] {
    return [
      // Must have spread data
      (_ctx: StrategyContext) => this.spreadDataMap.size > 0,

      // Max positions gate
      (ctx: StrategyContext) => {
        const ownPositions = ctx.positions.filter((p) => p.strategyId === this.name);
        return ownPositions.length < this.maxPositions;
      },
    ];
  }

  // --- Trade confirmation ---

  override confirmTradeEntry(plan: ExecutionPlan): boolean {
    const pairId = plan.metadata['pairId'] as string | undefined;
    if (!pairId) return false;
    return true;
  }

  // ---------------------------------------------------------------------------
  // Private: leverage computation
  // ---------------------------------------------------------------------------

  /**
   * Compute leverage based on signal strength within tier bounds.
   * Stronger signals (higher z-score divergence) get higher leverage.
   */
  private computeLeverage(strength: number): number {
    const { minLeverage, maxLeverage } = this.config;
    const range = maxLeverage - minLeverage;
    const leverage = minLeverage + Math.round(strength * range);
    return Math.max(minLeverage, Math.min(maxLeverage, leverage));
  }
}
