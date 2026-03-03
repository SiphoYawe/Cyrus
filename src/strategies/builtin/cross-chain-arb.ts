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
  ComposerAction,
  ExecutorAction,
} from '../../core/action-types.js';

// --- Arb-specific types ---

export type ArbType = 'price' | 'yield' | 'stablecoin_depeg';

export interface ArbOpportunity {
  readonly type: ArbType;
  readonly sourceChain: ChainId;
  readonly destChain: ChainId;
  readonly token: TokenAddress;
  readonly tokenSymbol: string;
  readonly buyPrice: number;
  readonly sellPrice: number;
  readonly grossProfit: number;
  readonly estimatedCosts: number;
  readonly netProfit: number;
  readonly confidence: number;
}

// --- Monitored stablecoins ---

const STABLECOINS: readonly { address: TokenAddress; symbol: string; chainId: ChainId }[] = [
  { address: tokenAddress('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'), symbol: 'USDC', chainId: chainId(1) },
  { address: tokenAddress('0xaf88d065e77c8cc2239327c5edb3a432268e5831'), symbol: 'USDC', chainId: chainId(42161) },
  { address: tokenAddress('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'), symbol: 'USDC', chainId: chainId(8453) },
  { address: tokenAddress('0xdac17f958d2ee523a2206206994597c13d831ec7'), symbol: 'USDT', chainId: chainId(1) },
];

// --- Helper: generate a deterministic action ID ---

let actionCounter = 0;
function nextActionId(prefix: string): string {
  actionCounter += 1;
  return `${prefix}-${Date.now()}-${actionCounter}`;
}

/**
 * Cross-chain arbitrage strategy.
 *
 * Scans for three kinds of arbitrage:
 * 1. Price arb — same token priced differently on two chains
 * 2. Stablecoin depeg — stablecoin deviating from $1.00
 * 3. Yield arb — (placeholder) different yields for same asset across chains
 *
 * Growth-tier risk profile: tight stop-loss, low ROI target, trailing stop enabled.
 */
export class CrossChainArbStrategy extends CrossChainStrategy {
  readonly name = 'CrossChainArb';
  readonly timeframe = '30s';

  // Growth-tier risk defaults
  override readonly stoploss = -0.03;
  override readonly minimalRoi: Readonly<Record<number, number>> = { 0: 0.003 };
  override readonly trailingStop = true;
  override readonly maxPositions = 5;

  // Configurable parameters
  readonly minProfitUsd: number;
  readonly minProfitPercent: number;
  readonly stablecoinDepegThreshold: number;

  // Execution history for adaptive thresholds (rolling window)
  executionHistory: { profitable: boolean; latencyMs: number }[] = [];

  // Adaptive threshold — starts at minProfitPercent, adjusted dynamically
  adaptiveMinProfitPercent: number;

  constructor(config: {
    minProfitUsd?: number;
    minProfitPercent?: number;
    stablecoinDepegThreshold?: number;
  } = {}) {
    super();
    this.minProfitUsd = config.minProfitUsd ?? 5;
    this.minProfitPercent = config.minProfitPercent ?? 0.003;
    this.stablecoinDepegThreshold = config.stablecoinDepegThreshold ?? 0.005;
    this.adaptiveMinProfitPercent = this.minProfitPercent;
  }

  // --- Private scanner methods ---

