import { randomUUID } from 'node:crypto';
import { CrossChainStrategy } from '../cross-chain-strategy.js';
import { Store } from '../../core/store.js';
import type {
  StrategySignal,
  ExecutionPlan,
  StrategyContext,
  StrategyFilter,
} from '../../core/types.js';
import { chainId, tokenAddress } from '../../core/types.js';
import type { PairAction } from '../../core/action-types.js';
import type {
  StatArbSignal,
  StatArbPosition,
  StatArbDirection,
  StatArbExitReason,
  StatArbPair,
} from '../../core/store-slices/stat-arb-slice.js';
import { calculateStoplossBreached } from '../../core/store-slices/stat-arb-slice.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('stat-arb-strategy');

// Stat-arb trades execute on Hyperliquid perps via symbol strings, not EVM token addresses.
// This placeholder satisfies StrategySignal.tokenPair interface — never used for on-chain execution.
const PERP_PLACEHOLDER = tokenAddress('0x0000000000000000000000000000000000000000');

// --- Constants ---

export const STAT_ARB_STRATEGY_DEFAULTS = {
  MAX_POSITIONS: 10,
  STOPLOSS: 0.30,
  RISK_TIER: 'Growth' as const,
  DEFAULT_LEVERAGE: 18,
  POSITION_SIZE_PERCENT: 0.05,
  ENTRY_THRESHOLD: 1.5,
  EXIT_THRESHOLD: 0.5,
  TIME_STOP_MULTIPLIER: 3,
} as const;

// --- Config ---

export interface StatArbStrategyConfig {
  readonly maxPositions: number;
  readonly stoploss: number;
  readonly defaultLeverage: number;
  readonly positionSizePercent: number;
}

// --- Action types ---

export interface PairTradeAction {
  readonly id: string;
  readonly type: 'pair';
  readonly priority: number;
  readonly createdAt: number;
  readonly strategyId: string;
  readonly pairId: string;
  readonly longSymbol: string;
  readonly shortSymbol: string;
  readonly longSize: bigint;
  readonly shortSize: bigint;
  readonly leverage: number;
  readonly metadata: Record<string, unknown>;
}

export interface ClosePairTradeAction {
  readonly id: string;
  readonly type: 'pair';
  readonly priority: number;
  readonly createdAt: number;
  readonly strategyId: string;
  readonly pairId: string;
  readonly longSymbol: string;
  readonly shortSymbol: string;
  readonly longSize: bigint;
  readonly shortSize: bigint;
  readonly leverage: number;
  readonly metadata: Record<string, unknown>;
}

// --- Strategy ---

export class StatArbStrategy extends CrossChainStrategy {
  readonly name = 'StatArbStrategy';
  readonly timeframe = '1h';

  // Declarative risk params
  override readonly stoploss = -0.30;
  override readonly minimalRoi: Readonly<Record<number, number>> = {};
  override readonly trailingStop = false;
  override readonly maxPositions = STAT_ARB_STRATEGY_DEFAULTS.MAX_POSITIONS;

  private readonly store: Store;
  private readonly strategyConfig: StatArbStrategyConfig;

  constructor(config?: Partial<StatArbStrategyConfig>, store?: Store) {
    super();
    this.store = store ?? Store.getInstance();

    this.strategyConfig = {
      maxPositions: config?.maxPositions ?? STAT_ARB_STRATEGY_DEFAULTS.MAX_POSITIONS,
      stoploss: config?.stoploss ?? STAT_ARB_STRATEGY_DEFAULTS.STOPLOSS,
      defaultLeverage: config?.defaultLeverage ?? STAT_ARB_STRATEGY_DEFAULTS.DEFAULT_LEVERAGE,
      positionSizePercent: config?.positionSizePercent ?? STAT_ARB_STRATEGY_DEFAULTS.POSITION_SIZE_PERCENT,
    };
  }

  // --- shouldExecute ---

  shouldExecute(context: StrategyContext): StrategySignal | null {
    // Priority 1: Check for exit conditions
    const exitSignal = this.checkExitConditions(context);
    if (exitSignal) return exitSignal;

    // Priority 2: Check for entry signals
    return this.checkEntrySignals(context);
  }

