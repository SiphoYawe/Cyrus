import { describe, it, expect, beforeEach } from 'vitest';
import {
  LiquidStakingStrategy,
  SUPPORTED_STAKING_PROTOCOLS,
} from '../liquid-staking.js';
import type { StakingRate } from '../liquid-staking.js';
import type {
  StrategyContext,
  StrategySignal,
  Position,
  ChainId,
  TokenAddress,
} from '../../../core/types.js';
import { chainId, tokenAddress } from '../../../core/types.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeContext(overrides: Partial<StrategyContext> = {}): StrategyContext {
  return {
    timestamp: Date.now(),
    balances: new Map(),
    positions: [],
    prices: new Map(),
    activeTransfers: [],
    ...overrides,
  };
}

function makePosition(overrides: Partial<Position> = {}): Position {
  return {
    id: 'pos-1',
    strategyId: 'LiquidStaking',
    chainId: chainId(1),
    tokenAddress: SUPPORTED_STAKING_PROTOCOLS[0]!.receiptToken,
    entryPrice: 2000,
    currentPrice: 2050,
    amount: 1000000000000000000n,
    enteredAt: Date.now(),
    pnlUsd: 50,
    pnlPercent: 0.025,
    ...overrides,
  };
}

function makeLidoRate(overrides: Partial<StakingRate> = {}): StakingRate {
  return {
    protocol: 'lido',
    chainId: chainId(1),
    receiptToken: tokenAddress('0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0'),
    apy: 4.5,
    tvl: 10_000_000_000,
    underlyingToken: tokenAddress('0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'),
    exchangeRate: 1.15,
    ...overrides,
  };
}

function makeEtherfiRate(overrides: Partial<StakingRate> = {}): StakingRate {
  return {
    protocol: 'etherfi',
    chainId: chainId(1),
    receiptToken: tokenAddress('0x35fa164735182de50811e8e2e824cfb9b6118ac2'),
    apy: 5.0,
    tvl: 5_000_000_000,
    underlyingToken: tokenAddress('0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'),
    exchangeRate: 1.0,
    ...overrides,
  };
}

function makeEthenaRate(overrides: Partial<StakingRate> = {}): StakingRate {
  return {
    protocol: 'ethena',
    chainId: chainId(1),
    receiptToken: tokenAddress('0x9d39a5de30e57443bff2a8307a4256c8797a3497'),
    apy: 8.0,
    tvl: 3_000_000_000,
    underlyingToken: tokenAddress('0x4c9edd5852cd905f086c759e8383e09bff1e68b3'),
    exchangeRate: 1.05,
    ...overrides,
  };
}