  /**
   * Scan for price arbitrage opportunities.
   * Compares same-token prices across chains via context.prices.
   * Price map key format: `${chainId}-${tokenAddress}`
   */
  private scanPriceArbitrage(context: StrategyContext): ArbOpportunity[] {
    const opportunities: ArbOpportunity[] = [];

    // Group prices by token address (ignoring chain prefix)
    const tokenPrices = new Map<string, { chainId: ChainId; price: number }[]>();

    for (const [key, price] of context.prices) {
      const dashIndex = key.indexOf('-');
      if (dashIndex === -1) continue;
      const chain = Number(key.substring(0, dashIndex));
      const token = key.substring(dashIndex + 1);
      if (!tokenPrices.has(token)) {
        tokenPrices.set(token, []);
      }
      tokenPrices.get(token)!.push({ chainId: chainId(chain), price });
    }

    // Compare prices for same token across chains
    for (const [token, entries] of tokenPrices) {
      if (entries.length < 2) continue;

      for (let i = 0; i < entries.length; i++) {
        for (let j = i + 1; j < entries.length; j++) {
          const a = entries[i];
          const b = entries[j];

          // Determine buy (cheap) and sell (expensive) sides
          const [buy, sell] = a.price < b.price ? [a, b] : [b, a];
          const grossProfit = (sell.price - buy.price) / buy.price;

          // Estimate costs as 0.5% of amount (gas + bridge fees)
          const estimatedCosts = 0.005;
          const netProfit = grossProfit - estimatedCosts;

          if (netProfit > this.adaptiveMinProfitPercent) {
            opportunities.push({
              type: 'price',
              sourceChain: buy.chainId,
              destChain: sell.chainId,
              token: tokenAddress(token),
              tokenSymbol: token.substring(0, 6),
              buyPrice: buy.price,
              sellPrice: sell.price,
              grossProfit,
              estimatedCosts,
              netProfit,
              confidence: Math.min(netProfit / this.adaptiveMinProfitPercent, 1.0),
            });
          }
        }
      }
    }

    return opportunities;
  }

  /**
   * Scan for stablecoin depeg arbitrage opportunities.
   * Checks monitored stablecoins for deviation from $1.00.
   */
  private scanStablecoinDepeg(context: StrategyContext): ArbOpportunity[] {
    const opportunities: ArbOpportunity[] = [];

    for (const stable of STABLECOINS) {
      const key = `${stable.chainId as number}-${stable.address as string}`;
      const price = context.prices.get(key);
      if (price === undefined) continue;

      const deviation = Math.abs(price - 1.0);
      if (deviation <= this.stablecoinDepegThreshold) continue;

      // Only profitable if price is below peg (buy discounted, sell at peg)
      if (price >= 1.0) continue;

      const grossProfit = (1.0 - price) / price;
      const estimatedCosts = 0.005;
      const netProfit = grossProfit - estimatedCosts;

      if (netProfit > this.adaptiveMinProfitPercent) {
        // Find another chain with same stablecoin symbol at or near peg for selling
        const sellChain = STABLECOINS.find(
          (s) =>
            s.symbol === stable.symbol &&
            (s.chainId as number) !== (stable.chainId as number),
        );

        if (!sellChain) continue;

        opportunities.push({
          type: 'stablecoin_depeg',
          sourceChain: stable.chainId,
          destChain: sellChain.chainId,
          token: stable.address,
          tokenSymbol: stable.symbol,
          buyPrice: price,
          sellPrice: 1.0,
          grossProfit,
          estimatedCosts,
          netProfit,
          confidence: Math.min(deviation / 0.02, 1.0), // max confidence at 2% depeg
        });
      }
    }

    return opportunities;
  }

  /**
   * Scan for yield arbitrage opportunities.
   * Placeholder: yield data is not available in context.prices.
   */
  private scanYieldArbitrage(_context: StrategyContext): ArbOpportunity[] {
    return [];
  }

  // --- Core strategy methods ---

  shouldExecute(context: StrategyContext): StrategySignal | null {
    // Check max positions limit
    if (context.positions.length >= this.maxPositions) {
      return null;
    }

    // Run all three scanners
    const priceOpps = this.scanPriceArbitrage(context);
    const depegOpps = this.scanStablecoinDepeg(context);
    const yieldOpps = this.scanYieldArbitrage(context);

    // Merge and sort by netProfit descending
    const allOpps = [...priceOpps, ...depegOpps, ...yieldOpps].sort(
      (a, b) => b.netProfit - a.netProfit,
    );

    if (allOpps.length === 0) {
      return null;
    }

    const best = allOpps[0];

    // Build token info — for arb we use the same token on both sides
    const tokenInfo: TokenInfo = {
      address: best.token,
      symbol: best.tokenSymbol,
      decimals: 18, // default, actual decimals resolved at execution
    };

    return {
      direction: 'long',
      tokenPair: { from: tokenInfo, to: tokenInfo },
      sourceChain: best.sourceChain,
      destChain: best.destChain,
      strength: best.confidence,
      reason: `${best.type} arb: buy@${best.buyPrice.toFixed(4)} on chain ${best.sourceChain as number}, sell@${best.sellPrice.toFixed(4)} on chain ${best.destChain as number}, net ${(best.netProfit * 100).toFixed(2)}%`,
      metadata: {
        arbType: best.type,
        buyPrice: best.buyPrice,
        sellPrice: best.sellPrice,
        grossProfit: best.grossProfit,
        estimatedCosts: best.estimatedCosts,
        netProfit: best.netProfit,
        confidence: best.confidence,
      },
    };
  }

