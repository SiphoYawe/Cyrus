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
  SwapAction,
  BridgeAction,
  ExecutorAction,
} from '../../core/action-types.js';
import { CHAINS, USDC_ADDRESSES } from '../../core/constants.js';
import { Store } from '../../core/store.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MemeSignalType =
  | 'volume_spike'
  | 'whale_buy'
  | 'new_liquidity'
  | 'social_mention'
  | 'token_age_24h';

export interface DetectedSignal {
  readonly type: MemeSignalType;
  readonly tokenAddress: TokenAddress;
  readonly tokenSymbol: string;
  readonly chainId: ChainId;
  readonly magnitude: number;
  readonly timestamp: number;
}

export interface OpportunityScore {
  readonly token: TokenAddress;
  readonly tokenSymbol: string;
  readonly chain: ChainId;
  readonly totalScore: number;
  readonly signals: readonly DetectedSignal[];
  readonly timestamp: number;
}

export interface MemeSignalData {
  readonly signals: readonly DetectedSignal[];
}

export interface MemeTraderConfig {
  readonly entryThreshold: number;
  readonly maxPositionPercent: number;
  readonly trailPercent: number;
  readonly timeLimitMs: number;
  readonly cooldownMs: number;
  readonly slippageTolerance: number;
  readonly signalWeights: Readonly<Record<MemeSignalType, number>>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_SIGNAL_WEIGHTS: Readonly<Record<MemeSignalType, number>> = {
  volume_spike: 20,
  whale_buy: 25,
  new_liquidity: 15,
  social_mention: 20,
  token_age_24h: 20,
} as const;

const DEFAULT_CONFIG: MemeTraderConfig = {
  entryThreshold: 60,
  maxPositionPercent: 0.02,
  trailPercent: 0.15,
  timeLimitMs: 4 * 60 * 60 * 1000, // 4 hours
  cooldownMs: 1 * 60 * 60 * 1000, // 1 hour
  slippageTolerance: 0.02,
  signalWeights: DEFAULT_SIGNAL_WEIGHTS,
} as const;

/** Estimated bridge cost in USD for LI.FI cross-chain transfer. */
const ESTIMATED_BRIDGE_COST_USD = 5;

/** Estimated swap execution cost in USD (gas + DEX fees). */
const ESTIMATED_SWAP_COST_USD = 3;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let actionCounter = 0;
function nextActionId(prefix: string): string {
  actionCounter += 1;
  return `${prefix}-${Date.now()}-${actionCounter}`;
}

/**
 * Create a composite key for a token across chains.
 * Used for cooldown tracking and signal grouping.
 */
function tokenKey(addr: TokenAddress, chain: ChainId): string {
  return `${chain}-${addr}`;
}

// ---------------------------------------------------------------------------
// Strategy
// ---------------------------------------------------------------------------

/**
 * MemeTrader -- memecoin / degen detection strategy.
 *
 * Scores meme tokens based on multiple on-chain and social signals:
 *  - volume_spike: sudden volume increase (e.g. 10x = magnitude 10)
 *  - whale_buy: large single-wallet buy detected
 *  - new_liquidity: fresh liquidity pool added
 *  - social_mention: social media buzz detected
 *  - token_age_24h: token is young (< 24h old)
 *
 * Each signal type has a configurable weight. A token's composite score
 * is the sum of (weight * clamp(magnitude, 0, 1)) for each signal type
 * detected on that token. The max possible score is 100 (all 5 signal
 * types at magnitude >= 1).
 *
 * Signal data is injected externally via `setSignalData()` because
 * `shouldExecute()` is synchronous and cannot call APIs.
 *
 * Features:
 * - Trailing stop at 15% to protect gains
 * - 4-hour time limit per position
 * - 1-hour cooldown before re-entering the same token
 * - High slippage tolerance (2%) for illiquid meme tokens
 * - Position capped at 2% of portfolio
 */
export class MemeTrader extends CrossChainStrategy {
  // --- Identity ---
  readonly name = 'MemeTrader';
  readonly timeframe = '30s';

  // --- Risk parameters (degen tier) ---
  override readonly stoploss: number = -0.15;
  override readonly minimalRoi: Readonly<Record<number, number>> = { 0: 0.30 };
  override readonly trailingStop: boolean = true;
  override readonly trailingStopPositive: number | undefined = 0.15;
  override readonly maxPositions: number = 5;