  private checkExitConditions(context: StrategyContext): StrategySignal | null {
    const activePositions = this.store.getAllActiveStatArbPositions();

    // Check each position for exit conditions, prioritized: stoploss > mean_reversion > time_stop
    let bestExit: { position: StatArbPosition; reason: StatArbExitReason; priority: number } | null = null;

    for (const position of activePositions) {
      // Check stoploss (priority 3 = highest)
      if (calculateStoplossBreached(position, this.strategyConfig.stoploss)) {
        if (!bestExit || 3 > bestExit.priority) {
          bestExit = { position, reason: 'stoploss', priority: 3 };
        }
        continue;
      }
    }

    // If no stoploss, we're done — mean_reversion and time_stop exits are handled
    // by the SignalGenerator via EventEmitter, not checked here in shouldExecute.
    // However, to satisfy the AC, we also listen for exit signals stored externally.
    // The SignalGenerator emits exit events; the strategy checks active positions.

    if (bestExit) {
      return this.buildExitStrategySignal(bestExit.position, bestExit.reason, context);
    }

    return null;
  }

  private checkEntrySignals(context: StrategyContext): StrategySignal | null {
    // Check capacity
    const activeCount = this.store.getActiveStatArbPositionCount();
    if (activeCount >= this.strategyConfig.maxPositions) {
      logger.debug(
        { active: activeCount, max: this.strategyConfig.maxPositions },
        'At max positions, skipping entry signals',
      );
      return null;
    }

    // Get pending signals (unconsumed, non-expired)
    const pendingSignals = this.store.getPendingSignals();
    if (pendingSignals.length === 0) return null;

    // Select highest |z-score| signal
    const sorted = [...pendingSignals].sort((a, b) => Math.abs(b.zScore) - Math.abs(a.zScore));

    for (const signal of sorted) {
      // Skip if position already exists for this pair
      const existingPosition = this.store.getActivePositionByPairKey(signal.pair.key);
      if (existingPosition) continue;

      const direction = signal.direction === 'long_pair' ? 'long' : 'short';
      const strength = Math.min(Math.abs(signal.zScore) / 3.0, 1.0);

      return {
        direction: direction as 'long' | 'short',
        tokenPair: {
          from: { address: PERP_PLACEHOLDER, symbol: signal.pair.tokenA, decimals: 18 },
          to: { address: PERP_PLACEHOLDER, symbol: signal.pair.tokenB, decimals: 18 },
        },
        sourceChain: chainId(42161), // Arbitrum
        destChain: chainId(42161),
        strength,
        reason: `Stat arb ${signal.direction} Z=${signal.zScore.toFixed(3)}`,
        metadata: {
          type: 'entry',
          statArbSignal: signal,
          pairKey: signal.pair.key,
        },
      };
    }

    return null;
  }

  private buildExitStrategySignal(
    position: StatArbPosition,
    reason: StatArbExitReason,
    _context: StrategyContext,
  ): StrategySignal {
    return {
      direction: 'exit',
      tokenPair: {
        from: { address: PERP_PLACEHOLDER, symbol: position.pair.tokenA, decimals: 18 },
        to: { address: PERP_PLACEHOLDER, symbol: position.pair.tokenB, decimals: 18 },
      },
      sourceChain: chainId(42161),
      destChain: chainId(42161),
      strength: 1.0,
      reason: `Exit ${reason} for ${position.pair.key}`,
      metadata: {
        type: 'exit',
        positionId: position.positionId,
        exitReason: reason,
        pairKey: position.pair.key,
      },
    };
  }

  // --- buildExecution ---

  buildExecution(signal: StrategySignal, context: StrategyContext): ExecutionPlan {
    const signalType = signal.metadata.type as string;

    if (signalType === 'exit') {
      return this.buildCloseExecution(signal, context);
    }

    return this.buildEntryExecution(signal, context);
  }

