import { describe, it, expect, beforeEach } from 'vitest';
import { PearPairTrader } from '../pear-pair-trader.js';
import type { PearPairTraderConfig } from '../pear-pair-trader.js';
import type {
  StrategyContext,
  StrategySignal,
  Position,
} from '../../../core/types.js';
import { chainId, tokenAddress } from '../../../core/types.js';
import { Store } from '../../../core/store.js';
import { CHAINS, USDC_ADDRESSES } from '../../../core/constants.js';
import type { SpreadData } from '../../../connectors/pear-protocol-connector.js';

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
    strategyId: 'PearPairTrader',
    chainId: CHAINS.ARBITRUM,
    tokenAddress: USDC_ADDRESSES[CHAINS.ARBITRUM as number]!,
    entryPrice: 2000,
    currentPrice: 2050,
    amount: 100_000_000n,
    enteredAt: Date.now(),
    pnlUsd: 50,
    pnlPercent: 0.025,
    ...overrides,
  };
}

function makeSpreadData(overrides: Partial<SpreadData> = {}): SpreadData {
  return {
    currentSpread: 0.065,
    historicalMean: 0.065,
    standardDeviation: 0.008,
    zScore: 0.0,
    correlation: 0.85,
    dataPoints: 1000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PearPairTrader', () => {
  beforeEach(() => {
    Store.getInstance().reset();
  });

  // --- Initialization ---

  describe('initialization', () => {
    it('initializes with correct name and timeframe', () => {
      const strategy = new PearPairTrader();
      expect(strategy.name).toBe('PearPairTrader');
      expect(strategy.timeframe).toBe('1m');
    });

    it('uses growth tier risk parameters', () => {
      const strategy = new PearPairTrader();
      expect(strategy.stoploss).toBe(-0.08);
      expect(strategy.maxPositions).toBe(3);
    });

    it('uses default config when no options provided', () => {
      const strategy = new PearPairTrader();
      expect(strategy.config.pairs).toEqual(['ETH-BTC', 'SOL-ETH', 'ARB-OP']);
      expect(strategy.config.zScoreEntryThreshold).toBe(2.0);
      expect(strategy.config.zScoreExitThreshold).toBe(0.5);
      expect(strategy.config.minCorrelation).toBe(0.6);
      expect(strategy.config.minDataPoints).toBe(100);
    });

    it('accepts custom config values', () => {
      const strategy = new PearPairTrader({
        pairs: ['ETH-BTC'],
        zScoreEntryThreshold: 2.5,
        zScoreExitThreshold: 0.3,
        minCorrelation: 0.7,
        minDataPoints: 200,
        defaultLeverage: 4,
        maxLeverage: 8,
        minLeverage: 2,
        positionSizeUsdc: 200_000_000n,
      });

      expect(strategy.config.pairs).toEqual(['ETH-BTC']);
      expect(strategy.config.zScoreEntryThreshold).toBe(2.5);
      expect(strategy.config.zScoreExitThreshold).toBe(0.3);
      expect(strategy.config.minCorrelation).toBe(0.7);
      expect(strategy.config.minDataPoints).toBe(200);
      expect(strategy.config.defaultLeverage).toBe(4);
      expect(strategy.config.maxLeverage).toBe(8);
      expect(strategy.config.minLeverage).toBe(2);
      expect(strategy.config.positionSizeUsdc).toBe(200_000_000n);
    });

    it('passes validateConfig with default risk params', () => {
      const strategy = new PearPairTrader();
      expect(() => strategy.validateConfig()).not.toThrow();
    });
  });

  // --- shouldExecute: Spread Divergence ---

  describe('shouldExecute — spread divergence signals', () => {
    it('generates signal when z-score exceeds entry threshold (positive z)', () => {
      const strategy = new PearPairTrader({
        zScoreEntryThreshold: 2.0,
      });

      // z-score > 2.0 -> A outperformed B -> short A, long B
      strategy.setSpreadData('ETH-BTC', makeSpreadData({
        zScore: 2.5,
        correlation: 0.85,
        dataPoints: 500,
      }));

      const signal = strategy.shouldExecute(makeContext());

      expect(signal).not.toBeNull();
      expect(signal!.metadata['pairId']).toBe('ETH-BTC');
      expect(signal!.metadata['longSymbol']).toBe('BTC');  // underperformer
      expect(signal!.metadata['shortSymbol']).toBe('ETH'); // outperformer
      expect(signal!.reason).toContain('pair_trade');
      expect(signal!.reason).toContain('long BTC');
      expect(signal!.reason).toContain('short ETH');
    });

    it('generates signal when z-score exceeds entry threshold (negative z)', () => {
      const strategy = new PearPairTrader({
        zScoreEntryThreshold: 2.0,
      });

      // z-score < -2.0 -> B outperformed A -> short B, long A
      strategy.setSpreadData('ETH-BTC', makeSpreadData({
        zScore: -2.5,
        correlation: 0.85,
        dataPoints: 500,
      }));

      const signal = strategy.shouldExecute(makeContext());

      expect(signal).not.toBeNull();
      expect(signal!.metadata['longSymbol']).toBe('ETH');  // underperformer
      expect(signal!.metadata['shortSymbol']).toBe('BTC'); // outperformer
    });

    it('returns null when z-score below entry threshold', () => {
      const strategy = new PearPairTrader({
        zScoreEntryThreshold: 2.0,
      });

      strategy.setSpreadData('ETH-BTC', makeSpreadData({
        zScore: 1.5, // below 2.0
        correlation: 0.85,
        dataPoints: 500,
      }));

      const signal = strategy.shouldExecute(makeContext());
      expect(signal).toBeNull();
    });

    it('returns null when no spread data is set', () => {
      const strategy = new PearPairTrader();
      const signal = strategy.shouldExecute(makeContext());
      expect(signal).toBeNull();
    });

    it('picks pair with highest absolute z-score among multiple pairs', () => {
      const strategy = new PearPairTrader();

      strategy.setSpreadData('ETH-BTC', makeSpreadData({
        zScore: 2.1,
        correlation: 0.85,
        dataPoints: 500,
      }));

      strategy.setSpreadData('SOL-ETH', makeSpreadData({
        zScore: -3.0, // higher abs z-score
        correlation: 0.75,
        dataPoints: 500,
      }));

      const signal = strategy.shouldExecute(makeContext());
      expect(signal).not.toBeNull();
      expect(signal!.metadata['pairId']).toBe('SOL-ETH');
    });
  });

  // --- shouldExecute: Data Quality Filters ---

  describe('shouldExecute — data quality filters', () => {
    it('returns null when correlation below minimum', () => {
      const strategy = new PearPairTrader({
        minCorrelation: 0.6,
      });

      strategy.setSpreadData('ETH-BTC', makeSpreadData({
        zScore: 3.0,
        correlation: 0.4, // below 0.6
        dataPoints: 500,
      }));

      const signal = strategy.shouldExecute(makeContext());
      expect(signal).toBeNull();
    });

    it('returns null when insufficient data points', () => {
      const strategy = new PearPairTrader({
        minDataPoints: 100,
      });

      strategy.setSpreadData('ETH-BTC', makeSpreadData({
        zScore: 3.0,
        correlation: 0.85,
        dataPoints: 50, // below 100
      }));

      const signal = strategy.shouldExecute(makeContext());
      expect(signal).toBeNull();
    });

    it('returns null when standard deviation is zero', () => {
      const strategy = new PearPairTrader();

      strategy.setSpreadData('ETH-BTC', makeSpreadData({
        zScore: 3.0,
        correlation: 0.85,
        dataPoints: 500,
        standardDeviation: 0, // zero stddev
      }));

      const signal = strategy.shouldExecute(makeContext());
      expect(signal).toBeNull();
    });
  });

  // --- Max Positions Gate ---

  describe('max positions gate', () => {
    it('returns null when max positions reached', () => {
      const strategy = new PearPairTrader(); // maxPositions = 3

      strategy.setSpreadData('ETH-BTC', makeSpreadData({
        zScore: 3.0,
        correlation: 0.85,
        dataPoints: 500,
      }));

      const positions = Array.from({ length: 3 }, (_, i) =>
        makePosition({ id: `pos-${i}` }),
      );

      const signal = strategy.shouldExecute(makeContext({ positions }));
      expect(signal).toBeNull();
    });

    it('generates signal when below max positions', () => {
      const strategy = new PearPairTrader(); // maxPositions = 3

      strategy.setSpreadData('ETH-BTC', makeSpreadData({
        zScore: 2.5,
        correlation: 0.85,
        dataPoints: 500,
      }));

      const positions = [makePosition({ id: 'pos-0' })]; // only 1

      const signal = strategy.shouldExecute(makeContext({ positions }));
      expect(signal).not.toBeNull();
    });
  });

  // --- buildExecution ---

  describe('buildExecution', () => {
    it('creates PairAction with equal notional legs', () => {
      const strategy = new PearPairTrader();

      const usdcAddress = USDC_ADDRESSES[CHAINS.ARBITRUM as number]!;
      const signal: StrategySignal = {
        direction: 'long',
        tokenPair: {
          from: { address: usdcAddress, symbol: 'USDC', decimals: 6 },
          to: { address: usdcAddress, symbol: 'USDC', decimals: 6 },
        },
        sourceChain: CHAINS.ARBITRUM,
        destChain: CHAINS.ARBITRUM,
        strength: 0.5,
        reason: 'pair_trade: long BTC / short ETH',
        metadata: {
          pairId: 'ETH-BTC',
          longSymbol: 'BTC',
          shortSymbol: 'ETH',
          zScore: 2.5,
          correlation: 0.85,
          currentSpread: 0.073,
          historicalMean: 0.065,
          standardDeviation: 0.008,
        },
      };

      const plan = strategy.buildExecution(signal, makeContext());
      const pairAction = plan.actions[0]!;

      expect(pairAction.type).toBe('pair');
      expect((pairAction as { longSymbol: string }).longSymbol).toBe('BTC');
      expect((pairAction as { shortSymbol: string }).shortSymbol).toBe('ETH');
      expect((pairAction as { pairId: string }).pairId).toBe('ETH-BTC');
      // Equal notional
      expect((pairAction as { longSize: bigint }).longSize).toBe(
        (pairAction as { shortSize: bigint }).shortSize,
      );
    });

    it('includes bridge when capital not on Arbitrum', () => {
      const strategy = new PearPairTrader();

      const usdcAddress = USDC_ADDRESSES[CHAINS.ARBITRUM as number]!;
      const signal: StrategySignal = {
        direction: 'long',
        tokenPair: {
          from: { address: usdcAddress, symbol: 'USDC', decimals: 6 },
          to: { address: usdcAddress, symbol: 'USDC', decimals: 6 },
        },
        sourceChain: CHAINS.ETHEREUM, // NOT Arbitrum
        destChain: CHAINS.ARBITRUM,
        strength: 0.5,
        reason: 'pair_trade: long BTC / short ETH',
        metadata: {
          pairId: 'ETH-BTC',
          longSymbol: 'BTC',
          shortSymbol: 'ETH',
          zScore: 2.5,
          correlation: 0.85,
          currentSpread: 0.073,
        },
      };

      const plan = strategy.buildExecution(signal, makeContext());

      expect(plan.actions.length).toBeGreaterThanOrEqual(2);
      expect(plan.actions[0]!.type).toBe('bridge');
      expect(plan.actions[1]!.type).toBe('pair');
      expect(plan.metadata['needsBridge']).toBe(true);
      expect(plan.estimatedCostUsd).toBeGreaterThan(5);
    });

    it('skips bridge when capital on Arbitrum', () => {
      const strategy = new PearPairTrader();

      const usdcAddress = USDC_ADDRESSES[CHAINS.ARBITRUM as number]!;
      const signal: StrategySignal = {
        direction: 'long',
        tokenPair: {
          from: { address: usdcAddress, symbol: 'USDC', decimals: 6 },
          to: { address: usdcAddress, symbol: 'USDC', decimals: 6 },
        },
        sourceChain: CHAINS.ARBITRUM,
        destChain: CHAINS.ARBITRUM,
        strength: 0.5,
        reason: 'pair_trade: long BTC / short ETH',
        metadata: {
          pairId: 'ETH-BTC',
          longSymbol: 'BTC',
          shortSymbol: 'ETH',
          zScore: 2.5,
          correlation: 0.85,
          currentSpread: 0.073,
        },
      };

      const plan = strategy.buildExecution(signal, makeContext());

      expect(plan.actions).toHaveLength(1);
      expect(plan.actions[0]!.type).toBe('pair');
      expect(plan.metadata['needsBridge']).toBe(false);
    });

    it('includes Triple Barrier params in metadata', () => {
      const strategy = new PearPairTrader();

      const usdcAddress = USDC_ADDRESSES[CHAINS.ARBITRUM as number]!;
      const signal: StrategySignal = {
        direction: 'long',
        tokenPair: {
          from: { address: usdcAddress, symbol: 'USDC', decimals: 6 },
          to: { address: usdcAddress, symbol: 'USDC', decimals: 6 },
        },
        sourceChain: CHAINS.ARBITRUM,
        destChain: CHAINS.ARBITRUM,
        strength: 0.5,
        reason: 'pair_trade',
        metadata: {
          pairId: 'ETH-BTC',
          longSymbol: 'BTC',
          shortSymbol: 'ETH',
          zScore: 2.5,
          correlation: 0.85,
          currentSpread: 0.073,
        },
      };

      const plan = strategy.buildExecution(signal, makeContext());
      const pairAction = plan.actions[0]!;

      expect(pairAction.metadata['stoploss']).toBe(-0.08);
      expect(pairAction.metadata['takeProfit']).toBeDefined();
      expect(pairAction.metadata['timeLimitMs']).toBeDefined();
    });

    it('computes leverage within tier bounds', () => {
      const strategy = new PearPairTrader(); // minLeverage=2, maxLeverage=5

      const usdcAddress = USDC_ADDRESSES[CHAINS.ARBITRUM as number]!;

      // Low strength -> min leverage
      const lowSignal: StrategySignal = {
        direction: 'long',
        tokenPair: {
          from: { address: usdcAddress, symbol: 'USDC', decimals: 6 },
          to: { address: usdcAddress, symbol: 'USDC', decimals: 6 },
        },
        sourceChain: CHAINS.ARBITRUM,
        destChain: CHAINS.ARBITRUM,
        strength: 0.0,
        reason: 'pair_trade',
        metadata: { pairId: 'ETH-BTC', longSymbol: 'BTC', shortSymbol: 'ETH', zScore: 2.0, correlation: 0.85, currentSpread: 0.073 },
      };

      const lowPlan = strategy.buildExecution(lowSignal, makeContext());
      const lowLev = (lowPlan.actions[0]! as { leverage: number }).leverage;
      expect(lowLev).toBe(2);

      // High strength -> max leverage
      const highSignal: StrategySignal = {
        ...lowSignal,
        strength: 1.0,
      };

      const highPlan = strategy.buildExecution(highSignal, makeContext());
      const highLev = (highPlan.actions[0]! as { leverage: number }).leverage;
      expect(highLev).toBe(5);
    });
  });

  // --- Filters ---

  describe('filters', () => {
    it('rejects when no spread data', () => {
      const strategy = new PearPairTrader();
      const result = strategy.evaluateFilters(makeContext());
      expect(result).toBe(false);
    });

    it('passes when spread data is set and positions below limit', () => {
      const strategy = new PearPairTrader();
      strategy.setSpreadData('ETH-BTC', makeSpreadData({ zScore: 2.5 }));
      const result = strategy.evaluateFilters(makeContext());
      expect(result).toBe(true);
    });

    it('rejects when max positions reached in filter', () => {
      const strategy = new PearPairTrader(); // maxPositions = 3
      strategy.setSpreadData('ETH-BTC', makeSpreadData({ zScore: 2.5 }));

      const positions = Array.from({ length: 3 }, (_, i) =>
        makePosition({ id: `pos-${i}` }),
      );

      const result = strategy.evaluateFilters(makeContext({ positions }));
      expect(result).toBe(false);
    });
  });

  // --- confirmTradeEntry ---

  describe('confirmTradeEntry', () => {
    it('returns true when pairId metadata is present', () => {
      const strategy = new PearPairTrader();
      const plan = {
        id: 'plan-1',
        strategyName: 'PearPairTrader',
        actions: [],
        estimatedCostUsd: 4,
        estimatedDurationMs: 5000,
        metadata: { pairId: 'ETH-BTC' },
      };
      expect(strategy.confirmTradeEntry(plan)).toBe(true);
    });

    it('returns false when pairId metadata is absent', () => {
      const strategy = new PearPairTrader();
      const plan = {
        id: 'plan-1',
        strategyName: 'PearPairTrader',
        actions: [],
        estimatedCostUsd: 4,
        estimatedDurationMs: 5000,
        metadata: {},
      };
      expect(strategy.confirmTradeEntry(plan)).toBe(false);
    });
  });

  // --- setSpreadData / clearSpreadData ---

  describe('spread data injection', () => {
    it('makes data available for shouldExecute', () => {
      const strategy = new PearPairTrader();

      strategy.setSpreadData('ETH-BTC', makeSpreadData({
        zScore: 2.5,
        correlation: 0.85,
        dataPoints: 500,
      }));

      const signal = strategy.shouldExecute(makeContext());
      expect(signal).not.toBeNull();
    });

    it('replaces data for a specific pair', () => {
      const strategy = new PearPairTrader();

      // First: z-score above threshold
      strategy.setSpreadData('ETH-BTC', makeSpreadData({
        zScore: 2.5,
        correlation: 0.85,
        dataPoints: 500,
      }));

      // Replace with z-score below threshold
      strategy.setSpreadData('ETH-BTC', makeSpreadData({
        zScore: 0.5, // below threshold
        correlation: 0.85,
        dataPoints: 500,
      }));

      // Only SOL-ETH should remain viable if added
      const signal = strategy.shouldExecute(makeContext());
      expect(signal).toBeNull();
    });

    it('clearSpreadData removes all spread data', () => {
      const strategy = new PearPairTrader();

      strategy.setSpreadData('ETH-BTC', makeSpreadData({
        zScore: 2.5,
        correlation: 0.85,
        dataPoints: 500,
      }));

      strategy.clearSpreadData();

      const signal = strategy.shouldExecute(makeContext());
      expect(signal).toBeNull();
    });
  });

  // --- Signal strength ---

  describe('signal strength', () => {
    it('normalizes strength based on z-score magnitude', () => {
      const strategy = new PearPairTrader({
        zScoreEntryThreshold: 2.0,
      });

      // z=2.0 -> strength = 2.0 / (2.0*2) = 0.5
      strategy.setSpreadData('ETH-BTC', makeSpreadData({
        zScore: 2.0,
        correlation: 0.85,
        dataPoints: 500,
      }));

      const signal = strategy.shouldExecute(makeContext());
      expect(signal).not.toBeNull();
      expect(signal!.strength).toBeCloseTo(0.5, 2);
    });

    it('caps strength at 1.0 for extreme z-scores', () => {
      const strategy = new PearPairTrader({
        zScoreEntryThreshold: 2.0,
      });

      // z=5.0 -> strength = 5.0 / (2.0*2) = 1.25 -> capped at 1.0
      strategy.setSpreadData('ETH-BTC', makeSpreadData({
        zScore: 5.0,
        correlation: 0.85,
        dataPoints: 500,
      }));

      const signal = strategy.shouldExecute(makeContext());
      expect(signal).not.toBeNull();
      expect(signal!.strength).toBe(1.0);
    });
  });
});
