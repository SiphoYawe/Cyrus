import { CrossChainStrategy } from '../cross-chain-strategy.js';
import type {
  ChainId,
  TokenAddress,
  StrategySignal,
  ExecutionPlan,
  StrategyContext,
  StrategyFilter,
  Position,
} from '../../core/types.js';
import type { ComposerAction, BridgeAction } from '../../core/action-types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface YieldOpportunity {
  readonly protocol: string;
  readonly chainId: ChainId;
  readonly token: TokenAddress;
  readonly apy: number;
  readonly tvl: number;
  readonly riskScore: number; // 0-1, lower is safer
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Estimated gas + bridge cost in USD for a single cross-chain move. */
const ESTIMATED_CROSS_CHAIN_COST_USD = 5;

/** Estimated gas cost in USD for a same-chain vault deposit. */
const ESTIMATED_SAME_CHAIN_COST_USD = 1;

/** Default minimum APY improvement (percentage points) before migration. */
const DEFAULT_MIN_APY_IMPROVEMENT = 2.0;

// ---------------------------------------------------------------------------
// Strategy
// ---------------------------------------------------------------------------

/**
 * YieldHunter — autonomous yield-farming strategy.
 *
 * Monitors DeFi yield opportunities across chains and:
 *  1. Deploys idle capital into the best available vault/pool.
 *  2. Migrates existing positions when a materially better opportunity exists
 *     (net improvement > `minimumApyImprovement` after estimated costs).
 *
 * Yield data is injected externally via `setYieldData()` because the
 * `shouldExecute()` method is synchronous — it cannot call APIs itself.
 */
export class YieldHunter extends CrossChainStrategy {
  // --- Identity -----------------------------------------------------------
  readonly name = 'YieldHunter';
  readonly timeframe = '5m';

  // --- Risk parameters (conservative defaults) ----------------------------
  override readonly stoploss: number = -0.05;
  override readonly minimalRoi: Readonly<Record<number, number>> = { 0: 0.02 };
  override readonly trailingStop: boolean = false;
  override readonly maxPositions: number = 5;

  // --- Configurable knobs -------------------------------------------------
  readonly minimumApyImprovement: number;
  readonly allowedChains: readonly ChainId[];
  readonly allowedProtocols: readonly string[];

  // --- Internal state -----------------------------------------------------
  private yieldData: readonly YieldOpportunity[] = [];

  constructor(options?: {
    minimumApyImprovement?: number;
    allowedChains?: ChainId[];
    allowedProtocols?: string[];
  }) {
    super();
    this.minimumApyImprovement =
      options?.minimumApyImprovement ?? DEFAULT_MIN_APY_IMPROVEMENT;
    this.allowedChains = options?.allowedChains ?? [];
    this.allowedProtocols = options?.allowedProtocols ?? [];
  }

  // --- Yield data injection -----------------------------------------------

  /** Inject pre-fetched yield data for the strategy to evaluate. */
  setYieldData(data: YieldOpportunity[]): void {
    this.yieldData = Object.freeze([...data]);
  }

  // --- Core decision logic ------------------------------------------------

  shouldExecute(context: StrategyContext): StrategySignal | null {
    if (this.yieldData.length === 0) {
      return null;
    }

    const filteredOpportunities = this.filterOpportunities(this.yieldData);
    if (filteredOpportunities.length === 0) {
      return null;
    }

    // Sort by APY descending
    const sorted = [...filteredOpportunities].sort((a, b) => b.apy - a.apy);
    const best = sorted[0]!;

    // Case 1: Idle capital — open a new position
    const idleCapital = this.findIdleCapital(context);
    if (idleCapital !== null) {
      return this.buildEntrySignal(best, idleCapital);
    }

    // Case 2: Existing position with a better opportunity available
    const migration = this.findMigrationOpportunity(
      context.positions,
      sorted,
    );
    if (migration !== null) {
      return migration;
    }

    return null;
  }

  // --- Execution plan builder ---------------------------------------------

