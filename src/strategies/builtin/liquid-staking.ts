import { CrossChainStrategy } from '../cross-chain-strategy.js';
import type {
  StrategySignal,
  ExecutionPlan,
  StrategyContext,
  StrategyFilter,
  Position,
  ChainId,
  TokenAddress,
  TokenInfo,
} from '../../core/types.js';
import { chainId, tokenAddress } from '../../core/types.js';
import type { ComposerAction, BridgeAction, ExecutorAction } from '../../core/action-types.js';

// ---------------------------------------------------------------------------
// Staking protocol definitions
// ---------------------------------------------------------------------------

export interface StakingProtocol {
  readonly name: string;
  readonly receiptToken: TokenAddress;
  readonly underlyingToken: TokenAddress;
  readonly chainId: ChainId;
  readonly symbol: string;
}

export const SUPPORTED_STAKING_PROTOCOLS: readonly StakingProtocol[] = [
  {
    name: 'lido',
    receiptToken: tokenAddress('0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0'),
    underlyingToken: tokenAddress('0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'),
    chainId: chainId(1),
    symbol: 'wstETH',
  },
  {
    name: 'etherfi',
    receiptToken: tokenAddress('0x35fa164735182de50811e8e2e824cfb9b6118ac2'),
    underlyingToken: tokenAddress('0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'),
    chainId: chainId(1),
    symbol: 'eETH',
  },
  {
    name: 'ethena',
    receiptToken: tokenAddress('0x9d39a5de30e57443bff2a8307a4256c8797a3497'),
    underlyingToken: tokenAddress('0x4c9edd5852cd905f086c759e8383e09bff1e68b3'),
    chainId: chainId(1),
    symbol: 'sUSDe',
  },
];

// ---------------------------------------------------------------------------
// Staking rate — external data injected via setStakingRates()
// ---------------------------------------------------------------------------

export interface StakingRate {
  readonly protocol: string;
  readonly chainId: ChainId;
  readonly receiptToken: TokenAddress;
  readonly apy: number;
  readonly tvl: number;
  readonly underlyingToken: TokenAddress;
  readonly exchangeRate: number;
}

// ---------------------------------------------------------------------------
// LiquidStakingStrategy
// ---------------------------------------------------------------------------

export class LiquidStakingStrategy extends CrossChainStrategy {
  readonly name = 'LiquidStaking';
  readonly timeframe = '10m';

  // Safe-tier risk defaults
  override readonly stoploss = -0.05;
  override readonly minimalRoi: Readonly<Record<number, number>> = { 0: 0.01 };
  override readonly trailingStop = false;
  override readonly maxPositions = 3;

  // Configurable thresholds
  readonly minimumStakingApy: number;
  readonly depegThreshold: number;
  readonly migrationMinImprovement: number;

  // Internal state
  private stakingRates: StakingRate[] = [];
  private apyDropCount: Map<string, number> = new Map();

  constructor(options?: {
    minimumStakingApy?: number;
    depegThreshold?: number;
    migrationMinImprovement?: number;
  }) {
    super();
    this.minimumStakingApy = options?.minimumStakingApy ?? 2.0;
    this.depegThreshold = options?.depegThreshold ?? 0.02;
    this.migrationMinImprovement = options?.migrationMinImprovement ?? 1.0;
  }

  // ---------------------------------------------------------------------------
  // Data injection
  // ---------------------------------------------------------------------------

  setStakingRates(rates: StakingRate[]): void {
    this.stakingRates = rates;
  }

  // ---------------------------------------------------------------------------
  // shouldExecute — synchronous signal generation
  // ---------------------------------------------------------------------------

  shouldExecute(context: StrategyContext): StrategySignal | null {
    // Check for depeg on existing positions first (emergency takes priority)
    const depegSignal = this.checkDepeg(context);
    if (depegSignal) return depegSignal;

    // Check for APY drop on existing positions
    const apyDropSignal = this.checkApyDrop(context);
    if (apyDropSignal) return apyDropSignal;

    // Check for migration opportunity
    const migrationSignal = this.checkMigration(context);
    if (migrationSignal) return migrationSignal;

    // Check for new entry opportunity
    const entrySignal = this.checkEntry(context);
    if (entrySignal) return entrySignal;

    return null;
  }

  // ---------------------------------------------------------------------------
  // buildExecution — translate signal into concrete actions
  // ---------------------------------------------------------------------------