  buildExecution(signal: StrategySignal, _context: StrategyContext): ExecutionPlan {
    const arbType = signal.metadata.arbType as ArbType;
    const now = Date.now();
    const strategyId = this.name;
    const amount = 0n; // Amount determined at execution time by the orchestrator

    let actions: ExecutorAction[];

    switch (arbType) {
      case 'price': {
        // Buy on cheap chain -> Bridge -> Sell on expensive chain
        const buyAction: SwapAction = {
          id: nextActionId('swap-buy'),
          type: 'swap',
          priority: 1,
          createdAt: now,
          strategyId,
          fromChain: signal.sourceChain,
          toChain: signal.sourceChain,
          fromToken: signal.tokenPair.from.address,
          toToken: signal.tokenPair.to.address,
          amount,
          slippage: 0.005,
          metadata: { step: 'buy', arbType: 'price' },
        };

        const bridgeAction: BridgeAction = {
          id: nextActionId('bridge'),
          type: 'bridge',
          priority: 2,
          createdAt: now,
          strategyId,
          fromChain: signal.sourceChain,
          toChain: signal.destChain,
          fromToken: signal.tokenPair.to.address,
          toToken: signal.tokenPair.to.address,
          amount,
          metadata: { step: 'bridge', arbType: 'price' },
        };

        const sellAction: SwapAction = {
          id: nextActionId('swap-sell'),
          type: 'swap',
          priority: 3,
          createdAt: now,
          strategyId,
          fromChain: signal.destChain,
          toChain: signal.destChain,
          fromToken: signal.tokenPair.to.address,
          toToken: signal.tokenPair.from.address,
          amount,
          slippage: 0.005,
          metadata: { step: 'sell', arbType: 'price' },
        };

        actions = [buyAction, bridgeAction, sellAction];
        break;
      }

      case 'stablecoin_depeg': {
        // Buy discounted stablecoin -> Bridge -> Sell at peg
        const buyAction: SwapAction = {
          id: nextActionId('swap-buy'),
          type: 'swap',
          priority: 1,
          createdAt: now,
          strategyId,
          fromChain: signal.sourceChain,
          toChain: signal.sourceChain,
          fromToken: signal.tokenPair.from.address,
          toToken: signal.tokenPair.to.address,
          amount,
          slippage: 0.005,
          metadata: { step: 'buy-discounted', arbType: 'stablecoin_depeg' },
        };

        const bridgeAction: BridgeAction = {
          id: nextActionId('bridge'),
          type: 'bridge',
          priority: 2,
          createdAt: now,
          strategyId,
          fromChain: signal.sourceChain,
          toChain: signal.destChain,
          fromToken: signal.tokenPair.to.address,
          toToken: signal.tokenPair.to.address,
          amount,
          metadata: { step: 'bridge', arbType: 'stablecoin_depeg' },
        };

        const sellAction: SwapAction = {
          id: nextActionId('swap-sell'),
          type: 'swap',
          priority: 3,
          createdAt: now,
          strategyId,
          fromChain: signal.destChain,
          toChain: signal.destChain,
          fromToken: signal.tokenPair.to.address,
          toToken: signal.tokenPair.from.address,
          amount,
          slippage: 0.005,
          metadata: { step: 'sell-at-peg', arbType: 'stablecoin_depeg' },
        };

        actions = [buyAction, bridgeAction, sellAction];
        break;
      }

      case 'yield': {
        // Withdraw from low-yield protocol -> Bridge -> Deposit into high-yield protocol
        const withdrawAction: ComposerAction = {
          id: nextActionId('composer-withdraw'),
          type: 'composer',
          priority: 1,
          createdAt: now,
          strategyId,
          fromChain: signal.sourceChain,
          toChain: signal.sourceChain,
          fromToken: signal.tokenPair.from.address,
          toToken: signal.tokenPair.to.address,
          amount,
          protocol: (signal.metadata.sourceProtocol as string) ?? 'unknown',
          metadata: { step: 'withdraw', arbType: 'yield' },
        };

        const bridgeAction: BridgeAction = {
          id: nextActionId('bridge'),
          type: 'bridge',
          priority: 2,
          createdAt: now,
          strategyId,
          fromChain: signal.sourceChain,
          toChain: signal.destChain,
          fromToken: signal.tokenPair.to.address,
          toToken: signal.tokenPair.to.address,
          amount,
          metadata: { step: 'bridge', arbType: 'yield' },
        };

        const depositAction: ComposerAction = {
          id: nextActionId('composer-deposit'),
          type: 'composer',
          priority: 3,
          createdAt: now,
          strategyId,
          fromChain: signal.destChain,
          toChain: signal.destChain,
          fromToken: signal.tokenPair.to.address,
          toToken: signal.tokenPair.from.address,
          amount,
          protocol: (signal.metadata.destProtocol as string) ?? 'unknown',
          metadata: { step: 'deposit', arbType: 'yield' },
        };

        actions = [withdrawAction, bridgeAction, depositAction];
        break;
      }

      default: {
        actions = [];
      }
    }

    return {
      id: nextActionId('plan'),
      strategyName: this.name,
      actions,
      estimatedCostUsd: (signal.metadata.estimatedCosts as number) ?? 0,
      estimatedDurationMs: arbType === 'price' || arbType === 'stablecoin_depeg' ? 120_000 : 180_000,
      metadata: {
        arbType,
        buyPrice: signal.metadata.buyPrice,
        sellPrice: signal.metadata.sellPrice,
        grossProfit: signal.metadata.grossProfit,
        estimatedCosts: signal.metadata.estimatedCosts,
        netProfit: signal.metadata.netProfit,
      },
    };
  }

