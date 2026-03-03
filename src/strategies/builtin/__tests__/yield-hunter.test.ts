import { describe, it, expect, beforeEach } from 'vitest';
import { YieldHunter } from '../yield-hunter.js';
import type { YieldOpportunity } from '../yield-hunter.js';
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
    strategyId: 'YieldHunter',
    chainId: chainId(1),
    tokenAddress: tokenAddress('0x0000000000000000000000000000000000000001'),
    entryPrice: 100,
    currentPrice: 102,
    amount: 1000000000000000000n,
    enteredAt: Date.now(),
    pnlUsd: 2,
    pnlPercent: 0.02, // 2% → proxy APY of 2%
    ...overrides,
  };
}

function makeOpportunity(
  overrides: Partial<YieldOpportunity> = {},
): YieldOpportunity {
  return {
    protocol: 'aave-v3',
    chainId: chainId(42161),
    token: tokenAddress('0x00000000000000000000000000000000000000aa'),
    apy: 8.5,
    tvl: 50_000_000,
    riskScore: 0.2,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('YieldHunter', () => {
  let strategy: YieldHunter;

  beforeEach(() => {
    strategy = new YieldHunter();
  });

  // --- Identity & defaults -----------------------------------------------

  describe('identity and risk defaults', () => {
    it('has correct name', () => {
      expect(strategy.name).toBe('YieldHunter');
    });

    it('has correct timeframe', () => {
      expect(strategy.timeframe).toBe('5m');
    });

    it('has conservative stoploss', () => {
      expect(strategy.stoploss).toBe(-0.05);
    });

    it('has conservative minimalRoi', () => {
      expect(strategy.minimalRoi).toEqual({ 0: 0.02 });
    });

    it('has trailingStop disabled', () => {
      expect(strategy.trailingStop).toBe(false);
    });

    it('has maxPositions of 5', () => {
      expect(strategy.maxPositions).toBe(5);
    });

    it('passes validateConfig with default risk params', () => {
      expect(() => strategy.validateConfig()).not.toThrow();
    });

    it('has default minimumApyImprovement of 2.0', () => {
      expect(strategy.minimumApyImprovement).toBe(2.0);
    });

    it('accepts custom minimumApyImprovement', () => {
      const custom = new YieldHunter({ minimumApyImprovement: 5.0 });
      expect(custom.minimumApyImprovement).toBe(5.0);
    });
  });

  // --- shouldExecute: entry signals --------------------------------------

  describe('shouldExecute — entry signals', () => {
    it('returns entry signal when idle capital and yield opportunity exists', () => {
      strategy.setYieldData([makeOpportunity({ apy: 10 })]);

      const ctx = makeContext({
        balances: new Map([['42161-0x00000000000000000000000000000000000000aa', 5000000n]]),
      });

      const signal = strategy.shouldExecute(ctx);
      expect(signal).not.toBeNull();
      expect(signal!.direction).toBe('long');
      expect(signal!.metadata['type']).toBe('entry');
      expect(signal!.metadata['targetApy']).toBe(10);
      expect(signal!.reason).toContain('Deploy idle capital');
    });

    it('selects the highest-APY opportunity for entry', () => {
      strategy.setYieldData([
        makeOpportunity({ apy: 5, protocol: 'low' }),
        makeOpportunity({ apy: 15, protocol: 'high' }),
        makeOpportunity({ apy: 10, protocol: 'mid' }),
      ]);

      const ctx = makeContext({
        balances: new Map([['42161-0x00000000000000000000000000000000000000aa', 1000000n]]),
      });

      const signal = strategy.shouldExecute(ctx);
      expect(signal).not.toBeNull();
      expect(signal!.metadata['toProtocol']).toBe('high');
      expect(signal!.metadata['targetApy']).toBe(15);
    });

    it('returns null when no opportunities loaded', () => {
      // No setYieldData called
      const ctx = makeContext({
        balances: new Map([['1-0x0000000000000000000000000000000000000001', 1000000n]]),
      });

      const signal = strategy.shouldExecute(ctx);
      expect(signal).toBeNull();
    });

    it('returns null when balances are empty and no positions exist', () => {
      strategy.setYieldData([makeOpportunity({ apy: 10 })]);

      const ctx = makeContext(); // no balances, no positions
      const signal = strategy.shouldExecute(ctx);
      expect(signal).toBeNull();
    });
  });

  // --- shouldExecute: migration signals ----------------------------------

  describe('shouldExecute — migration signals', () => {
    it('returns migration signal when better opportunity exists', () => {
      const currentPosition = makePosition({
        pnlPercent: 0.03, // 3% proxy APY
        chainId: chainId(1),
        tokenAddress: tokenAddress('0x0000000000000000000000000000000000000001'),
      });

      strategy.setYieldData([
        makeOpportunity({
          apy: 12,
          protocol: 'compound-v3',
          chainId: chainId(42161),
        }),
      ]);

      const ctx = makeContext({
        positions: [currentPosition],
      });

      const signal = strategy.shouldExecute(ctx);
      expect(signal).not.toBeNull();
      expect(signal!.metadata['type']).toBe('migration');
      expect(signal!.metadata['toProtocol']).toBe('compound-v3');
      expect(signal!.reason).toContain('Migrate');
    });

    it('returns null when improvement below threshold', () => {
      // Position at 5% proxy APY, best opportunity at 6% → improvement = 1% < 2%
      const currentPosition = makePosition({
        pnlPercent: 0.05, // 5%
        strategyId: 'YieldHunter',
      });

      strategy.setYieldData([makeOpportunity({ apy: 6 })]);

      const ctx = makeContext({
        positions: [currentPosition],
      });

      const signal = strategy.shouldExecute(ctx);
      expect(signal).toBeNull();
    });

    it('returns null when no positions belong to this strategy', () => {
      const otherPosition = makePosition({
        strategyId: 'OtherStrategy',
        pnlPercent: 0.01, // 1%
      });

      strategy.setYieldData([makeOpportunity({ apy: 20 })]);

      const ctx = makeContext({
        positions: [otherPosition],
      });

      // No idle capital either → null
      const signal = strategy.shouldExecute(ctx);
      expect(signal).toBeNull();
    });

    it('uses custom minimumApyImprovement', () => {
      const strict = new YieldHunter({ minimumApyImprovement: 10 });

      const position = makePosition({
        pnlPercent: 0.03, // 3%
        strategyId: 'YieldHunter',
      });

      strict.setYieldData([makeOpportunity({ apy: 10 })]); // improvement = 7 < 10

      const ctx = makeContext({ positions: [position] });
      expect(strict.shouldExecute(ctx)).toBeNull();
    });
  });

  // --- buildExecution ----------------------------------------------------

  describe('buildExecution', () => {
    it('returns ComposerAction for same-chain deposit', () => {
      const signal: StrategySignal = {
        direction: 'long',
        tokenPair: {
          from: {
            address: tokenAddress('0x00000000000000000000000000000000000000aa'),
            symbol: 'USDC',
            decimals: 6,
          },
          to: {
            address: tokenAddress('0x00000000000000000000000000000000000000aa'),
            symbol: 'aave-v3',
            decimals: 18,
          },
        },
        sourceChain: chainId(42161),
        destChain: chainId(42161),
        strength: 0.5,
        reason: 'Deploy idle capital into aave-v3 at 8.5% APY',
        metadata: {
          type: 'entry',
          targetApy: 8.5,
          toProtocol: 'aave-v3',
        },
      };

      const plan = strategy.buildExecution(signal, makeContext());

      expect(plan.strategyName).toBe('YieldHunter');
      expect(plan.actions).toHaveLength(1);
      expect(plan.actions[0]!.type).toBe('composer');
      expect(plan.metadata['isCrossChain']).toBe(false);
      expect(plan.metadata['isMigration']).toBe(false);
    });

    it('returns bridge + composer for cross-chain entry', () => {
      const signal: StrategySignal = {
        direction: 'long',
        tokenPair: {
          from: {
            address: tokenAddress('0x0000000000000000000000000000000000000001'),
            symbol: 'USDC',
            decimals: 6,
          },
          to: {
            address: tokenAddress('0x00000000000000000000000000000000000000aa'),
            symbol: 'aave-v3',
            decimals: 18,
          },
        },
        sourceChain: chainId(1),
        destChain: chainId(42161),
        strength: 0.5,
        reason: 'Deploy across chains',
        metadata: {
          type: 'entry',
          targetApy: 10,
          toProtocol: 'aave-v3',
        },
      };

      const plan = strategy.buildExecution(signal, makeContext());

      expect(plan.actions).toHaveLength(2);
      expect(plan.actions[0]!.type).toBe('bridge');
      expect(plan.actions[1]!.type).toBe('composer');
      expect(plan.metadata['isCrossChain']).toBe(true);
      expect(plan.metadata['isMigration']).toBe(false);
      expect(plan.estimatedCostUsd).toBeGreaterThan(0);
    });

    it('returns withdraw + bridge + deposit for cross-chain migration', () => {
      const signal: StrategySignal = {
        direction: 'long',
        tokenPair: {
          from: {
            address: tokenAddress('0x0000000000000000000000000000000000000001'),
            symbol: 'CURRENT',
            decimals: 18,
          },
          to: {
            address: tokenAddress('0x00000000000000000000000000000000000000aa'),
            symbol: 'aave-v3',
            decimals: 18,
          },
        },
        sourceChain: chainId(1),
        destChain: chainId(42161),
        strength: 0.7,
        reason: 'Migrate for better yield',
        metadata: {
          type: 'migration',
          fromProtocol: 'compound',
          toProtocol: 'aave-v3',
          targetApy: 12,
          currentApy: 3,
          improvement: 9,
          isCrossChain: true,
        },
      };

      const plan = strategy.buildExecution(signal, makeContext());

      expect(plan.actions).toHaveLength(3);
      expect(plan.actions[0]!.type).toBe('composer'); // withdraw
      expect(plan.actions[1]!.type).toBe('bridge');
      expect(plan.actions[2]!.type).toBe('composer'); // deposit
      expect(plan.metadata['isMigration']).toBe(true);
      expect(plan.metadata['isCrossChain']).toBe(true);
    });

    it('returns withdraw + deposit for same-chain migration', () => {
      const signal: StrategySignal = {
        direction: 'long',
        tokenPair: {
          from: {
            address: tokenAddress('0x0000000000000000000000000000000000000001'),
            symbol: 'CURRENT',
            decimals: 18,
          },
          to: {
            address: tokenAddress('0x0000000000000000000000000000000000000002'),
            symbol: 'compound-v3',
            decimals: 18,
          },
        },
        sourceChain: chainId(42161),
        destChain: chainId(42161),
        strength: 0.5,
        reason: 'Migrate same chain',
        metadata: {
          type: 'migration',
          fromProtocol: 'aave-v3',
          toProtocol: 'compound-v3',
          targetApy: 10,
          currentApy: 5,
          improvement: 5,
          isCrossChain: false,
        },
      };

      const plan = strategy.buildExecution(signal, makeContext());

      expect(plan.actions).toHaveLength(2);
      expect(plan.actions[0]!.type).toBe('composer'); // withdraw
      expect(plan.actions[1]!.type).toBe('composer'); // deposit
      expect(plan.metadata['isMigration']).toBe(true);
      expect(plan.metadata['isCrossChain']).toBe(false);
    });
  });

  // --- Filters -----------------------------------------------------------

  describe('filters', () => {
    it('reject disallowed chains', () => {
      const restricted = new YieldHunter({
        allowedChains: [chainId(1)], // only Ethereum
      });

      restricted.setYieldData([
        makeOpportunity({ chainId: chainId(42161) }), // Arbitrum — not allowed
      ]);

      // The allowed-chains filter will pass because filterOpportunities
      // returns empty, causing the min-APY filter to fail
      const ctx = makeContext();
      expect(restricted.evaluateFilters(ctx)).toBe(false);
    });

    it('pass when opportunity chain is allowed', () => {
      const restricted = new YieldHunter({
        allowedChains: [chainId(42161)],
      });

      restricted.setYieldData([
        makeOpportunity({ chainId: chainId(42161), apy: 10 }),
      ]);

      const ctx = makeContext(); // no positions, so min-APY filter passes
      expect(restricted.evaluateFilters(ctx)).toBe(true);
    });

    it('reject disallowed protocols', () => {
      const restricted = new YieldHunter({
        allowedProtocols: ['aave-v3'],
      });

      restricted.setYieldData([
        makeOpportunity({ protocol: 'unknown-defi' }), // not allowed
      ]);

      const ctx = makeContext();
      expect(restricted.evaluateFilters(ctx)).toBe(false);
    });

    it('reject when below minimum APY improvement for existing positions', () => {
      strategy.setYieldData([makeOpportunity({ apy: 3.5 })]); // 3.5%

      const position = makePosition({
        pnlPercent: 0.02, // 2% proxy APY → improvement = 1.5 < 2.0
        strategyId: 'YieldHunter',
      });

      const ctx = makeContext({ positions: [position] });
      expect(strategy.evaluateFilters(ctx)).toBe(false);
    });

    it('pass when APY improvement exceeds threshold for existing positions', () => {
      strategy.setYieldData([makeOpportunity({ apy: 8 })]); // 8%

      const position = makePosition({
        pnlPercent: 0.02, // 2% proxy APY → improvement = 6 >= 2.0
        strategyId: 'YieldHunter',
      });

      // Need fewer positions than maxPositions
      const ctx = makeContext({ positions: [position] });
      expect(strategy.evaluateFilters(ctx)).toBe(true);
    });

    it('reject when max positions reached', () => {
      strategy.setYieldData([makeOpportunity({ apy: 20 })]);

      const positions = Array.from({ length: 5 }, (_, i) =>
        makePosition({
          id: `pos-${i}`,
          strategyId: 'YieldHunter',
          pnlPercent: 0.01, // 1% → improvement 19% easily exceeds threshold
        }),
      );

      const ctx = makeContext({ positions });
      expect(strategy.evaluateFilters(ctx)).toBe(false);
    });
  });

  // --- confirmTradeEntry -------------------------------------------------

  describe('confirmTradeEntry', () => {
    it('returns false when cost exceeds yield benefit', () => {
      const plan = strategy.buildExecution(
        {
          direction: 'long',
          tokenPair: {
            from: {
              address: tokenAddress('0x0000000000000000000000000000000000000001'),
              symbol: 'USDC',
              decimals: 6,
            },
            to: {
              address: tokenAddress('0x0000000000000000000000000000000000000002'),
              symbol: 'protocol',
              decimals: 18,
            },
          },
          sourceChain: chainId(1),
          destChain: chainId(42161),
          strength: 0.3,
          reason: 'Low yield, high cost',
          metadata: {
            type: 'entry',
            targetApy: 0.1, // 0.1% APY — very low
            toProtocol: 'low-yield',
          },
        },
        makeContext(),
      );

      // estimatedCostUsd for bridge+deposit = $6
      // annualizedCostPercent = (6/1000)*100 = 0.6%
      // 0.1% < 0.6% → should reject
      expect(strategy.confirmTradeEntry(plan)).toBe(false);
    });

    it('returns true when net yield is positive', () => {
      const plan = strategy.buildExecution(
        {
          direction: 'long',
          tokenPair: {
            from: {
              address: tokenAddress('0x00000000000000000000000000000000000000aa'),
              symbol: 'USDC',
              decimals: 6,
            },
            to: {
              address: tokenAddress('0x00000000000000000000000000000000000000aa'),
              symbol: 'aave-v3',
              decimals: 18,
            },
          },
          sourceChain: chainId(42161),
          destChain: chainId(42161),
          strength: 0.5,
          reason: 'Good yield',
          metadata: {
            type: 'entry',
            targetApy: 10, // 10% APY
            toProtocol: 'aave-v3',
          },
        },
        makeContext(),
      );

      // estimatedCostUsd for same-chain deposit = $1
      // annualizedCostPercent = (1/1000)*100 = 0.1%
      // 10% > 0.1% → should accept
      expect(strategy.confirmTradeEntry(plan)).toBe(true);
    });

    it('returns false when plan has no targetApy metadata', () => {
      const plan = {
        id: 'plan-no-apy',
        strategyName: 'YieldHunter',
        actions: [],
        estimatedCostUsd: 1,
        estimatedDurationMs: 15000,
        metadata: {},
      };

      expect(strategy.confirmTradeEntry(plan)).toBe(false);
    });
  });

  // --- setYieldData ------------------------------------------------------

  describe('setYieldData', () => {
    it('makes data available for shouldExecute', () => {
      strategy.setYieldData([makeOpportunity({ apy: 10 })]);

      const ctx = makeContext({
        balances: new Map([['42161-0x00000000000000000000000000000000000000aa', 1000n]]),
      });

      expect(strategy.shouldExecute(ctx)).not.toBeNull();
    });

    it('replaces previous data', () => {
      strategy.setYieldData([makeOpportunity({ apy: 10, protocol: 'first' })]);
      strategy.setYieldData([makeOpportunity({ apy: 20, protocol: 'second' })]);

      const ctx = makeContext({
        balances: new Map([['42161-0x00000000000000000000000000000000000000aa', 1000n]]),
      });

      const signal = strategy.shouldExecute(ctx);
      expect(signal).not.toBeNull();
      expect(signal!.metadata['toProtocol']).toBe('second');
    });
  });
});