  buildExecution(signal: StrategySignal, _context: StrategyContext): ExecutionPlan {
    const actions: ExecutorAction[] = [];
    const now = Date.now();

    if (signal.direction === 'long') {
      // Entry: deposit underlying into staking protocol via Composer
      const protocol = signal.metadata['protocol'] as string;
      const amount = signal.metadata['amount'] as bigint | undefined;

      const composerAction: ComposerAction = {
        id: `ls-deposit-${now}`,
        type: 'composer',
        priority: 1,
        createdAt: now,
        strategyId: this.name,
        fromChain: signal.sourceChain,
        toChain: signal.destChain,
        fromToken: signal.tokenPair.from.address,
        toToken: signal.tokenPair.to.address,
        amount: amount ?? 0n,
        protocol,
        metadata: { action: 'stake', reason: signal.reason },
      };
      actions.push(composerAction);
    } else if (signal.direction === 'exit') {
      // Exit: withdraw from staking protocol
      const protocol = signal.metadata['protocol'] as string;
      const amount = signal.metadata['amount'] as bigint | undefined;

      const withdrawAction: ComposerAction = {
        id: `ls-withdraw-${now}`,
        type: 'composer',
        priority: 1,
        createdAt: now,
        strategyId: this.name,
        fromChain: signal.sourceChain,
        toChain: signal.destChain,
        fromToken: signal.tokenPair.from.address,
        toToken: signal.tokenPair.to.address,
        amount: amount ?? 0n,
        protocol,
        metadata: { action: 'unstake', reason: signal.reason },
      };
      actions.push(withdrawAction);

      // For migration: add bridge + deposit to target protocol
      if (signal.metadata['migration'] === true) {
        const targetProtocol = signal.metadata['targetProtocol'] as string;
        const targetChain = signal.metadata['targetChain'] as ChainId;
        const targetReceiptToken = signal.metadata['targetReceiptToken'] as TokenAddress;

        // Bridge if cross-chain
        if (signal.sourceChain !== targetChain) {
          const bridgeAction: BridgeAction = {
            id: `ls-bridge-${now}`,
            type: 'bridge',
            priority: 2,
            createdAt: now,
            strategyId: this.name,
            fromChain: signal.sourceChain,
            toChain: targetChain,
            fromToken: signal.tokenPair.to.address,
            toToken: signal.tokenPair.to.address,
            amount: amount ?? 0n,
            metadata: { reason: 'migration_bridge' },
          };
          actions.push(bridgeAction);
        }

        // Deposit into target protocol
        const depositAction: ComposerAction = {
          id: `ls-redeposit-${now}`,
          type: 'composer',
          priority: 3,
          createdAt: now,
          strategyId: this.name,
          fromChain: targetChain,
          toChain: targetChain,
          fromToken: signal.tokenPair.to.address,
          toToken: targetReceiptToken,
          amount: amount ?? 0n,
          protocol: targetProtocol,
          metadata: { action: 'stake', reason: 'migration_deposit' },
        };
        actions.push(depositAction);
      }
    }

    return {
      id: `ls-plan-${now}`,
      strategyName: this.name,
      actions,
      estimatedCostUsd: actions.length * 5, // rough gas estimate per action
      estimatedDurationMs: actions.length * 30_000,
      metadata: {
        direction: signal.direction,
        reason: signal.reason,
        protocol: signal.metadata['protocol'],
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Filters
  // ---------------------------------------------------------------------------

  override filters(): StrategyFilter[] {
    return [
      (_ctx: StrategyContext): boolean => {
        // Minimum APY filter: at least one protocol must exceed minimumStakingApy
        return this.stakingRates.some((r) => r.apy >= this.minimumStakingApy);
      },
    ];
  }

  // ---------------------------------------------------------------------------
  // Trade confirmation
  // ---------------------------------------------------------------------------

  override confirmTradeExit(_position: Position, reason: string): boolean {
    const validReasons = ['apy_drop', 'depeg', 'migration', 'stoploss', 'roi_target'];
    return validReasons.includes(reason);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private findStakingPosition(context: StrategyContext): {
    position: Position;
    protocol: StakingProtocol;
    rate: StakingRate | undefined;
  } | null {
    for (const protocol of SUPPORTED_STAKING_PROTOCOLS) {
      const position = context.positions.find(
        (p) =>
          p.strategyId === this.name &&
          p.tokenAddress === protocol.receiptToken &&
          p.chainId === protocol.chainId,
      );
      if (position) {
        const rate = this.stakingRates.find(
          (r) => r.protocol === protocol.name && r.chainId === protocol.chainId,
        );
        return { position, protocol, rate };
      }
    }
    return null;
  }

  private checkEntry(context: StrategyContext): StrategySignal | null {
    // Already have a staking position — skip entry
    const existing = this.findStakingPosition(context);
    if (existing) return null;

    // Check for idle capital: any balance for an underlying token
    const eligibleRates = this.stakingRates
      .filter((r) => r.apy >= this.minimumStakingApy)
      .sort((a, b) => b.apy - a.apy);

    for (const rate of eligibleRates) {
      const balanceKey = `${rate.chainId as number}-${rate.underlyingToken as string}`;
      const balance = context.balances.get(balanceKey);
      if (balance !== undefined && balance > 0n) {
        const protocol = SUPPORTED_STAKING_PROTOCOLS.find(
          (p) => p.name === rate.protocol && p.chainId === rate.chainId,
        );
        if (!protocol) continue;

        const fromToken: TokenInfo = {
          address: protocol.underlyingToken,
          symbol: 'underlying',
          decimals: 18,
        };
        const toToken: TokenInfo = {
          address: protocol.receiptToken,
          symbol: protocol.symbol,
          decimals: 18,
        };

        return {
          direction: 'long',
          tokenPair: { from: fromToken, to: toToken },
          sourceChain: protocol.chainId,
          destChain: protocol.chainId,
          strength: Math.min(rate.apy / 10, 1.0),
          reason: `stake_entry: ${protocol.name} APY ${rate.apy.toFixed(2)}%`,
          metadata: {
            protocol: protocol.name,
            apy: rate.apy,
            amount: balance,
          },
        };
      }
    }

    return null;
  }

  private checkApyDrop(context: StrategyContext): StrategySignal | null {
    const found = this.findStakingPosition(context);
    if (!found) return null;

    const { position, protocol, rate } = found;
    if (!rate) return null;

    const key = `${protocol.name}-${protocol.chainId as number}`;

    if (rate.apy < this.minimumStakingApy) {
      const count = (this.apyDropCount.get(key) ?? 0) + 1;
      this.apyDropCount.set(key, count);

      if (count >= 2) {
        // Debounced: 2 consecutive evaluations below minimum
        this.apyDropCount.delete(key);

        const fromToken: TokenInfo = {
          address: protocol.receiptToken,
          symbol: protocol.symbol,
          decimals: 18,
        };
        const toToken: TokenInfo = {
          address: protocol.underlyingToken,
          symbol: 'underlying',
          decimals: 18,
        };

        return {
          direction: 'exit',
          tokenPair: { from: fromToken, to: toToken },
          sourceChain: protocol.chainId,
          destChain: protocol.chainId,
          strength: 0.9,
          reason: 'apy_drop',
          metadata: {
            protocol: protocol.name,
            currentApy: rate.apy,
            minimumApy: this.minimumStakingApy,
            amount: position.amount,
          },
        };
      }
    } else {
      // APY recovered — reset counter
      this.apyDropCount.delete(key);
    }

    return null;
  }

  private checkDepeg(context: StrategyContext): StrategySignal | null {
    const found = this.findStakingPosition(context);
    if (!found) return null;

    const { position, protocol, rate } = found;
    if (!rate) return null;

    // Compare receipt token price vs underlying token price
    const receiptPriceKey = `${protocol.chainId as number}-${protocol.receiptToken as string}`;
    const underlyingPriceKey = `${protocol.chainId as number}-${protocol.underlyingToken as string}`;

    const receiptPrice = context.prices.get(receiptPriceKey);
    const underlyingPrice = context.prices.get(underlyingPriceKey);

    if (receiptPrice === undefined || underlyingPrice === undefined || underlyingPrice === 0) {
      return null;
    }

    // Adjust receipt price by exchange rate to get comparable value
    const expectedReceiptPrice = underlyingPrice * rate.exchangeRate;
    const divergence = Math.abs(receiptPrice - expectedReceiptPrice) / expectedReceiptPrice;

    if (divergence > this.depegThreshold) {
      const fromToken: TokenInfo = {
        address: protocol.receiptToken,
        symbol: protocol.symbol,
        decimals: 18,
      };
      const toToken: TokenInfo = {
        address: protocol.underlyingToken,
        symbol: 'underlying',
        decimals: 18,
      };

      return {
        direction: 'exit',
        tokenPair: { from: fromToken, to: toToken },
        sourceChain: protocol.chainId,
        destChain: protocol.chainId,
        strength: 1.0,
        reason: 'depeg',
        metadata: {
          protocol: protocol.name,
          divergence,
          receiptPrice,
          expectedReceiptPrice,
          threshold: this.depegThreshold,
          amount: position.amount,
        },
      };
    }

    return null;
  }

  private checkMigration(context: StrategyContext): StrategySignal | null {
    const found = this.findStakingPosition(context);
    if (!found) return null;

    const { position, protocol, rate } = found;
    if (!rate) return null;

    // Find a better-yielding protocol
    const betterRates = this.stakingRates
      .filter(
        (r) =>
          r.protocol !== protocol.name &&
          r.apy >= this.minimumStakingApy &&
          r.apy - rate.apy >= this.migrationMinImprovement,
      )
      .sort((a, b) => b.apy - a.apy);

    if (betterRates.length === 0) return null;

    const target = betterRates[0]!;
    const targetProtocol = SUPPORTED_STAKING_PROTOCOLS.find(
      (p) => p.name === target.protocol && p.chainId === target.chainId,
    );
    if (!targetProtocol) return null;

    const fromToken: TokenInfo = {
      address: protocol.receiptToken,
      symbol: protocol.symbol,
      decimals: 18,
    };
    const toToken: TokenInfo = {
      address: protocol.underlyingToken,
      symbol: 'underlying',
      decimals: 18,
    };

    return {
      direction: 'exit',
      tokenPair: { from: fromToken, to: toToken },
      sourceChain: protocol.chainId,
      destChain: protocol.chainId,
      strength: Math.min((target.apy - rate.apy) / 5, 1.0),
      reason: 'migration',
      metadata: {
        protocol: protocol.name,
        currentApy: rate.apy,
        targetProtocol: targetProtocol.name,
        targetApy: target.apy,
        improvement: target.apy - rate.apy,
        targetChain: targetProtocol.chainId,
        targetReceiptToken: targetProtocol.receiptToken,
        migration: true,
        amount: position.amount,
      },
    };
  }
}