  // --- Lifecycle overrides ---

  override confirmTradeEntry(plan: ExecutionPlan): boolean {
    const netProfit = plan.metadata.netProfit as number | undefined;
    if (netProfit === undefined) return true;
    return netProfit > 0;
  }

  // --- Adaptive threshold management ---

  /**
   * Record the result of an execution for adaptive threshold adjustment.
   * Maintains a rolling window of the last 20 executions.
   */
  recordExecution(profitable: boolean, latencyMs: number): void {
    this.executionHistory.push({ profitable, latencyMs });

    // Keep rolling window of last 20 entries
    if (this.executionHistory.length > 20) {
      this.executionHistory = this.executionHistory.slice(-20);
    }

    // Only adjust after at least 10 data points
    if (this.executionHistory.length < 10) return;

    const recent = this.executionHistory.slice(-10);
    const missedCount = recent.filter((e) => !e.profitable).length;
    const missedRate = missedCount / recent.length;

    if (missedRate > 0.3) {
      // Too many misses — increase threshold by 50% to be more selective
      this.adaptiveMinProfitPercent *= 1.5;
    } else if (missedRate < 0.1) {
      // Very few misses — decrease threshold by 25% to capture more opportunities
      this.adaptiveMinProfitPercent *= 0.75;
    }

    // Floor at initial default
    if (this.adaptiveMinProfitPercent < this.minProfitPercent) {
      this.adaptiveMinProfitPercent = this.minProfitPercent;
    }
  }

  // --- Filter chain ---

  override filters(): StrategyFilter[] {
    return [
      // Min profit filter: check that prices map has at least some data
      (ctx: StrategyContext) => ctx.prices.size > 0,

      // Max positions filter
      (ctx: StrategyContext) => ctx.positions.length < this.maxPositions,
    ];
  }
}