  buildExecution(signal: StrategySignal, _context: StrategyContext): ExecutionPlan {
    const now = Date.now();
    const actions: (ComposerAction | BridgeAction)[] = [];
    let estimatedCostUsd = 0;
    let estimatedDurationMs = 0;
    const isCrossChain = signal.sourceChain !== signal.destChain;
    const isMigration = signal.metadata['type'] === 'migration';

    // Step 1 (migration only): Withdraw from current vault
    if (isMigration) {
      const withdrawAction: ComposerAction = {
        id: `yh-withdraw-${now}`,
        type: 'composer',
        priority: 1,
        createdAt: now,
        strategyId: this.name,
        fromChain: signal.sourceChain,
        toChain: signal.sourceChain,
        fromToken: signal.tokenPair.from.address,
        toToken: signal.tokenPair.from.address, // withdraw back to same token
        amount: 0n, // full position; executor resolves actual amount
        protocol: (signal.metadata['fromProtocol'] as string) ?? 'unknown',
        metadata: { action: 'withdraw' },
      };
      actions.push(withdrawAction);
      estimatedCostUsd += ESTIMATED_SAME_CHAIN_COST_USD;
      estimatedDurationMs += 15_000;
    }

    // Step 2 (cross-chain): Bridge to destination chain
    if (isCrossChain) {
      const bridgeAction: BridgeAction = {
        id: `yh-bridge-${now}`,
        type: 'bridge',
        priority: actions.length + 1,
        createdAt: now,
        strategyId: this.name,
        fromChain: signal.sourceChain,
        toChain: signal.destChain,
        fromToken: signal.tokenPair.from.address,
        toToken: signal.tokenPair.to.address,
        amount: 0n, // executor resolves actual amount
        metadata: { action: 'bridge' },
      };
      actions.push(bridgeAction);
      estimatedCostUsd += ESTIMATED_CROSS_CHAIN_COST_USD;
      estimatedDurationMs += 120_000;
    }

    // Step 3: Deposit into target vault
    const depositAction: ComposerAction = {
      id: `yh-deposit-${now}`,
      type: 'composer',
      priority: actions.length + 1,
      createdAt: now,
      strategyId: this.name,
      fromChain: signal.destChain,
      toChain: signal.destChain,
      fromToken: signal.tokenPair.to.address,
      toToken: signal.tokenPair.to.address, // vault token
      amount: 0n, // executor resolves actual amount
      protocol: (signal.metadata['toProtocol'] as string) ?? 'unknown',
      metadata: { action: 'deposit', apy: signal.metadata['targetApy'] },
    };
    actions.push(depositAction);
    estimatedCostUsd += ESTIMATED_SAME_CHAIN_COST_USD;
    estimatedDurationMs += 15_000;

    return {
      id: `yh-plan-${now}`,
      strategyName: this.name,
      actions,
      estimatedCostUsd,
      estimatedDurationMs,
      metadata: {
        signalReason: signal.reason,
        targetApy: signal.metadata['targetApy'],
        isCrossChain,
        isMigration,
      },
    };
  }

  // --- Filters ------------------------------------------------------------

  override filters(): StrategyFilter[] {
    return [
      // Min APY improvement: at least one opportunity must beat the threshold
      (ctx) => {
        const filtered = this.filterOpportunities(this.yieldData);
        if (filtered.length === 0) return false;

        // If no positions, any opportunity is acceptable
        if (ctx.positions.length === 0) return true;

        // Check if any opportunity beats current positions by the threshold
        const best = filtered.reduce((a, b) => (a.apy > b.apy ? a : b));
        const currentApys = ctx.positions
          .filter((p) => p.strategyId === this.name)
          .map((p) => (p.pnlPercent ?? 0) * 100);

        if (currentApys.length === 0) return true;
        const maxCurrentApy = Math.max(...currentApys);
        return best.apy - maxCurrentApy >= this.minimumApyImprovement;
      },

      // Max positions gate
      (ctx) => {
        const ownPositions = ctx.positions.filter(
          (p) => p.strategyId === this.name,
        );
        return ownPositions.length < this.maxPositions;
      },

      // Allowed chains gate (empty = allow all)
      (_ctx) => {
        if (this.allowedChains.length === 0) return true;
        const filtered = this.filterOpportunities(this.yieldData);
        return filtered.length > 0;
      },

      // Allowed protocols gate (empty = allow all)
      (_ctx) => {
        if (this.allowedProtocols.length === 0) return true;
        const filtered = this.filterOpportunities(this.yieldData);
        return filtered.length > 0;
      },
    ];
  }

  // --- Trade confirmation -------------------------------------------------

