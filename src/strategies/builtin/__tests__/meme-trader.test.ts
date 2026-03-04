import { describe, it, expect, beforeEach } from 'vitest';
import { MemeTrader } from '../meme-trader.js';
import type {
  MemeSignalData,
  DetectedSignal,
  MemeTraderConfig,
  MemeSignalType,
} from '../meme-trader.js';
import type {
  StrategyContext,
  StrategySignal,
  Position,
  ChainId,
} from '../../../core/types.js';
import { chainId, tokenAddress } from '../../../core/types.js';
import { Store } from '../../../core/store.js';
import { CHAINS, USDC_ADDRESSES } from '../../../core/constants.js';

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
    strategyId: 'MemeTrader',
    chainId: CHAINS.BASE,
    tokenAddress: tokenAddress('0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'),
    entryPrice: 0.001,
    currentPrice: 0.0012,
    amount: 1_000_000_000_000_000_000n, // 1 token (18 decimals)
    enteredAt: Date.now(),
    pnlUsd: 0.2,
    pnlPercent: 0.2,
    ...overrides,
  };
}

const MEME_TOKEN_ADDRESS = tokenAddress('0xabcdefabcdefabcdefabcdefabcdefabcdefabcd');
const MEME_TOKEN_SYMBOL = 'PEPE';
const MEME_CHAIN = CHAINS.BASE;