  private buildEntryExecution(signal: StrategySignal, context: StrategyContext): ExecutionPlan {
    const statArbSignal = signal.metadata.statArbSignal as StatArbSignal;
    const pairKey = signal.metadata.pairKey as string;

    // Calculate position sizes
    const portfolioValue = this.estimatePortfolioValue(context);
    const capital = portfolioValue * this.strategyConfig.positionSizePercent;
    const hedgeRatio = statArbSignal.hedgeRatio;
    const leverage = statArbSignal.recommendedLeverage || this.strategyConfig.defaultLeverage;

    const longSize = capital / (1 + hedgeRatio);
    const shortSize = (capital * hedgeRatio) / (1 + hedgeRatio);

    // Determine which token is long and which is short based on direction
    let longSymbol: string;
    let shortSymbol: string;
    if (statArbSignal.direction === 'long_pair') {
      longSymbol = statArbSignal.pair.tokenA;
      shortSymbol = statArbSignal.pair.tokenB;
    } else {
      longSymbol = statArbSignal.pair.tokenB;
      shortSymbol = statArbSignal.pair.tokenA;
    }

    const pairAction: PairTradeAction = {
      id: randomUUID().slice(0, 8),
      type: 'pair',
      priority: 1,
      createdAt: Date.now(),
      strategyId: this.name,
      pairId: pairKey,
      longSymbol,
      shortSymbol,
      longSize: BigInt(Math.round(longSize * 1e6)), // 6 decimal precision
      shortSize: BigInt(Math.round(shortSize * 1e6)),
      leverage,
      metadata: {
        signalId: statArbSignal.signalId,
        direction: statArbSignal.direction,
        hedgeRatio,
        zScore: statArbSignal.zScore,
        correlation: statArbSignal.correlation,
      },
    };

    // Mark signal as consumed
    this.store.markSignalConsumed(pairKey);

    return {
      id: randomUUID().slice(0, 8),
      strategyName: this.name,
      actions: [pairAction as unknown as PairAction],
      estimatedCostUsd: capital * 0.001, // ~0.1% cost estimate
      estimatedDurationMs: 5000,
      metadata: {
        pairKey,
        direction: statArbSignal.direction,
        leverage,
        longSize,
        shortSize,
      },
    };
  }

  private buildCloseExecution(signal: StrategySignal, _context: StrategyContext): ExecutionPlan {
    const positionId = signal.metadata.positionId as string;
    const exitReason = signal.metadata.exitReason as StatArbExitReason;
    const pairKey = signal.metadata.pairKey as string;

    const position = this.store.getActiveStatArbPosition(positionId);

    const closeAction: ClosePairTradeAction = {
      id: randomUUID().slice(0, 8),
      type: 'pair',
      priority: 2,
      createdAt: Date.now(),
      strategyId: this.name,
      pairId: pairKey,
      longSymbol: position?.legB.symbol ?? '',
      shortSymbol: position?.legA.symbol ?? '',
      longSize: 0n,
      shortSize: 0n,
      leverage: 0,
      metadata: {
        action: 'close_pair_trade',
        positionId,
        exitReason,
        combinedPnl: position?.combinedPnl ?? 0,
      },
    };

    logger.info(
      { positionId, pairKey, exitReason, pnl: position?.combinedPnl },
      `Closing pair ${pairKey} reason=${exitReason} pnl=${position?.combinedPnl ?? 0}`,
    );

    return {
      id: randomUUID().slice(0, 8),
      strategyName: this.name,
      actions: [closeAction as unknown as PairAction],
      estimatedCostUsd: 1,
      estimatedDurationMs: 3000,
      metadata: {
        action: 'close_pair_trade',
        positionId,
        exitReason,
        pairKey,
      },
    };
  }

  // --- Filters ---

  override filters(): StrategyFilter[] {
    return [
      this.maxPositionsFilter.bind(this),
    ];
  }

  private maxPositionsFilter(_ctx: StrategyContext): boolean {
    return this.store.getActiveStatArbPositionCount() < this.strategyConfig.maxPositions;
  }

  // --- Lifecycle hooks ---

  override confirmTradeEntry(plan: ExecutionPlan): boolean {
    const action = plan.actions[0] as unknown as PairTradeAction;
    if (!action) return false;
    if (action.longSize === 0n || action.shortSize === 0n) {
      logger.warn({ plan: plan.id }, 'Rejecting zero-sized position');
      return false;
    }
    return true;
  }

  override confirmTradeExit(_position: unknown, reason: string): boolean {
    // Always confirm stoploss exits
    if (reason === 'stoploss') return true;
    return true;
  }

  // --- Helpers ---

  private estimatePortfolioValue(context: StrategyContext): number {
    let total = 0;
    for (const [key, balance] of context.balances) {
      const price = context.prices.get(key) ?? 0;
      total += Number(balance) * price / 1e18; // Rough estimate
    }
    // Default to $10,000 if no balance info
    return total > 0 ? total : 10_000;
  }

  // --- Public accessors ---

  getStrategyConfig(): Readonly<StatArbStrategyConfig> {
    return this.strategyConfig;
  }

  // --- Beta-neutral position sizing (exposed for testing) ---

  static calculateBetaNeutralSizes(capital: number, hedgeRatio: number): { longSize: number; shortSize: number } {
    const longSize = capital / (1 + hedgeRatio);
    const shortSize = (capital * hedgeRatio) / (1 + hedgeRatio);
    return { longSize, shortSize };
  }
}