  override confirmTradeEntry(plan: ExecutionPlan): boolean {
    const targetApy = plan.metadata['targetApy'] as number | undefined;
    if (targetApy === undefined) return false;

    // Annualized cost as a % of a nominal $1000 position
    const nominalPositionUsd = 1000;
    const annualizedCostPercent =
      (plan.estimatedCostUsd / nominalPositionUsd) * 100;

    // The target APY must exceed the annualized cost of executing the trade
    return targetApy > annualizedCostPercent;
  }

  // --- Private helpers ----------------------------------------------------

  /**
   * Filter opportunities by allowed chains and allowed protocols.
   */
  private filterOpportunities(
    opportunities: readonly YieldOpportunity[],
  ): YieldOpportunity[] {
    return opportunities.filter((opp) => {
      if (
        this.allowedChains.length > 0 &&
        !this.allowedChains.includes(opp.chainId)
      ) {
        return false;
      }
      if (
        this.allowedProtocols.length > 0 &&
        !this.allowedProtocols.includes(opp.protocol)
      ) {
        return false;
      }
      return true;
    });
  }

  /**
   * Find idle capital: a balance key with a positive balance and no matching
   * position for this strategy.
   */
  private findIdleCapital(
    context: StrategyContext,
  ): { key: string; amount: bigint } | null {
    for (const [key, amount] of context.balances) {
      if (amount <= 0n) continue;

      // Check no existing position for this strategy on this key
      const hasPosition = context.positions.some(
        (p) =>
          p.strategyId === this.name &&
          `${p.chainId as number}-${p.tokenAddress as string}` === key,
      );
      if (!hasPosition) {
        return { key, amount };
      }
    }
    return null;
  }

  /**
   * Build an entry signal for deploying idle capital into a yield opportunity.
   */
  private buildEntrySignal(
    opportunity: YieldOpportunity,
    _idleCapital: { key: string; amount: bigint },
  ): StrategySignal {
    return {
      direction: 'long',
      tokenPair: {
        from: {
          address: opportunity.token,
          symbol: 'UNDERLYING',
          decimals: 18,
        },
        to: {
          address: opportunity.token,
          symbol: opportunity.protocol,
          decimals: 18,
        },
      },
      sourceChain: opportunity.chainId,
      destChain: opportunity.chainId,
      strength: Math.min(opportunity.apy / 20, 1), // normalize APY to 0-1 strength
      reason: `Deploy idle capital into ${opportunity.protocol} at ${opportunity.apy.toFixed(1)}% APY`,
      metadata: {
        type: 'entry',
        targetApy: opportunity.apy,
        toProtocol: opportunity.protocol,
        tvl: opportunity.tvl,
        riskScore: opportunity.riskScore,
      },
    };
  }

  /**
   * Find a migration opportunity: existing position in a lower-yield venue
   * when a better opportunity exists (net improvement > minimumApyImprovement).
   */
  private findMigrationOpportunity(
    positions: readonly Position[],
    sortedOpportunities: readonly YieldOpportunity[],
  ): StrategySignal | null {
    if (sortedOpportunities.length === 0) return null;

    const ownPositions = positions.filter((p) => p.strategyId === this.name);
    if (ownPositions.length === 0) return null;

    const best = sortedOpportunities[0]!;

    for (const position of ownPositions) {
      // Use pnlPercent * 100 as a proxy for current APY
      const currentApy = position.pnlPercent * 100;
      const improvement = best.apy - currentApy;

      if (improvement >= this.minimumApyImprovement) {
        const isCrossChain =
          (position.chainId as number) !== (best.chainId as number);

        return {
          direction: 'long',
          tokenPair: {
            from: {
              address: position.tokenAddress,
              symbol: 'CURRENT',
              decimals: 18,
            },
            to: {
              address: best.token,
              symbol: best.protocol,
              decimals: 18,
            },
          },
          sourceChain: position.chainId,
          destChain: best.chainId,
          strength: Math.min(improvement / 10, 1),
          reason: `Migrate from ${currentApy.toFixed(1)}% to ${best.protocol} at ${best.apy.toFixed(1)}% APY (+${improvement.toFixed(1)}pp)`,
          metadata: {
            type: 'migration',
            fromProtocol: 'current',
            toProtocol: best.protocol,
            currentApy,
            targetApy: best.apy,
            improvement,
            isCrossChain,
            positionId: position.id,
          },
        };
      }
    }

    return null;
  }
}