  // --- Configuration ---
  readonly config: MemeTraderConfig;

  // --- Injected signal data ---
  private signalData: MemeSignalData | null = null;

  // --- Cooldown tracking ---
  // tokenKey -> timestamp of last exit/entry. Prevents re-entering the same token
  // within cooldownMs.
  readonly recentEntries: Map<string, number> = new Map();

  constructor(options?: Partial<MemeTraderConfig>) {
    super();

    this.config = {
      entryThreshold: options?.entryThreshold ?? DEFAULT_CONFIG.entryThreshold,
      maxPositionPercent: options?.maxPositionPercent ?? DEFAULT_CONFIG.maxPositionPercent,
      trailPercent: options?.trailPercent ?? DEFAULT_CONFIG.trailPercent,
      timeLimitMs: options?.timeLimitMs ?? DEFAULT_CONFIG.timeLimitMs,
      cooldownMs: options?.cooldownMs ?? DEFAULT_CONFIG.cooldownMs,
      slippageTolerance: options?.slippageTolerance ?? DEFAULT_CONFIG.slippageTolerance,
      signalWeights: options?.signalWeights ?? DEFAULT_CONFIG.signalWeights,
    };
  }

  // --- Signal data injection ---

  /** Inject pre-fetched signal data for the strategy to evaluate. */
  setSignalData(data: MemeSignalData): void {
    this.signalData = data;
  }

  // --- Core decision logic ---

  shouldExecute(context: StrategyContext): StrategySignal | null {
    if (!this.signalData || this.signalData.signals.length === 0) {
      return null;
    }

    // Check max positions
    const ownPositions = context.positions.filter((p) => p.strategyId === this.name);
    if (ownPositions.length >= this.maxPositions) {
      return null;
    }

    // Group signals by token
    const grouped = this.groupSignalsByToken(this.signalData.signals);

    // Score each token
    const scored: OpportunityScore[] = [];
    for (const [key, signals] of grouped) {
      const firstSignal = signals[0]!;
      const score = this.calculateCompositeScore(signals);
      scored.push({
        token: firstSignal.tokenAddress,
        tokenSymbol: firstSignal.tokenSymbol,
        chain: firstSignal.chainId,
        totalScore: score,
        signals,
        timestamp: context.timestamp,
      });
    }

    // Sort by score descending
    scored.sort((a, b) => b.totalScore - a.totalScore);

    // Find the best token above threshold that passes cooldown
    for (const opportunity of scored) {
      if (opportunity.totalScore < this.config.entryThreshold) {
        break; // sorted descending, so no more above threshold
      }

      // Check cooldown
      const key = tokenKey(opportunity.token, opportunity.chain);
      const lastEntry = this.recentEntries.get(key);
      if (lastEntry !== undefined) {
        const elapsed = context.timestamp - lastEntry;
        if (elapsed < this.config.cooldownMs) {
          continue; // still in cooldown
        }
      }

      // Record this entry
      this.recentEntries.set(key, context.timestamp);

      // Find the source chain with the most USDC balance
      const sourceChain = this.findCapitalChain(context, opportunity.chain);

      // Build token info
      const usdcAddress = USDC_ADDRESSES[sourceChain as number];
      const fromToken: TokenInfo = usdcAddress
        ? { address: usdcAddress, symbol: 'USDC', decimals: 6 }
        : { address: tokenAddress('0x0000000000000000000000000000000000000000'), symbol: 'USDC', decimals: 6 };

      const toToken: TokenInfo = {
        address: opportunity.token,
        symbol: opportunity.tokenSymbol,
        decimals: 18, // most meme tokens are 18 decimals
      };

      // Normalize score to 0-1 strength (score out of max 100)
      const strength = Math.min(opportunity.totalScore / 100, 1.0);

      const signalTypes = opportunity.signals.map((s) => s.type).join(', ');

      return {
        direction: 'long',
        tokenPair: { from: fromToken, to: toToken },
        sourceChain,
        destChain: opportunity.chain,
        strength,
        reason: `meme_entry: buy ${opportunity.tokenSymbol} on chain ${opportunity.chain as number} score=${opportunity.totalScore.toFixed(1)} signals=[${signalTypes}]`,
        metadata: {
          totalScore: opportunity.totalScore,
          signals: opportunity.signals,
          signalTypes,
          trailingStopPercent: this.config.trailPercent,
          timeLimitMs: this.config.timeLimitMs,
        },
      };
    }

    return null;
  }

