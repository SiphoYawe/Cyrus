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
  MarketMakeAction,
  BridgeAction,
  SwapAction,
  ExecutorAction,
} from '../../core/action-types.js';
import { CHAINS, USDC_ADDRESSES } from '../../core/constants.js';
import { Store } from '../../core/store.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OrderLevel {
  readonly level: number;
  readonly bidPrice: number;
  readonly askPrice: number;
  readonly size: bigint;
}

export interface InventoryTracker {
  baseBalance: bigint;
  quoteBalance: bigint;
  baseValueUsd: number;
  quoteValueUsd: number;
  skewPercent: number;
}

export interface MarketMakerConfig {
  readonly spread: number; // default 0.001 (0.1%)
  readonly orderSize: bigint; // per level
  readonly levels: number; // default 3
  readonly inventoryTarget: number; // default 0.5 (50/50)
  readonly rebalanceThreshold: number; // default 0.85 (85%)
  readonly skewAdjustThreshold: number; // default 0.70 (70%)
  readonly staleOrderThreshold: number; // default 0.005 (0.5% deviation)
  readonly symbol: string;
  readonly baseToken: TokenInfo;
  readonly quoteToken: TokenInfo;
  readonly chainId: ChainId;
}

export interface MarketMakerMarketData {
  readonly midPrice: number;
  readonly bestBid: number;
  readonly bestAsk: number;
  readonly baseBalance: bigint;
  readonly quoteBalance: bigint;
  readonly basePrice: number;
  readonly fills: readonly { side: 'buy' | 'sell'; price: number; size: bigint }[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Estimated bridge cost in USD for LI.FI cross-chain rebalance. */
const ESTIMATED_BRIDGE_COST_USD = 5;

/** Estimated market-make execution cost in USD. */
const ESTIMATED_MM_COST_USD = 1;

/** Default position size in 6-decimal format (e.g. USDC). */
const DEFAULT_ORDER_SIZE = 50_000_000n; // 50 USDC

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let actionCounter = 0;
function nextActionId(prefix: string): string {
  actionCounter += 1;
  return `${prefix}-${Date.now()}-${actionCounter}`;
}

/** Reset the action counter (for tests). */
export function resetActionCounter(): void {
  actionCounter = 0;
}

// ---------------------------------------------------------------------------
// Strategy
// ---------------------------------------------------------------------------

/**
 * MarketMaker -- autonomous market-making strategy with cross-chain rebalancing.
 *
 * Places multi-level bid/ask orders around the mid-price on a single market.
 * Applies inventory skew adjustments to reduce directional risk.
 * When inventory skew exceeds the rebalance threshold (85%), triggers a
 * cross-chain rebalance via LI.FI bridge/swap.
 *
 * Market data is injected externally via `setMarketData()` because
 * `shouldExecute()` is synchronous and cannot call APIs.
 */
export class MarketMaker extends CrossChainStrategy {
  // --- Identity ---
  readonly name = 'MarketMaker';
  readonly timeframe = '5s';

  // --- Growth tier risk parameters ---
  override readonly stoploss: number = -0.05;
  override readonly minimalRoi: Readonly<Record<number, number>> = { 0: 0.01 };
  override readonly trailingStop: boolean = false;
  override readonly maxPositions: number = 1; // one market at a time

  // --- Configuration ---
  readonly config: MarketMakerConfig;

  // --- Injected market data ---
  private marketData: MarketMakerMarketData | null = null;

  // --- Internal inventory tracking ---
  private inventory: InventoryTracker = {
    baseBalance: 0n,
    quoteBalance: 0n,
    baseValueUsd: 0,
    quoteValueUsd: 0,
    skewPercent: 0.5,
  };

  constructor(options?: Partial<MarketMakerConfig>) {
    super();

    const defaultBaseToken: TokenInfo = {
      address: USDC_ADDRESSES[CHAINS.ARBITRUM as number]!,
      symbol: 'WETH',
      decimals: 18,
    };

    const defaultQuoteToken: TokenInfo = {
      address: USDC_ADDRESSES[CHAINS.ARBITRUM as number]!,
      symbol: 'USDC',
      decimals: 6,
    };

    this.config = {
      spread: options?.spread ?? 0.001,
      orderSize: options?.orderSize ?? DEFAULT_ORDER_SIZE,
      levels: options?.levels ?? 3,
      inventoryTarget: options?.inventoryTarget ?? 0.5,
      rebalanceThreshold: options?.rebalanceThreshold ?? 0.85,
      skewAdjustThreshold: options?.skewAdjustThreshold ?? 0.70,
      staleOrderThreshold: options?.staleOrderThreshold ?? 0.005,
      symbol: options?.symbol ?? 'WETH/USDC',
      baseToken: options?.baseToken ?? defaultBaseToken,
      quoteToken: options?.quoteToken ?? defaultQuoteToken,
      chainId: options?.chainId ?? CHAINS.ARBITRUM,
    };
  }

  // --- Market data injection ---

  /** Inject pre-fetched market data for the strategy to evaluate. */
  setMarketData(data: MarketMakerMarketData): void {
    this.marketData = data;
    this.updateInventory(data);
  }

  // --- Inventory management ---

  /** Get the current inventory tracker state. */
  getInventory(): Readonly<InventoryTracker> {
    return { ...this.inventory };
  }

  /**
   * Update inventory from market data.
   * Calculates USD values and skew percent.
   */
  private updateInventory(data: MarketMakerMarketData): void {
    this.inventory.baseBalance = data.baseBalance;
    this.inventory.quoteBalance = data.quoteBalance;

    // Compute USD values
    // baseBalance in native units; basePrice in USD
    const baseDecimals = this.config.baseToken.decimals;
    const quoteDecimals = this.config.quoteToken.decimals;

    this.inventory.baseValueUsd =
      Number(data.baseBalance) / Math.pow(10, baseDecimals) * data.basePrice;
    this.inventory.quoteValueUsd =
      Number(data.quoteBalance) / Math.pow(10, quoteDecimals) * 1.0; // quote is stablecoin

    this.inventory.skewPercent = this.calculateInventorySkew();
  }

  /**
   * Calculate inventory skew as baseValueUsd / totalValueUsd.
   * Returns 0.5 if total value is 0.
   */
  calculateInventorySkew(): number {
    const totalValue = this.inventory.baseValueUsd + this.inventory.quoteValueUsd;
    if (totalValue === 0) return 0.5;
    return this.inventory.baseValueUsd / totalValue;
  }

  /**
   * Calculate multi-level bid/ask order levels from midPrice.
   *
   * Level 1: 0.5x spread distance from midPrice
   * Level 2: 1.0x spread distance from midPrice
   * Level 3: 1.5x spread distance from midPrice
   *
   * When inventory skew exceeds skewAdjustThreshold, widen the heavy side's
   * spread and tighten the light side to encourage rebalancing.
   */
  calculateOrderLevels(midPrice: number): OrderLevel[] {
    const levels: OrderLevel[] = [];
    const skew = this.inventory.skewPercent;
    const needsSkewAdjust = Math.abs(skew - this.config.inventoryTarget) >
      (this.config.skewAdjustThreshold - this.config.inventoryTarget);

    for (let i = 1; i <= this.config.levels; i++) {
      const levelMultiplier = i * 0.5;
      let bidSpreadMultiplier = levelMultiplier;
      let askSpreadMultiplier = levelMultiplier;

      if (needsSkewAdjust) {
        if (skew > this.config.inventoryTarget) {
          // Heavy on base (too much inventory) -- widen asks, tighten bids to buy less/sell more
          askSpreadMultiplier *= 0.8; // tighter asks to attract more sells
          bidSpreadMultiplier *= 1.2; // wider bids to discourage buys
        } else {
          // Light on base -- widen bids, tighten asks
          bidSpreadMultiplier *= 0.8;
          askSpreadMultiplier *= 1.2;
        }
      }

      const bidPrice = midPrice * (1 - this.config.spread * bidSpreadMultiplier);
      const askPrice = midPrice * (1 + this.config.spread * askSpreadMultiplier);

      levels.push({
        level: i,
        bidPrice,
        askPrice,
        size: this.config.orderSize,
      });
    }

    return levels;
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

    const { midPrice } = this.marketData;
    if (midPrice <= 0) {
      return null;
    }

    // Calculate order levels
    const orderLevels = this.calculateOrderLevels(midPrice);

    // Determine if rebalancing is needed
    const skew = this.inventory.skewPercent;
    const needsRebalance = skew > this.config.rebalanceThreshold ||
      skew < (1 - this.config.rebalanceThreshold);

    // Calculate signal strength based on spread opportunity
    const effectiveSpread = (this.marketData.bestAsk - this.marketData.bestBid) / midPrice;
    const spreadRatio = effectiveSpread / this.config.spread;
    const strength = Math.min(spreadRatio, 1.0);

    return {
      direction: 'long', // market-making is direction-neutral, but signal needs a direction
      tokenPair: {
        from: this.config.quoteToken,
        to: this.config.baseToken,
      },
      sourceChain: this.config.chainId,
      destChain: this.config.chainId,
      strength,
      reason: `market_make: ${this.config.symbol} mid=${midPrice.toFixed(4)} spread=${(effectiveSpread * 100).toFixed(3)}% levels=${this.config.levels} skew=${(skew * 100).toFixed(1)}%${needsRebalance ? ' [REBALANCE]' : ''}`,
      metadata: {
        orderLevels,
        midPrice,
        effectiveSpread,
        skewPercent: skew,
        needsRebalance,
        symbol: this.config.symbol,
      },
    };
  }

  // --- Execution plan builder ---

  buildExecution(signal: StrategySignal, _context: StrategyContext): ExecutionPlan {
    const now = Date.now();
    const actions: ExecutorAction[] = [];
    let estimatedCostUsd = 0;
    let estimatedDurationMs = 0;

    const needsRebalance = signal.metadata['needsRebalance'] as boolean;

    // If rebalancing is needed, prepend a bridge/swap via LI.FI
    if (needsRebalance) {
      const skew = signal.metadata['skewPercent'] as number;

      if (skew > this.config.rebalanceThreshold) {
        // Too much base token -- sell base for quote on another chain via bridge
        const fromUsdcAddress = USDC_ADDRESSES[this.config.chainId as number];
        if (fromUsdcAddress) {
          // Bridge some base value to another chain for diversification
          const bridgeAction: BridgeAction = {
            id: nextActionId('mm-rebal-bridge'),
            type: 'bridge',
            priority: 1,
            createdAt: now,
            strategyId: this.name,
            fromChain: this.config.chainId,
            toChain: CHAINS.ETHEREUM,
            fromToken: this.config.baseToken.address,
            toToken: this.config.quoteToken.address,
            amount: this.config.orderSize,
            metadata: { reason: 'rebalance_heavy_base', skew },
          };
          actions.push(bridgeAction);
          estimatedCostUsd += ESTIMATED_BRIDGE_COST_USD;
          estimatedDurationMs += 120_000;
        }
      } else {
        // Too much quote token -- swap quote for base via LI.FI
        const swapAction: SwapAction = {
          id: nextActionId('mm-rebal-swap'),
          type: 'swap',
          priority: 1,
          createdAt: now,
          strategyId: this.name,
          fromChain: this.config.chainId,
          toChain: this.config.chainId,
          fromToken: this.config.quoteToken.address,
          toToken: this.config.baseToken.address,
          amount: this.config.orderSize,
          slippage: 0.005,
          metadata: { reason: 'rebalance_heavy_quote', skew },
        };
        actions.push(swapAction);
        estimatedCostUsd += ESTIMATED_MM_COST_USD;
        estimatedDurationMs += 15_000;
      }
    }

    // Build the market-make action
    const mmAction: MarketMakeAction = {
      id: nextActionId('mm-exec'),
      type: 'market_make',
      priority: actions.length + 1,
      createdAt: now,
      strategyId: this.name,
      symbol: this.config.symbol,
      spread: this.config.spread,
      orderSize: this.config.orderSize,
      levels: this.config.levels,
      metadata: {
        orderLevels: signal.metadata['orderLevels'],
        midPrice: signal.metadata['midPrice'],
        skewPercent: signal.metadata['skewPercent'],
        needsRebalance,
        staleOrderThreshold: this.config.staleOrderThreshold,
      },
    };
    actions.push(mmAction);
    estimatedCostUsd += ESTIMATED_MM_COST_USD;
    estimatedDurationMs += 5_000;

    return {
      id: nextActionId('mm-plan'),
      strategyName: this.name,
      actions,
      estimatedCostUsd,
      estimatedDurationMs,
      metadata: {
        symbol: this.config.symbol,
        midPrice: signal.metadata['midPrice'],
        levels: this.config.levels,
        spread: this.config.spread,
        needsRebalance,
        skewPercent: signal.metadata['skewPercent'],
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
    const midPrice = plan.metadata['midPrice'] as number | undefined;
    if (midPrice === undefined || midPrice <= 0) return false;
    return true;
  }
}