function makeSignal(overrides: Partial<DetectedSignal> = {}): DetectedSignal {
  return {
    type: 'volume_spike',
    tokenAddress: MEME_TOKEN_ADDRESS,
    tokenSymbol: MEME_TOKEN_SYMBOL,
    chainId: MEME_CHAIN,
    magnitude: 1.0,
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeSignalData(signals: DetectedSignal[]): MemeSignalData {
  return { signals };
}

/**
 * Create a full set of signals for a single token, with all 5 types at magnitude 1.0.
 * This yields a score of 100 with default weights (20+25+15+20+20).
 */
function makeFullSignalSet(
  addr: typeof MEME_TOKEN_ADDRESS = MEME_TOKEN_ADDRESS,
  symbol: string = MEME_TOKEN_SYMBOL,
  chain: ChainId = MEME_CHAIN,
): DetectedSignal[] {
  const now = Date.now();
  return [
    { type: 'volume_spike', tokenAddress: addr, tokenSymbol: symbol, chainId: chain, magnitude: 1.0, timestamp: now },
    { type: 'whale_buy', tokenAddress: addr, tokenSymbol: symbol, chainId: chain, magnitude: 1.0, timestamp: now },
    { type: 'new_liquidity', tokenAddress: addr, tokenSymbol: symbol, chainId: chain, magnitude: 1.0, timestamp: now },
    { type: 'social_mention', tokenAddress: addr, tokenSymbol: symbol, chainId: chain, magnitude: 1.0, timestamp: now },
    { type: 'token_age_24h', tokenAddress: addr, tokenSymbol: symbol, chainId: chain, magnitude: 1.0, timestamp: now },
  ];
}

/**
 * Seed the store with USDC balance on a given chain.
 */
function seedBalance(chain: ChainId, amountUsdc: number): void {
  const store = Store.getInstance();
  const usdcAddr = USDC_ADDRESSES[chain as number];
  if (usdcAddr) {
    store.setBalance(chain, usdcAddr, BigInt(Math.floor(amountUsdc * 1e6)), amountUsdc, 'USDC', 6);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MemeTrader', () => {
  beforeEach(() => {
    Store.getInstance().reset();
  });

  // --- Initialization ---

  describe('initialization', () => {
    it('has correct identity', () => {
      const strategy = new MemeTrader();
      expect(strategy.name).toBe('MemeTrader');
      expect(strategy.timeframe).toBe('30s');
    });

    it('has degen-tier risk params', () => {
      const strategy = new MemeTrader();
      expect(strategy.stoploss).toBe(-0.15);
      expect(strategy.trailingStop).toBe(true);
      expect(strategy.trailingStopPositive).toBe(0.15);
      expect(strategy.maxPositions).toBe(5);
    });

    it('uses default config values', () => {
      const strategy = new MemeTrader();
      expect(strategy.config.entryThreshold).toBe(60);
      expect(strategy.config.maxPositionPercent).toBe(0.02);
      expect(strategy.config.trailPercent).toBe(0.15);
      expect(strategy.config.timeLimitMs).toBe(4 * 60 * 60 * 1000);
      expect(strategy.config.cooldownMs).toBe(1 * 60 * 60 * 1000);
      expect(strategy.config.slippageTolerance).toBe(0.02);
    });

    it('accepts custom config overrides', () => {
      const strategy = new MemeTrader({
        entryThreshold: 80,
        maxPositionPercent: 0.05,
        trailPercent: 0.20,
        timeLimitMs: 2 * 60 * 60 * 1000,
        cooldownMs: 30 * 60 * 1000,
        slippageTolerance: 0.03,
      });

      expect(strategy.config.entryThreshold).toBe(80);
      expect(strategy.config.maxPositionPercent).toBe(0.05);
      expect(strategy.config.trailPercent).toBe(0.20);
      expect(strategy.config.timeLimitMs).toBe(2 * 60 * 60 * 1000);
      expect(strategy.config.cooldownMs).toBe(30 * 60 * 1000);
      expect(strategy.config.slippageTolerance).toBe(0.03);
    });

    it('passes validateConfig', () => {
      const strategy = new MemeTrader();
      expect(() => strategy.validateConfig()).not.toThrow();
    });
  });

  // --- Signal Detection ---

  describe('signal detection', () => {
    it('detects volume_spike signal', () => {
      const strategy = new MemeTrader({ entryThreshold: 15 });
      const signals = [makeSignal({ type: 'volume_spike', magnitude: 1.0 })];
      strategy.setSignalData(makeSignalData(signals));

      const signal = strategy.shouldExecute(makeContext());
      expect(signal).not.toBeNull();
      expect(signal!.reason).toContain('volume_spike');
    });

    it('detects whale_buy signal', () => {
      const strategy = new MemeTrader({ entryThreshold: 20 });
      const signals = [makeSignal({ type: 'whale_buy', magnitude: 1.0 })];
      strategy.setSignalData(makeSignalData(signals));

      const signal = strategy.shouldExecute(makeContext());
      expect(signal).not.toBeNull();
      expect(signal!.reason).toContain('whale_buy');
    });

    it('detects new_liquidity signal', () => {
      const strategy = new MemeTrader({ entryThreshold: 10 });
      const signals = [makeSignal({ type: 'new_liquidity', magnitude: 1.0 })];
      strategy.setSignalData(makeSignalData(signals));

      const signal = strategy.shouldExecute(makeContext());
      expect(signal).not.toBeNull();
      expect(signal!.reason).toContain('new_liquidity');
    });

    it('detects social_mention signal', () => {
      const strategy = new MemeTrader({ entryThreshold: 15 });
      const signals = [makeSignal({ type: 'social_mention', magnitude: 1.0 })];
      strategy.setSignalData(makeSignalData(signals));

      const signal = strategy.shouldExecute(makeContext());
      expect(signal).not.toBeNull();
      expect(signal!.reason).toContain('social_mention');
    });

    it('detects token_age_24h signal', () => {
      const strategy = new MemeTrader({ entryThreshold: 15 });
      const signals = [makeSignal({ type: 'token_age_24h', magnitude: 1.0 })];
      strategy.setSignalData(makeSignalData(signals));

      const signal = strategy.shouldExecute(makeContext());
      expect(signal).not.toBeNull();
      expect(signal!.reason).toContain('token_age_24h');
    });

    it('returns null when no signal data is set', () => {
      const strategy = new MemeTrader();
      const signal = strategy.shouldExecute(makeContext());
      expect(signal).toBeNull();
    });

    it('returns null when signals array is empty', () => {
      const strategy = new MemeTrader();
      strategy.setSignalData(makeSignalData([]));
      const signal = strategy.shouldExecute(makeContext());
      expect(signal).toBeNull();
    });

    it('replaces previous signal data on subsequent setSignalData calls', () => {
      const strategy = new MemeTrader({ entryThreshold: 15 });

      // First: volume_spike for PEPE
      strategy.setSignalData(makeSignalData([
        makeSignal({ type: 'volume_spike', tokenSymbol: 'PEPE', magnitude: 1.0 }),
      ]));

      const second_token = tokenAddress('0x1111111111111111111111111111111111111111');

      // Replace with DOGE signal
      strategy.setSignalData(makeSignalData([
        makeSignal({
          type: 'whale_buy',
          tokenAddress: second_token,
          tokenSymbol: 'DOGE',
          magnitude: 1.0,
        }),
      ]));

      const signal = strategy.shouldExecute(makeContext());
      expect(signal).not.toBeNull();
      expect(signal!.tokenPair.to.symbol).toBe('DOGE');
    });
  });

  // --- Scoring ---

  describe('composite score calculation', () => {
    it('calculates correct score with single signal type', () => {
      const strategy = new MemeTrader({ entryThreshold: 0 });

      // volume_spike weight = 20, magnitude 1.0 -> score = 20
      const signals = [makeSignal({ type: 'volume_spike', magnitude: 1.0 })];
      strategy.setSignalData(makeSignalData(signals));

      const signal = strategy.shouldExecute(makeContext());
      expect(signal).not.toBeNull();
      expect(signal!.metadata['totalScore']).toBe(20);
    });

    it('calculates correct score with all signal types at max magnitude', () => {
      const strategy = new MemeTrader({ entryThreshold: 0 });

      // All 5 types at magnitude 1.0 -> 20 + 25 + 15 + 20 + 20 = 100
      const signals = makeFullSignalSet();
      strategy.setSignalData(makeSignalData(signals));

      const signal = strategy.shouldExecute(makeContext());
      expect(signal).not.toBeNull();
      expect(signal!.metadata['totalScore']).toBe(100);
    });

    it('clamps magnitude to [0, 1] range', () => {
      const strategy = new MemeTrader({ entryThreshold: 0 });

      // magnitude 5.0 should be clamped to 1.0 -> score = 20 (not 100)
      const signals = [makeSignal({ type: 'volume_spike', magnitude: 5.0 })];
      strategy.setSignalData(makeSignalData(signals));

      const signal = strategy.shouldExecute(makeContext());
      expect(signal).not.toBeNull();
      expect(signal!.metadata['totalScore']).toBe(20);
    });

    it('uses max magnitude when multiple signals of same type', () => {
      const strategy = new MemeTrader({ entryThreshold: 0 });

      // Two volume_spike signals, magnitudes 0.3 and 0.7 -> takes 0.7
      // Score = 20 * 0.7 = 14
      const signals = [
        makeSignal({ type: 'volume_spike', magnitude: 0.3 }),
        makeSignal({ type: 'volume_spike', magnitude: 0.7 }),
      ];
      strategy.setSignalData(makeSignalData(signals));

      const signal = strategy.shouldExecute(makeContext());
      expect(signal).not.toBeNull();
      expect(signal!.metadata['totalScore']).toBe(14);
    });

    it('scales score with fractional magnitude', () => {
      const strategy = new MemeTrader({ entryThreshold: 0 });

      // volume_spike at magnitude 0.5 -> 20 * 0.5 = 10
      // whale_buy at magnitude 0.5 -> 25 * 0.5 = 12.5
      // Total = 22.5
      const signals = [
        makeSignal({ type: 'volume_spike', magnitude: 0.5 }),
        makeSignal({ type: 'whale_buy', magnitude: 0.5 }),
      ];
      strategy.setSignalData(makeSignalData(signals));

      const signal = strategy.shouldExecute(makeContext());
      expect(signal).not.toBeNull();
      expect(signal!.metadata['totalScore']).toBe(22.5);
    });

    it('returns null when score is below threshold', () => {
      const strategy = new MemeTrader({ entryThreshold: 60 });

      // Only volume_spike at 1.0 -> score = 20 < 60
      const signals = [makeSignal({ type: 'volume_spike', magnitude: 1.0 })];
      strategy.setSignalData(makeSignalData(signals));

      const signal = strategy.shouldExecute(makeContext());
      expect(signal).toBeNull();
    });

    it('returns signal when score equals threshold', () => {
      // threshold = 60, need exactly 60
      // volume_spike(20) + whale_buy(25) + new_liquidity(15) = 60
      const strategy = new MemeTrader({ entryThreshold: 60 });

      const signals = [
        makeSignal({ type: 'volume_spike', magnitude: 1.0 }),
        makeSignal({ type: 'whale_buy', magnitude: 1.0 }),
        makeSignal({ type: 'new_liquidity', magnitude: 1.0 }),
      ];
      strategy.setSignalData(makeSignalData(signals));

      const signal = strategy.shouldExecute(makeContext());
      expect(signal).not.toBeNull();
      expect(signal!.metadata['totalScore']).toBe(60);
    });

    it('returns signal when score is above threshold', () => {
      const strategy = new MemeTrader({ entryThreshold: 60 });

      // All 5 types -> score = 100 > 60
      const signals = makeFullSignalSet();
      strategy.setSignalData(makeSignalData(signals));

      const signal = strategy.shouldExecute(makeContext());
      expect(signal).not.toBeNull();
      expect(signal!.metadata['totalScore']).toBe(100);
    });

    it('picks highest scoring token among multiple', () => {
      const strategy = new MemeTrader({ entryThreshold: 0 });

      const tokenA = tokenAddress('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
      const tokenB = tokenAddress('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');

      const signals = [
        // Token A: volume_spike only -> score 20
        { type: 'volume_spike' as MemeSignalType, tokenAddress: tokenA, tokenSymbol: 'AAA', chainId: MEME_CHAIN, magnitude: 1.0, timestamp: Date.now() },
        // Token B: volume_spike + whale_buy -> score 45
        { type: 'volume_spike' as MemeSignalType, tokenAddress: tokenB, tokenSymbol: 'BBB', chainId: MEME_CHAIN, magnitude: 1.0, timestamp: Date.now() },
        { type: 'whale_buy' as MemeSignalType, tokenAddress: tokenB, tokenSymbol: 'BBB', chainId: MEME_CHAIN, magnitude: 1.0, timestamp: Date.now() },
      ];

      strategy.setSignalData(makeSignalData(signals));

      const signal = strategy.shouldExecute(makeContext());
      expect(signal).not.toBeNull();
      expect(signal!.tokenPair.to.symbol).toBe('BBB');
      expect(signal!.metadata['totalScore']).toBe(45);
    });

    it('uses custom signal weights when provided', () => {
      const customWeights: Record<MemeSignalType, number> = {
        volume_spike: 50,
        whale_buy: 10,
        new_liquidity: 10,
        social_mention: 10,
        token_age_24h: 20,
      };

      const strategy = new MemeTrader({
        entryThreshold: 0,
        signalWeights: customWeights,
      });

      // volume_spike at 1.0 with weight 50 -> score = 50
      const signals = [makeSignal({ type: 'volume_spike', magnitude: 1.0 })];
      strategy.setSignalData(makeSignalData(signals));

      const signal = strategy.shouldExecute(makeContext());
      expect(signal).not.toBeNull();
      expect(signal!.metadata['totalScore']).toBe(50);
    });
  });

  // --- Signal strength ---

  describe('signal strength', () => {
    it('normalizes score to 0-1 range', () => {
      const strategy = new MemeTrader({ entryThreshold: 0 });

      // Score = 45 -> strength = 0.45
      const signals = [
        makeSignal({ type: 'volume_spike', magnitude: 1.0 }), // 20
        makeSignal({ type: 'whale_buy', magnitude: 1.0 }), // 25
      ];
      strategy.setSignalData(makeSignalData(signals));

      const signal = strategy.shouldExecute(makeContext());
      expect(signal).not.toBeNull();
      expect(signal!.strength).toBe(0.45);
    });

    it('caps strength at 1.0', () => {
      const strategy = new MemeTrader({ entryThreshold: 0 });

      // All signals at max -> score = 100 -> strength = 1.0
      const signals = makeFullSignalSet();
      strategy.setSignalData(makeSignalData(signals));

      const signal = strategy.shouldExecute(makeContext());
      expect(signal).not.toBeNull();
      expect(signal!.strength).toBe(1.0);
    });

    it('always generates long direction', () => {
      const strategy = new MemeTrader({ entryThreshold: 0 });

      const signals = [makeSignal({ type: 'volume_spike', magnitude: 1.0 })];
      strategy.setSignalData(makeSignalData(signals));

      const signal = strategy.shouldExecute(makeContext());
      expect(signal).not.toBeNull();
      expect(signal!.direction).toBe('long');
    });
  });

  // --- buildExecution ---

  describe('buildExecution', () => {
    it('creates swap action for same-chain entry', () => {
      const strategy = new MemeTrader();
      seedBalance(MEME_CHAIN, 1000);

      const signal: StrategySignal = {
        direction: 'long',
        tokenPair: {
          from: { address: USDC_ADDRESSES[MEME_CHAIN as number]!, symbol: 'USDC', decimals: 6 },
          to: { address: MEME_TOKEN_ADDRESS, symbol: MEME_TOKEN_SYMBOL, decimals: 18 },
        },
        sourceChain: MEME_CHAIN,
        destChain: MEME_CHAIN,
        strength: 0.8,
        reason: 'meme_entry: buy PEPE',
        metadata: { totalScore: 80, signalTypes: 'volume_spike, whale_buy' },
      };

      const plan = strategy.buildExecution(signal, makeContext());

      expect(plan.strategyName).toBe('MemeTrader');
      expect(plan.actions).toHaveLength(1);
      expect(plan.actions[0]!.type).toBe('swap');
      expect(plan.metadata['needsBridge']).toBe(false);

      const swapAction = plan.actions[0]! as { slippage: number; toToken: string };
      expect(swapAction.slippage).toBe(0.02);
      expect(swapAction.toToken).toBe(MEME_TOKEN_ADDRESS as string);
    });

    it('prepends bridge action when capital on different chain', () => {
      const strategy = new MemeTrader();
      seedBalance(CHAINS.ETHEREUM, 5000);

      const signal: StrategySignal = {
        direction: 'long',
        tokenPair: {
          from: { address: USDC_ADDRESSES[CHAINS.ETHEREUM as number]!, symbol: 'USDC', decimals: 6 },
          to: { address: MEME_TOKEN_ADDRESS, symbol: MEME_TOKEN_SYMBOL, decimals: 18 },
        },
        sourceChain: CHAINS.ETHEREUM,
        destChain: MEME_CHAIN,
        strength: 0.8,
        reason: 'meme_entry: buy PEPE',
        metadata: { totalScore: 80, signalTypes: 'volume_spike, whale_buy' },
      };

      const plan = strategy.buildExecution(signal, makeContext());

      expect(plan.actions.length).toBeGreaterThanOrEqual(2);
      expect(plan.actions[0]!.type).toBe('bridge');
      expect(plan.actions[1]!.type).toBe('swap');
      expect(plan.metadata['needsBridge']).toBe(true);
      expect(plan.estimatedCostUsd).toBeGreaterThan(5); // bridge cost included
    });

    it('uses high slippage tolerance (2%)', () => {
      const strategy = new MemeTrader();
      seedBalance(MEME_CHAIN, 1000);

      const signal: StrategySignal = {
        direction: 'long',
        tokenPair: {
          from: { address: USDC_ADDRESSES[MEME_CHAIN as number]!, symbol: 'USDC', decimals: 6 },
          to: { address: MEME_TOKEN_ADDRESS, symbol: MEME_TOKEN_SYMBOL, decimals: 18 },
        },
        sourceChain: MEME_CHAIN,
        destChain: MEME_CHAIN,
        strength: 0.8,
        reason: 'meme_entry: buy PEPE',
        metadata: { totalScore: 80, signalTypes: 'volume_spike' },
      };

      const plan = strategy.buildExecution(signal, makeContext());
      const swapAction = plan.actions[0]! as { slippage: number };
      expect(swapAction.slippage).toBe(0.02);
    });

    it('respects custom slippage tolerance', () => {
      const strategy = new MemeTrader({ slippageTolerance: 0.03 });
      seedBalance(MEME_CHAIN, 1000);

      const signal: StrategySignal = {
        direction: 'long',
        tokenPair: {
          from: { address: USDC_ADDRESSES[MEME_CHAIN as number]!, symbol: 'USDC', decimals: 6 },
          to: { address: MEME_TOKEN_ADDRESS, symbol: MEME_TOKEN_SYMBOL, decimals: 18 },
        },
        sourceChain: MEME_CHAIN,
        destChain: MEME_CHAIN,
        strength: 0.8,
        reason: 'meme_entry: buy PEPE',
        metadata: { totalScore: 80, signalTypes: 'volume_spike' },
      };

      const plan = strategy.buildExecution(signal, makeContext());
      const swapAction = plan.actions[0]! as { slippage: number };
      expect(swapAction.slippage).toBe(0.03);
    });

    it('caps position size at maxPositionPercent of portfolio', () => {
      const strategy = new MemeTrader({ maxPositionPercent: 0.02 });

      // Portfolio: 10000 USDC on Base
      seedBalance(MEME_CHAIN, 10000);

      const signal: StrategySignal = {
        direction: 'long',
        tokenPair: {
          from: { address: USDC_ADDRESSES[MEME_CHAIN as number]!, symbol: 'USDC', decimals: 6 },
          to: { address: MEME_TOKEN_ADDRESS, symbol: MEME_TOKEN_SYMBOL, decimals: 18 },
        },
        sourceChain: MEME_CHAIN,
        destChain: MEME_CHAIN,
        strength: 0.8,
        reason: 'meme_entry: buy PEPE',
        metadata: { totalScore: 80, signalTypes: 'volume_spike' },
      };

      const plan = strategy.buildExecution(signal, makeContext());
      const swapAction = plan.actions[0]! as { amount: bigint };

      // 2% of 10000 = 200 USDC = 200_000_000 (6 decimals)
      expect(swapAction.amount).toBe(200_000_000n);
    });

    it('uses available balance when less than position cap', () => {
      const strategy = new MemeTrader({ maxPositionPercent: 0.02 });

      // Only 100 USDC available, 2% of 100 = 2 USDC, but available = 100 USDC
      // min(2, 100) = 2 USDC
      seedBalance(MEME_CHAIN, 100);

      const signal: StrategySignal = {
        direction: 'long',
        tokenPair: {
          from: { address: USDC_ADDRESSES[MEME_CHAIN as number]!, symbol: 'USDC', decimals: 6 },
          to: { address: MEME_TOKEN_ADDRESS, symbol: MEME_TOKEN_SYMBOL, decimals: 18 },
        },
        sourceChain: MEME_CHAIN,
        destChain: MEME_CHAIN,
        strength: 0.8,
        reason: 'meme_entry: buy PEPE',
        metadata: { totalScore: 80, signalTypes: 'volume_spike' },
      };

      const plan = strategy.buildExecution(signal, makeContext());
      const swapAction = plan.actions[0]! as { amount: bigint };

      // 2% of 100 = 2 USDC = 2_000_000, available = 100_000_000
      // min(2_000_000, 100_000_000) = 2_000_000
      expect(swapAction.amount).toBe(2_000_000n);
    });

    it('includes trailing stop and time-limit in metadata', () => {
      const strategy = new MemeTrader();
      seedBalance(MEME_CHAIN, 1000);

      const signal: StrategySignal = {
        direction: 'long',
        tokenPair: {
          from: { address: USDC_ADDRESSES[MEME_CHAIN as number]!, symbol: 'USDC', decimals: 6 },
          to: { address: MEME_TOKEN_ADDRESS, symbol: MEME_TOKEN_SYMBOL, decimals: 18 },
        },
        sourceChain: MEME_CHAIN,
        destChain: MEME_CHAIN,
        strength: 0.8,
        reason: 'meme_entry: buy PEPE',
        metadata: { totalScore: 80, signalTypes: 'volume_spike' },
      };

      const plan = strategy.buildExecution(signal, makeContext());

      expect(plan.metadata['trailingStopPercent']).toBe(0.15);
      expect(plan.metadata['timeLimitMs']).toBe(4 * 60 * 60 * 1000);

      // Also check swap action metadata
      const swapAction = plan.actions.find((a) => a.type === 'swap')!;
      expect(swapAction.metadata['trailingStopPercent']).toBe(0.15);
      expect(swapAction.metadata['timeLimitMs']).toBe(4 * 60 * 60 * 1000);
      expect(swapAction.metadata['stoploss']).toBe(-0.15);
    });
  });

  // --- Trailing stop ---

  describe('trailing stop configuration', () => {
    it('has trailing stop enabled', () => {
      const strategy = new MemeTrader();
      expect(strategy.trailingStop).toBe(true);
    });

    it('has trailingStopPositive at 15%', () => {
      const strategy = new MemeTrader();
      expect(strategy.trailingStopPositive).toBe(0.15);
    });

    it('embeds trail config in execution plan metadata', () => {
      const strategy = new MemeTrader({ trailPercent: 0.20 });
      seedBalance(MEME_CHAIN, 1000);

      const signal: StrategySignal = {
        direction: 'long',
        tokenPair: {
          from: { address: USDC_ADDRESSES[MEME_CHAIN as number]!, symbol: 'USDC', decimals: 6 },
          to: { address: MEME_TOKEN_ADDRESS, symbol: MEME_TOKEN_SYMBOL, decimals: 18 },
        },
        sourceChain: MEME_CHAIN,
        destChain: MEME_CHAIN,
        strength: 0.8,
        reason: 'meme_entry: buy PEPE',
        metadata: { totalScore: 80, signalTypes: 'volume_spike' },
      };

      const plan = strategy.buildExecution(signal, makeContext());
      expect(plan.metadata['trailingStopPercent']).toBe(0.20);
    });
  });

  // --- Time-limit ---

  describe('time-limit', () => {
    it('defaults to 4 hours', () => {
      const strategy = new MemeTrader();
      expect(strategy.config.timeLimitMs).toBe(14400000);
    });

    it('embeds time limit in execution plan metadata', () => {
      const strategy = new MemeTrader();
      seedBalance(MEME_CHAIN, 1000);

      const signal: StrategySignal = {
        direction: 'long',
        tokenPair: {
          from: { address: USDC_ADDRESSES[MEME_CHAIN as number]!, symbol: 'USDC', decimals: 6 },
          to: { address: MEME_TOKEN_ADDRESS, symbol: MEME_TOKEN_SYMBOL, decimals: 18 },
        },
        sourceChain: MEME_CHAIN,
        destChain: MEME_CHAIN,
        strength: 0.8,
        reason: 'meme_entry: buy PEPE',
        metadata: { totalScore: 80, signalTypes: 'volume_spike' },
      };

      const plan = strategy.buildExecution(signal, makeContext());
      expect(plan.metadata['timeLimitMs']).toBe(14400000);
    });

    it('accepts custom time limit', () => {
      const strategy = new MemeTrader({ timeLimitMs: 2 * 60 * 60 * 1000 });
      expect(strategy.config.timeLimitMs).toBe(7200000);
    });
  });

  // --- Cooldown ---

  describe('cooldown enforcement', () => {
    it('prevents re-entry within cooldown period', () => {
      const now = Date.now();
      const strategy = new MemeTrader({ entryThreshold: 0, cooldownMs: 3600000 });

      // First entry succeeds
      strategy.setSignalData(makeSignalData(makeFullSignalSet()));
      const first = strategy.shouldExecute(makeContext({ timestamp: now }));
      expect(first).not.toBeNull();

      // Second entry for same token within cooldown -> null
      strategy.setSignalData(makeSignalData(makeFullSignalSet()));
      const second = strategy.shouldExecute(makeContext({ timestamp: now + 1800000 })); // +30 min
      expect(second).toBeNull();
    });

    it('allows re-entry after cooldown period expires', () => {
      const now = Date.now();
      const strategy = new MemeTrader({ entryThreshold: 0, cooldownMs: 3600000 });

      // First entry
      strategy.setSignalData(makeSignalData(makeFullSignalSet()));
      const first = strategy.shouldExecute(makeContext({ timestamp: now }));
      expect(first).not.toBeNull();

      // After cooldown -> allowed
      strategy.setSignalData(makeSignalData(makeFullSignalSet()));
      const second = strategy.shouldExecute(makeContext({ timestamp: now + 3600001 })); // +1h 1ms
      expect(second).not.toBeNull();
    });

    it('allows entry for different token even when one is in cooldown', () => {
      const now = Date.now();
      const strategy = new MemeTrader({ entryThreshold: 0, cooldownMs: 3600000 });

      // Enter token A
      strategy.setSignalData(makeSignalData(makeFullSignalSet()));
      const first = strategy.shouldExecute(makeContext({ timestamp: now }));
      expect(first).not.toBeNull();

      // Token B (different address) should still be allowed
      const tokenB = tokenAddress('0x2222222222222222222222222222222222222222');
      strategy.setSignalData(makeSignalData(makeFullSignalSet(tokenB, 'DOGE', MEME_CHAIN)));
      const second = strategy.shouldExecute(makeContext({ timestamp: now + 100 }));
      expect(second).not.toBeNull();
      expect(second!.tokenPair.to.symbol).toBe('DOGE');
    });

    it('skips token in cooldown and picks next best', () => {
      const now = Date.now();
      const strategy = new MemeTrader({ entryThreshold: 0, cooldownMs: 3600000 });

      const tokenA = MEME_TOKEN_ADDRESS;
      const tokenB = tokenAddress('0x3333333333333333333333333333333333333333');

      // Enter token A first
      strategy.setSignalData(makeSignalData(makeFullSignalSet(tokenA, 'PEPE', MEME_CHAIN)));
      strategy.shouldExecute(makeContext({ timestamp: now }));

      // Now provide both A (score 100) and B (score 45) while A is in cooldown
      const signals = [
        ...makeFullSignalSet(tokenA, 'PEPE', MEME_CHAIN), // score 100 but in cooldown
        { type: 'volume_spike' as MemeSignalType, tokenAddress: tokenB, tokenSymbol: 'SHIB', chainId: MEME_CHAIN, magnitude: 1.0, timestamp: now },
        { type: 'whale_buy' as MemeSignalType, tokenAddress: tokenB, tokenSymbol: 'SHIB', chainId: MEME_CHAIN, magnitude: 1.0, timestamp: now },
      ];

      strategy.setSignalData(makeSignalData(signals));
      const signal = strategy.shouldExecute(makeContext({ timestamp: now + 100 }));

      expect(signal).not.toBeNull();
      expect(signal!.tokenPair.to.symbol).toBe('SHIB');
    });
  });

  // --- Max positions gate ---

  describe('max positions gate', () => {
    it('returns null when max positions reached', () => {
      const strategy = new MemeTrader({ entryThreshold: 0 });

      strategy.setSignalData(makeSignalData(makeFullSignalSet()));

      // maxPositions = 5
      const positions = Array.from({ length: 5 }, (_, i) =>
        makePosition({ id: `pos-${i}` }),
      );

      const signal = strategy.shouldExecute(makeContext({ positions }));
      expect(signal).toBeNull();
    });

    it('allows entry when below max positions', () => {
      const strategy = new MemeTrader({ entryThreshold: 0 });

      strategy.setSignalData(makeSignalData(makeFullSignalSet()));

      const positions = Array.from({ length: 4 }, (_, i) =>
        makePosition({ id: `pos-${i}` }),
      );

      const signal = strategy.shouldExecute(makeContext({ positions }));
      expect(signal).not.toBeNull();
    });

    it('only counts own positions (strategyId = MemeTrader)', () => {
      const strategy = new MemeTrader({ entryThreshold: 0 });

      strategy.setSignalData(makeSignalData(makeFullSignalSet()));

      // 3 positions from other strategies + 2 from MemeTrader = 5 total, but only 2 own
      const positions = [
        makePosition({ id: 'pos-0', strategyId: 'HyperliquidPerps' }),
        makePosition({ id: 'pos-1', strategyId: 'HyperliquidPerps' }),
        makePosition({ id: 'pos-2', strategyId: 'CrossChainArb' }),
        makePosition({ id: 'pos-3', strategyId: 'MemeTrader' }),
        makePosition({ id: 'pos-4', strategyId: 'MemeTrader' }),
      ];

      const signal = strategy.shouldExecute(makeContext({ positions }));
      expect(signal).not.toBeNull(); // 2 < 5, still has room
    });
  });

  // --- Filters ---

  describe('filters', () => {
    it('rejects when no signal data', () => {
      const strategy = new MemeTrader();
      const result = strategy.evaluateFilters(makeContext());
      expect(result).toBe(false);
    });

    it('passes when signal data is set and positions below limit', () => {
      const strategy = new MemeTrader();
      strategy.setSignalData(makeSignalData(makeFullSignalSet()));

      const result = strategy.evaluateFilters(makeContext());
      expect(result).toBe(true);
    });

    it('rejects when max positions reached in filter', () => {
      const strategy = new MemeTrader();
      strategy.setSignalData(makeSignalData(makeFullSignalSet()));

      const positions = Array.from({ length: 5 }, (_, i) =>
        makePosition({ id: `pos-${i}` }),
      );

      const result = strategy.evaluateFilters(makeContext({ positions }));
      expect(result).toBe(false);
    });
  });

  // --- confirmTradeEntry ---

  describe('confirmTradeEntry', () => {
    it('returns true when totalScore is above threshold', () => {
      const strategy = new MemeTrader({ entryThreshold: 60 });
      const plan = {
        id: 'plan-1',
        strategyName: 'MemeTrader',
        actions: [],
        estimatedCostUsd: 3,
        estimatedDurationMs: 30000,
        metadata: { totalScore: 80 },
      };
      expect(strategy.confirmTradeEntry(plan)).toBe(true);
    });

    it('returns false when totalScore is below threshold', () => {
      const strategy = new MemeTrader({ entryThreshold: 60 });
      const plan = {
        id: 'plan-1',
        strategyName: 'MemeTrader',
        actions: [],
        estimatedCostUsd: 3,
        estimatedDurationMs: 30000,
        metadata: { totalScore: 40 },
      };
      expect(strategy.confirmTradeEntry(plan)).toBe(false);
    });

    it('returns false when totalScore metadata is absent', () => {
      const strategy = new MemeTrader();
      const plan = {
        id: 'plan-1',
        strategyName: 'MemeTrader',
        actions: [],
        estimatedCostUsd: 3,
        estimatedDurationMs: 30000,
        metadata: {},
      };
      expect(strategy.confirmTradeEntry(plan)).toBe(false);
    });
  });

  // --- Capital chain selection ---

  describe('capital chain selection', () => {
    it('prefers destination chain when it has balance', () => {
      const strategy = new MemeTrader({ entryThreshold: 0 });

      // Balance on both Ethereum and Base
      seedBalance(CHAINS.ETHEREUM, 5000);
      seedBalance(MEME_CHAIN, 1000);

      const signals = makeFullSignalSet(MEME_TOKEN_ADDRESS, MEME_TOKEN_SYMBOL, MEME_CHAIN);
      strategy.setSignalData(makeSignalData(signals));

      const signal = strategy.shouldExecute(makeContext());
      expect(signal).not.toBeNull();
      // Should pick Base (dest chain) since it has balance -> no bridge needed
      expect(signal!.sourceChain).toBe(MEME_CHAIN);
    });

    it('picks chain with most USDC when dest chain has no balance', () => {
      const strategy = new MemeTrader({ entryThreshold: 0 });

      // No balance on Base, but Ethereum has funds
      seedBalance(CHAINS.ETHEREUM, 5000);

      const signals = makeFullSignalSet(MEME_TOKEN_ADDRESS, MEME_TOKEN_SYMBOL, MEME_CHAIN);
      strategy.setSignalData(makeSignalData(signals));

      const signal = strategy.shouldExecute(makeContext());
      expect(signal).not.toBeNull();
      expect(signal!.sourceChain).toBe(CHAINS.ETHEREUM);
    });
  });
});