const WETH_ADDRESS = tokenAddress('0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2');
const WSTETH_ADDRESS = tokenAddress('0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LiquidStakingStrategy', () => {
  let strategy: LiquidStakingStrategy;

  beforeEach(() => {
    strategy = new LiquidStakingStrategy();
  });

  // -----------------------------------------------------------------------
  // Identity & defaults
  // -----------------------------------------------------------------------

  describe('identity and defaults', () => {
    it('has correct name', () => {
      expect(strategy.name).toBe('LiquidStaking');
    });

    it('has correct timeframe', () => {
      expect(strategy.timeframe).toBe('10m');
    });

    it('has Safe-tier stoploss of -0.05', () => {
      expect(strategy.stoploss).toBe(-0.05);
    });

    it('has Safe-tier minimalRoi of { 0: 0.01 }', () => {
      expect(strategy.minimalRoi).toEqual({ 0: 0.01 });
    });

    it('has trailingStop disabled', () => {
      expect(strategy.trailingStop).toBe(false);
    });

    it('has maxPositions of 3', () => {
      expect(strategy.maxPositions).toBe(3);
    });

    it('has default minimumStakingApy of 2.0', () => {
      expect(strategy.minimumStakingApy).toBe(2.0);
    });

    it('has default depegThreshold of 0.02', () => {
      expect(strategy.depegThreshold).toBe(0.02);
    });

    it('has default migrationMinImprovement of 1.0', () => {
      expect(strategy.migrationMinImprovement).toBe(1.0);
    });

    it('accepts custom configuration', () => {
      const custom = new LiquidStakingStrategy({
        minimumStakingApy: 3.0,
        depegThreshold: 0.05,
        migrationMinImprovement: 2.0,
      });
      expect(custom.minimumStakingApy).toBe(3.0);
      expect(custom.depegThreshold).toBe(0.05);
      expect(custom.migrationMinImprovement).toBe(2.0);
    });

    it('passes base class validateConfig', () => {
      expect(() => strategy.validateConfig()).not.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // shouldExecute — entry signals
  // -----------------------------------------------------------------------

  describe('shouldExecute — entry', () => {
    it('returns entry signal when idle capital and staking rates available', () => {
      strategy.setStakingRates([makeLidoRate()]);
      const balanceKey = `${1}-${WETH_ADDRESS as string}`;

      const ctx = makeContext({
        balances: new Map([[balanceKey, 5000000000000000000n]]),
      });

      const signal = strategy.shouldExecute(ctx);
      expect(signal).not.toBeNull();
      expect(signal!.direction).toBe('long');
      expect(signal!.reason).toContain('stake_entry');
      expect(signal!.reason).toContain('lido');
    });

    it('selects highest APY protocol', () => {
      strategy.setStakingRates([
        makeLidoRate({ apy: 4.0 }),
        makeEtherfiRate({ apy: 6.0 }),
      ]);
      const balanceKey = `${1}-${WETH_ADDRESS as string}`;

      const ctx = makeContext({
        balances: new Map([[balanceKey, 5000000000000000000n]]),
      });

      const signal = strategy.shouldExecute(ctx);
      expect(signal).not.toBeNull();
      expect(signal!.metadata['protocol']).toBe('etherfi');
      expect(signal!.metadata['apy']).toBe(6.0);
    });

    it('returns null when all APYs below minimum', () => {
      strategy.setStakingRates([
        makeLidoRate({ apy: 1.0 }),
        makeEtherfiRate({ apy: 0.5 }),
      ]);
      const balanceKey = `${1}-${WETH_ADDRESS as string}`;

      const ctx = makeContext({
        balances: new Map([[balanceKey, 5000000000000000000n]]),
      });

      const signal = strategy.shouldExecute(ctx);
      expect(signal).toBeNull();
    });

    it('returns null when no idle capital', () => {
      strategy.setStakingRates([makeLidoRate()]);

      const ctx = makeContext({
        balances: new Map(), // no balances
      });

      const signal = strategy.shouldExecute(ctx);
      expect(signal).toBeNull();
    });

    it('returns null when already holding a staking position', () => {
      strategy.setStakingRates([makeLidoRate()]);
      const balanceKey = `${1}-${WETH_ADDRESS as string}`;

      const ctx = makeContext({
        balances: new Map([[balanceKey, 5000000000000000000n]]),
        positions: [makePosition()],
      });

      // No entry when already staking (depeg/apy checks require price data or low APY)
      // With healthy rates and no depeg, should return null
      const signal = strategy.shouldExecute(ctx);
      expect(signal).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // shouldExecute — APY drop
  // -----------------------------------------------------------------------

  describe('shouldExecute — APY drop debouncing', () => {
    it('does NOT fire exit on single APY drop check', () => {
      strategy.setStakingRates([makeLidoRate({ apy: 1.5 })]);

      const ctx = makeContext({
        positions: [makePosition()],
      });

      const signal = strategy.shouldExecute(ctx);
      expect(signal).toBeNull();
    });

    it('fires exit after 2 consecutive APY drop checks', () => {
      strategy.setStakingRates([makeLidoRate({ apy: 1.5 })]);

      const ctx = makeContext({
        positions: [makePosition()],
      });

      // First check — debounce, no signal
      const signal1 = strategy.shouldExecute(ctx);
      expect(signal1).toBeNull();

      // Second check — fires exit
      const signal2 = strategy.shouldExecute(ctx);
      expect(signal2).not.toBeNull();
      expect(signal2!.direction).toBe('exit');
      expect(signal2!.reason).toBe('apy_drop');
    });

    it('resets APY drop counter when APY recovers', () => {
      const ctx = makeContext({
        positions: [makePosition()],
      });

      // First check with low APY
      strategy.setStakingRates([makeLidoRate({ apy: 1.5 })]);
      strategy.shouldExecute(ctx);

      // APY recovers
      strategy.setStakingRates([makeLidoRate({ apy: 4.0 })]);
      strategy.shouldExecute(ctx);

      // Drop again — should not fire (counter was reset)
      strategy.setStakingRates([makeLidoRate({ apy: 1.5 })]);
      const signal = strategy.shouldExecute(ctx);
      expect(signal).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // shouldExecute — depeg detection
  // -----------------------------------------------------------------------

  describe('shouldExecute — depeg', () => {
    it('fires exit when receipt token diverges >2% from expected value', () => {
      const rate = makeLidoRate({ exchangeRate: 1.15 });
      strategy.setStakingRates([rate]);

      const underlyingPriceKey = `${1}-${WETH_ADDRESS as string}`;
      const receiptPriceKey = `${1}-${WSTETH_ADDRESS as string}`;

      // Expected receipt price = 2000 * 1.15 = 2300
      // Set actual receipt price to 2200 — divergence ~4.35%
      const ctx = makeContext({
        positions: [makePosition()],
        prices: new Map([
          [underlyingPriceKey, 2000],
          [receiptPriceKey, 2200],
        ]),
      });

      const signal = strategy.shouldExecute(ctx);
      expect(signal).not.toBeNull();
      expect(signal!.direction).toBe('exit');
      expect(signal!.reason).toBe('depeg');
    });

    it('returns exit signal with reason depeg and correct metadata', () => {
      const rate = makeLidoRate({ exchangeRate: 1.15 });
      strategy.setStakingRates([rate]);

      const underlyingPriceKey = `${1}-${WETH_ADDRESS as string}`;
      const receiptPriceKey = `${1}-${WSTETH_ADDRESS as string}`;

      const ctx = makeContext({
        positions: [makePosition()],
        prices: new Map([
          [underlyingPriceKey, 2000],
          [receiptPriceKey, 2200],
        ]),
      });

      const signal = strategy.shouldExecute(ctx);
      expect(signal).not.toBeNull();
      expect(signal!.reason).toBe('depeg');
      expect(signal!.metadata['protocol']).toBe('lido');
      expect(signal!.metadata['divergence']).toBeGreaterThan(0.02);
      expect(signal!.strength).toBe(1.0);
    });

    it('does not fire depeg when prices are within threshold', () => {
      const rate = makeLidoRate({ exchangeRate: 1.15 });
      strategy.setStakingRates([rate]);

      const underlyingPriceKey = `${1}-${WETH_ADDRESS as string}`;
      const receiptPriceKey = `${1}-${WSTETH_ADDRESS as string}`;

      // Expected = 2000 * 1.15 = 2300, actual = 2295 — divergence ~0.22%
      const ctx = makeContext({
        positions: [makePosition()],
        prices: new Map([
          [underlyingPriceKey, 2000],
          [receiptPriceKey, 2295],
        ]),
      });

      const signal = strategy.shouldExecute(ctx);
      // No depeg, and APY is healthy — should be null
      expect(signal).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // shouldExecute — migration
  // -----------------------------------------------------------------------

  describe('shouldExecute — migration', () => {
    it('returns migration signal when net improvement exceeds threshold', () => {
      strategy.setStakingRates([
        makeLidoRate({ apy: 3.0 }),
        makeEtherfiRate({ apy: 4.5 }), // improvement = 1.5, above default threshold 1.0
      ]);

      const ctx = makeContext({
        positions: [makePosition()],
      });

      const signal = strategy.shouldExecute(ctx);
      expect(signal).not.toBeNull();
      expect(signal!.reason).toBe('migration');
      expect(signal!.metadata['migration']).toBe(true);
      expect(signal!.metadata['targetProtocol']).toBe('etherfi');
      expect(signal!.metadata['improvement']).toBe(1.5);
    });

    it('does not trigger migration when improvement is below threshold', () => {
      strategy.setStakingRates([
        makeLidoRate({ apy: 3.5 }),
        makeEtherfiRate({ apy: 4.0 }), // improvement = 0.5, below threshold 1.0
      ]);

      const ctx = makeContext({
        positions: [makePosition()],
      });

      const signal = strategy.shouldExecute(ctx);
      expect(signal).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // buildExecution
  // -----------------------------------------------------------------------

  describe('buildExecution', () => {
    it('returns ComposerAction with correct receipt token for entry', () => {
      strategy.setStakingRates([makeLidoRate()]);
      const balanceKey = `${1}-${WETH_ADDRESS as string}`;

      const ctx = makeContext({
        balances: new Map([[balanceKey, 5000000000000000000n]]),
      });

      const signal = strategy.shouldExecute(ctx)!;
      expect(signal).not.toBeNull();

      const plan = strategy.buildExecution(signal, ctx);
      expect(plan.strategyName).toBe('LiquidStaking');
      expect(plan.actions).toHaveLength(1);

      const action = plan.actions[0]!;
      expect(action.type).toBe('composer');

      const composerAction = action as import('../../../core/action-types.js').ComposerAction;
      expect(composerAction.toToken).toBe(WSTETH_ADDRESS);
      expect(composerAction.fromToken).toBe(WETH_ADDRESS);
      expect(composerAction.protocol).toBe('lido');
      expect(composerAction.metadata['action']).toBe('stake');
    });

    it('returns withdraw + deposit actions for migration', () => {
      strategy.setStakingRates([
        makeLidoRate({ apy: 3.0 }),
        makeEtherfiRate({ apy: 4.5 }),
      ]);

      const ctx = makeContext({
        positions: [makePosition()],
      });

      const signal = strategy.shouldExecute(ctx)!;
      expect(signal).not.toBeNull();
      expect(signal.reason).toBe('migration');

      const plan = strategy.buildExecution(signal, ctx);
      expect(plan.actions.length).toBeGreaterThanOrEqual(2);

      // First action: withdraw from current protocol
      const withdrawAction = plan.actions[0]!;
      expect(withdrawAction.type).toBe('composer');
      expect(
        (withdrawAction as import('../../../core/action-types.js').ComposerAction).metadata['action'],
      ).toBe('unstake');

      // Last action: deposit into target protocol
      const depositAction = plan.actions[plan.actions.length - 1]!;
      expect(depositAction.type).toBe('composer');
      expect(
        (depositAction as import('../../../core/action-types.js').ComposerAction).metadata['action'],
      ).toBe('stake');
      expect(
        (depositAction as import('../../../core/action-types.js').ComposerAction).protocol,
      ).toBe('etherfi');
    });

    it('returns only withdraw action for simple exit', () => {
      strategy.setStakingRates([makeLidoRate({ apy: 1.5 })]);

      const ctx = makeContext({
        positions: [makePosition()],
      });

      // Trigger debounced APY drop
      strategy.shouldExecute(ctx);
      const signal = strategy.shouldExecute(ctx)!;
      expect(signal).not.toBeNull();
      expect(signal.reason).toBe('apy_drop');

      const plan = strategy.buildExecution(signal, ctx);
      expect(plan.actions).toHaveLength(1);

      const action = plan.actions[0]!;
      expect(action.type).toBe('composer');
      expect(
        (action as import('../../../core/action-types.js').ComposerAction).metadata['action'],
      ).toBe('unstake');
    });
  });

  // -----------------------------------------------------------------------
  // Filters
  // -----------------------------------------------------------------------

  describe('filters', () => {
    it('rejects when no staking rate meets minimum APY', () => {
      strategy.setStakingRates([
        makeLidoRate({ apy: 1.0 }),
        makeEtherfiRate({ apy: 0.5 }),
      ]);

      const result = strategy.evaluateFilters(makeContext());
      expect(result).toBe(false);
    });

    it('passes when at least one rate meets minimum APY', () => {
      strategy.setStakingRates([
        makeLidoRate({ apy: 1.0 }),
        makeEtherfiRate({ apy: 3.0 }),
      ]);

      const result = strategy.evaluateFilters(makeContext());
      expect(result).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // confirmTradeExit
  // -----------------------------------------------------------------------

  describe('confirmTradeExit', () => {
    it('confirms exit for valid reasons', () => {
      const position = makePosition();
      expect(strategy.confirmTradeExit(position, 'apy_drop')).toBe(true);
      expect(strategy.confirmTradeExit(position, 'depeg')).toBe(true);
      expect(strategy.confirmTradeExit(position, 'migration')).toBe(true);
      expect(strategy.confirmTradeExit(position, 'stoploss')).toBe(true);
      expect(strategy.confirmTradeExit(position, 'roi_target')).toBe(true);
    });

    it('rejects exit for invalid reasons', () => {
      const position = makePosition();
      expect(strategy.confirmTradeExit(position, 'random')).toBe(false);
      expect(strategy.confirmTradeExit(position, '')).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // SUPPORTED_STAKING_PROTOCOLS
  // -----------------------------------------------------------------------

  describe('SUPPORTED_STAKING_PROTOCOLS', () => {
    it('contains lido, etherfi, and ethena', () => {
      const names = SUPPORTED_STAKING_PROTOCOLS.map((p) => p.name);
      expect(names).toContain('lido');
      expect(names).toContain('etherfi');
      expect(names).toContain('ethena');
    });

    it('has 3 protocols', () => {
      expect(SUPPORTED_STAKING_PROTOCOLS).toHaveLength(3);
    });
  });
});