  // --- Execution plan builder ---

  buildExecution(signal: StrategySignal, context: StrategyContext): ExecutionPlan {
    const now = Date.now();
    const actions: ExecutorAction[] = [];
    let estimatedCostUsd = 0;
    let estimatedDurationMs = 0;

    // Calculate position size: min(maxPositionPercent of portfolio, available balance on source chain)
    const positionSize = this.calculatePositionSize(context, signal.sourceChain);

    // Check if capital needs bridging to the token's chain
    const needsBridge = (signal.sourceChain as number) !== (signal.destChain as number);

    if (needsBridge) {
      const fromUsdcAddress = USDC_ADDRESSES[signal.sourceChain as number];
      const toUsdcAddress = USDC_ADDRESSES[signal.destChain as number];

      if (fromUsdcAddress && toUsdcAddress) {
        const bridgeAction: BridgeAction = {
          id: nextActionId('meme-bridge'),
          type: 'bridge',
          priority: 1,
          createdAt: now,
          strategyId: this.name,
          fromChain: signal.sourceChain,
          toChain: signal.destChain,
          fromToken: fromUsdcAddress,
          toToken: toUsdcAddress,
          amount: positionSize,
          metadata: { reason: 'bridge_capital_for_meme_buy' },
        };
        actions.push(bridgeAction);
        estimatedCostUsd += ESTIMATED_BRIDGE_COST_USD;
        estimatedDurationMs += 120_000; // ~2 minutes for bridge
      }
    }

    // Build the SwapAction: USDC -> meme token
    const swapFromToken = USDC_ADDRESSES[signal.destChain as number]
      ?? signal.tokenPair.from.address;

    const swapAction: SwapAction = {
      id: nextActionId('meme-swap'),
      type: 'swap',
      priority: actions.length + 1,
      createdAt: now,
      strategyId: this.name,
      fromChain: signal.destChain,
      toChain: signal.destChain,
      fromToken: swapFromToken,
      toToken: signal.tokenPair.to.address,
      amount: positionSize,
      slippage: this.config.slippageTolerance,
      metadata: {
        tokenSymbol: signal.tokenPair.to.symbol,
        totalScore: signal.metadata['totalScore'],
        trailingStopPercent: this.config.trailPercent,
        timeLimitMs: this.config.timeLimitMs,
        stoploss: this.stoploss,
        signalTypes: signal.metadata['signalTypes'],
      },
    };
    actions.push(swapAction);
    estimatedCostUsd += ESTIMATED_SWAP_COST_USD;
    estimatedDurationMs += 30_000; // ~30 seconds for swap

    return {
      id: nextActionId('meme-plan'),
      strategyName: this.name,
      actions,
      estimatedCostUsd,
      estimatedDurationMs,
      metadata: {
        tokenSymbol: signal.tokenPair.to.symbol,
        totalScore: signal.metadata['totalScore'],
        needsBridge,
        trailingStopPercent: this.config.trailPercent,
        timeLimitMs: this.config.timeLimitMs,
        positionSizeRaw: positionSize.toString(),
        slippage: this.config.slippageTolerance,
      },
    };
  }

  // --- Filters ---

  override filters(): StrategyFilter[] {
    return [
      // Must have signal data
      (_ctx: StrategyContext) => this.signalData !== null,

      // Max positions gate
      (ctx: StrategyContext) => {
        const ownPositions = ctx.positions.filter((p) => p.strategyId === this.name);
        return ownPositions.length < this.maxPositions;
      },
    ];
  }

  // --- Trade confirmation ---

  override confirmTradeEntry(plan: ExecutionPlan): boolean {
    const totalScore = plan.metadata['totalScore'] as number | undefined;
    if (totalScore === undefined || totalScore < this.config.entryThreshold) {
      return false;
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // Private: signal grouping and scoring
  // ---------------------------------------------------------------------------

  /**
   * Group detected signals by token (tokenAddress + chainId).
   * Returns a map of tokenKey -> signals for that token.
   */
  private groupSignalsByToken(
    signals: readonly DetectedSignal[],
  ): Map<string, DetectedSignal[]> {
    const grouped = new Map<string, DetectedSignal[]>();

    for (const signal of signals) {
      const key = tokenKey(signal.tokenAddress, signal.chainId);
      const existing = grouped.get(key);
      if (existing) {
        existing.push(signal);
      } else {
        grouped.set(key, [signal]);
      }
    }

    return grouped;
  }

  /**
   * Calculate composite score for a set of signals on a single token.
   *
   * For each signal type, take the maximum magnitude among signals of that type,
   * clamp it to [0, 1], and multiply by the weight.
   *
   * Max possible score = sum of all weights = 100 (with default weights).
   */
  private calculateCompositeScore(signals: readonly DetectedSignal[]): number {
    // Group by signal type, take max magnitude per type
    const maxMagnitudes = new Map<MemeSignalType, number>();

    for (const signal of signals) {
      const current = maxMagnitudes.get(signal.type) ?? 0;
      if (signal.magnitude > current) {
        maxMagnitudes.set(signal.type, signal.magnitude);
      }
    }

    let score = 0;
    for (const [signalType, magnitude] of maxMagnitudes) {
      const weight = this.config.signalWeights[signalType] ?? 0;
      const clampedMagnitude = Math.min(Math.max(magnitude, 0), 1);
      score += weight * clampedMagnitude;
    }

    return score;
  }

  // ---------------------------------------------------------------------------
  // Private: position sizing
  // ---------------------------------------------------------------------------

  /**
   * Calculate position size as min(maxPositionPercent * totalPortfolioUsd, availableBalance).
   * Returns amount in USDC units (6 decimals).
   */
  private calculatePositionSize(context: StrategyContext, sourceChain: ChainId): bigint {
    // Calculate total portfolio value in USD from balances
    const store = Store.getInstance();
    const allBalances = store.getAllBalances();

    let totalPortfolioUsd = 0;
    for (const balance of allBalances) {
      totalPortfolioUsd += balance.usdValue;
    }

    // If no balance data in store, fallback to context balances with prices
    if (totalPortfolioUsd === 0) {
      for (const [key, amount] of context.balances) {
        const price = context.prices.get(key) ?? 0;
        // Assume 6 decimals for USDC-like tokens
        totalPortfolioUsd += Number(amount) / 1e6 * price;
      }
    }

    // Max position size based on percentage
    const maxPositionUsd = totalPortfolioUsd * this.config.maxPositionPercent;
    const maxPositionAmount = BigInt(Math.floor(maxPositionUsd * 1e6)); // 6 decimals

    // Available USDC on source chain
    const usdcAddress = USDC_ADDRESSES[sourceChain as number];
    const availableBalance = usdcAddress
      ? store.getAvailableBalance(sourceChain, usdcAddress)
      : 0n;

    // Return the smaller of max position and available balance
    if (availableBalance === 0n) {
      // No balance tracking yet — use max position as estimate
      return maxPositionAmount > 0n ? maxPositionAmount : 50_000_000n; // fallback 50 USDC
    }

    return availableBalance < maxPositionAmount ? availableBalance : maxPositionAmount;
  }

  /**
   * Find the chain with the most available USDC capital.
   * If the destination chain has funds, prefer it (no bridge needed).
   */
  private findCapitalChain(context: StrategyContext, destChain: ChainId): ChainId {
    const store = Store.getInstance();

    // Check destination chain first
    const destUsdc = USDC_ADDRESSES[destChain as number];
    if (destUsdc) {
      const destBalance = store.getAvailableBalance(destChain, destUsdc);
      if (destBalance > 0n) {
        return destChain;
      }
    }

    // Check all chains for USDC, pick the one with the most
    let bestChain = destChain;
    let bestBalance = 0n;

    for (const [chainIdNum, usdcAddr] of Object.entries(USDC_ADDRESSES)) {
      const cid = chainId(Number(chainIdNum));
      const balance = store.getAvailableBalance(cid, usdcAddr);
      if (balance > bestBalance) {
        bestBalance = balance;
        bestChain = cid;
      }
    }

    return bestChain;
  }
}
