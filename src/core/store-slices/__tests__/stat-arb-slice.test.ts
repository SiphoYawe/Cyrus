import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Store } from '../../store.js';
import {
  createPairKey,
  parsePairKey,
  isSignalExpired,
  calculateStoplossBreached,
  STAT_ARB_SIGNAL_EVENT,
  STAT_ARB_POSITION_OPENED_EVENT,
  STAT_ARB_POSITION_CLOSED_EVENT,
} from '../stat-arb-slice.js';
import type {
  StatArbSignal,
  StatArbPosition,
  StatArbCloseData,
  StatArbLeg,
} from '../stat-arb-slice.js';

function makeSignal(overrides: Partial<StatArbSignal> = {}): StatArbSignal {
  return {
    signalId: 'sig-1',
    pair: { tokenA: 'BTC', tokenB: 'ETH', key: createPairKey('BTC', 'ETH') },
    direction: 'long_pair',
    zScore: -2.0,
    correlation: 0.85,
    halfLifeHours: 24,
    hedgeRatio: 1.5,
    recommendedLeverage: 18,
    source: 'native',
    timestamp: Date.now(),
    consumed: false,
    expiresAt: Date.now() + 60 * 60 * 1000,
    ...overrides,
  };
}

function makeLeg(overrides: Partial<StatArbLeg> = {}): StatArbLeg {
  return {
    symbol: 'BTC',
    side: 'long',
    size: 100,
    entryPrice: 50000,
    currentPrice: 50000,
    unrealizedPnl: 0,
    funding: 0,
    ...overrides,
  };
}

function makePosition(overrides: Partial<StatArbPosition> = {}): StatArbPosition {
  return {
    positionId: 'pos-1',
    pair: { tokenA: 'BTC', tokenB: 'ETH', key: createPairKey('BTC', 'ETH') },
    direction: 'long_pair',
    hedgeRatio: 1.5,
    leverage: 18,
    legA: makeLeg({ symbol: 'BTC', side: 'long' }),
    legB: makeLeg({ symbol: 'ETH', side: 'short' }),
    openTimestamp: Date.now(),
    halfLifeHours: 24,
    combinedPnl: 0,
    accumulatedFunding: 0,
    marginUsed: 1000,
    status: 'active',
    signalSource: 'native',
    ...overrides,
  };
}

describe('Stat Arb Store Slices', () => {
  let store: Store;

  beforeEach(() => {
    Store.getInstance().reset();
    store = Store.getInstance();
  });

  // --- Signal methods ---

  describe('addStatArbSignal', () => {
    it('stores signal keyed by pair key', () => {
      const signal = makeSignal();
      store.addStatArbSignal(signal);
      expect(store.getSignalByPairKey(signal.pair.key)).toBe(signal);
    });

    it('emits stat_arb_signal event', () => {
      const handler = vi.fn();
      store.emitter.on(STAT_ARB_SIGNAL_EVENT, handler);
      const signal = makeSignal();
      store.addStatArbSignal(signal);
      expect(handler).toHaveBeenCalledWith(signal);
    });

    it('overwrites existing signal for same pair', () => {
      const sig1 = makeSignal({ zScore: -1.5 });
      const sig2 = makeSignal({ signalId: 'sig-2', zScore: -2.5 });
      store.addStatArbSignal(sig1);
      store.addStatArbSignal(sig2);
      expect(store.getSignalByPairKey(sig1.pair.key)?.zScore).toBe(-2.5);
    });
  });

  describe('getSignalByPairKey', () => {
    it('returns signal for existing key', () => {
      const signal = makeSignal();
      store.addStatArbSignal(signal);
      expect(store.getSignalByPairKey(signal.pair.key)).toBe(signal);
    });

    it('returns undefined for non-existent key', () => {
      expect(store.getSignalByPairKey('NONEXISTENT')).toBeUndefined();
    });
  });

  describe('getPendingSignals', () => {
    it('returns unconsumed, non-expired signals', () => {
      const sig1 = makeSignal({ signalId: 'sig-1' });
      const sig2 = makeSignal({
        signalId: 'sig-2',
        pair: { tokenA: 'SOL', tokenB: 'AVAX', key: createPairKey('SOL', 'AVAX') },
      });
      store.addStatArbSignal(sig1);
      store.addStatArbSignal(sig2);
      expect(store.getPendingSignals()).toHaveLength(2);
    });

    it('excludes consumed signals', () => {
      const signal = makeSignal();
      store.addStatArbSignal(signal);
      store.markSignalConsumed(signal.pair.key);
      expect(store.getPendingSignals()).toHaveLength(0);
    });

    it('excludes expired signals', () => {
      const signal = makeSignal({ expiresAt: Date.now() - 1000 });
      store.addStatArbSignal(signal);
      expect(store.getPendingSignals()).toHaveLength(0);
    });
  });

  describe('markSignalConsumed', () => {
    it('sets consumed=true and returns true', () => {
      const signal = makeSignal();
      store.addStatArbSignal(signal);
      expect(store.markSignalConsumed(signal.pair.key)).toBe(true);
      expect(store.getSignalByPairKey(signal.pair.key)?.consumed).toBe(true);
    });

    it('returns false for non-existent signal', () => {
      expect(store.markSignalConsumed('NONEXISTENT')).toBe(false);
    });
  });

  describe('pruneExpiredSignals', () => {
    it('removes expired signals and returns count', () => {
      const expired = makeSignal({
        signalId: 'expired',
        expiresAt: Date.now() - 1000,
      });
      const valid = makeSignal({
        signalId: 'valid',
        pair: { tokenA: 'SOL', tokenB: 'AVAX', key: createPairKey('SOL', 'AVAX') },
        expiresAt: Date.now() + 60000,
      });
      store.addStatArbSignal(expired);
      store.addStatArbSignal(valid);

      const pruned = store.pruneExpiredSignals();
      expect(pruned).toBe(1);
      expect(store.getSignalByPairKey(expired.pair.key)).toBeUndefined();
      expect(store.getSignalByPairKey(valid.pair.key)).toBeDefined();
    });

    it('preserves non-expired signals', () => {
      const signal = makeSignal({ expiresAt: Date.now() + 60000 });
      store.addStatArbSignal(signal);
      const pruned = store.pruneExpiredSignals();
      expect(pruned).toBe(0);
      expect(store.getSignalByPairKey(signal.pair.key)).toBeDefined();
    });
  });

  describe('getSignalCount', () => {
    it('returns correct statistics', () => {
      const pending = makeSignal({ signalId: 'p1' });
      const consumed = makeSignal({
        signalId: 'c1',
        pair: { tokenA: 'SOL', tokenB: 'AVAX', key: createPairKey('SOL', 'AVAX') },
      });
      const expired = makeSignal({
        signalId: 'e1',
        pair: { tokenA: 'DOT', tokenB: 'LINK', key: createPairKey('DOT', 'LINK') },
        expiresAt: Date.now() - 1000,
      });

      store.addStatArbSignal(pending);
      store.addStatArbSignal(consumed);
      store.markSignalConsumed(consumed.pair.key);
      store.addStatArbSignal(expired);

      const stats = store.getSignalCount();
      expect(stats.total).toBe(3);
      expect(stats.pending).toBe(1);
      expect(stats.consumed).toBe(1);
      expect(stats.expired).toBe(1);
    });
  });

  // --- Position methods ---

  describe('openStatArbPosition', () => {
    it('adds to active map', () => {
      const position = makePosition();
      store.openStatArbPosition(position);
      expect(store.getActiveStatArbPosition('pos-1')).toBe(position);
    });

    it('emits stat_arb_position_opened event', () => {
      const handler = vi.fn();
      store.emitter.on(STAT_ARB_POSITION_OPENED_EVENT, handler);
      const position = makePosition();
      store.openStatArbPosition(position);
      expect(handler).toHaveBeenCalledWith(position);
    });
  });

  describe('closeStatArbPosition', () => {
    it('moves position from active to completed', () => {
      const position = makePosition();
      store.openStatArbPosition(position);

      const closeData: StatArbCloseData = {
        reason: 'mean_reversion',
        closeTimestamp: Date.now(),
        closePnl: 150,
        legAClosePrice: 51000,
        legBClosePrice: 3100,
      };
      store.closeStatArbPosition('pos-1', closeData);

      expect(store.getActiveStatArbPosition('pos-1')).toBeUndefined();
      const completed = store.getCompletedStatArbPositions();
      expect(completed).toHaveLength(1);
      expect(completed[0].closeReason).toBe('mean_reversion');
      expect(completed[0].closePnl).toBe(150);
      expect(completed[0].status).toBe('closed');
    });

    it('emits stat_arb_position_closed event', () => {
      const handler = vi.fn();
      store.emitter.on(STAT_ARB_POSITION_CLOSED_EVENT, handler);
      const position = makePosition();
      store.openStatArbPosition(position);

      const closeData: StatArbCloseData = {
        reason: 'time_stop',
        closeTimestamp: Date.now(),
        closePnl: -50,
        legAClosePrice: 49000,
        legBClosePrice: 3200,
      };
      store.closeStatArbPosition('pos-1', closeData);
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('throws for non-existent positionId', () => {
      expect(() =>
        store.closeStatArbPosition('nonexistent', {
          reason: 'manual',
          closeTimestamp: Date.now(),
          closePnl: 0,
          legAClosePrice: 0,
          legBClosePrice: 0,
        }),
      ).toThrow('Cannot close non-existent stat arb position');
    });
  });

  describe('getActivePositionByPairKey', () => {
    it('finds position by pair key', () => {
      const position = makePosition();
      store.openStatArbPosition(position);
      const found = store.getActivePositionByPairKey(position.pair.key);
      expect(found).toBe(position);
    });

    it('returns undefined when no position for pair', () => {
      expect(store.getActivePositionByPairKey('NONEXISTENT')).toBeUndefined();
    });
  });

  describe('updateStatArbPositionPnl', () => {
    it('updates combinedPnl and accumulatedFunding', () => {
      const position = makePosition();
      store.openStatArbPosition(position);
      store.updateStatArbPositionPnl('pos-1', 250, -5);

      const updated = store.getActiveStatArbPosition('pos-1');
      expect(updated?.combinedPnl).toBe(250);
      expect(updated?.accumulatedFunding).toBe(-5);
    });

    it('does not throw for non-existent position', () => {
      // Just logs a warning
      expect(() => store.updateStatArbPositionPnl('nonexistent', 100, 0)).not.toThrow();
    });
  });

  describe('getActiveStatArbPositionCount', () => {
    it('returns correct count', () => {
      expect(store.getActiveStatArbPositionCount()).toBe(0);
      store.openStatArbPosition(makePosition());
      expect(store.getActiveStatArbPositionCount()).toBe(1);
      store.openStatArbPosition(makePosition({ positionId: 'pos-2' }));
      expect(store.getActiveStatArbPositionCount()).toBe(2);
    });
  });

  // --- Store reset ---

  describe('store.reset()', () => {
    it('clears all three stat arb Maps', () => {
      store.addStatArbSignal(makeSignal());
      store.openStatArbPosition(makePosition());
      store.closeStatArbPosition('pos-1', {
        reason: 'manual',
        closeTimestamp: Date.now(),
        closePnl: 0,
        legAClosePrice: 50000,
        legBClosePrice: 3000,
      });

      store.reset();
      const newStore = Store.getInstance();

      expect(newStore.getAllStatArbSignals()).toHaveLength(0);
      expect(newStore.getAllActiveStatArbPositions()).toHaveLength(0);
      expect(newStore.getCompletedStatArbPositions()).toHaveLength(0);
    });

    it('removes event listeners on reset', () => {
      const handler = vi.fn();
      store.emitter.on(STAT_ARB_SIGNAL_EVENT, handler);

      store.reset();
      const newStore = Store.getInstance();
      newStore.addStatArbSignal(makeSignal());
      // Handler was removed by reset
      expect(handler).not.toHaveBeenCalled();
    });
  });

  // --- Dual storage ---

  describe('dual storage pattern', () => {
    it('active and completed positions are separate Maps', () => {
      const pos = makePosition();
      store.openStatArbPosition(pos);
      expect(store.getAllActiveStatArbPositions()).toHaveLength(1);
      expect(store.getCompletedStatArbPositions()).toHaveLength(0);

      store.closeStatArbPosition('pos-1', {
        reason: 'mean_reversion',
        closeTimestamp: Date.now(),
        closePnl: 100,
        legAClosePrice: 51000,
        legBClosePrice: 3100,
      });

      expect(store.getAllActiveStatArbPositions()).toHaveLength(0);
      expect(store.getCompletedStatArbPositions()).toHaveLength(1);
    });
  });

  // --- Helper utilities ---

  describe('createPairKey', () => {
    it('produces canonical alphabetical ordering', () => {
      expect(createPairKey('ETH', 'BTC')).toBe('BTC-ETH');
      expect(createPairKey('BTC', 'ETH')).toBe('BTC-ETH');
    });

    it('same result regardless of argument order', () => {
      expect(createPairKey('SOL', 'AVAX')).toBe(createPairKey('AVAX', 'SOL'));
    });
  });

  describe('parsePairKey', () => {
    it('correctly splits a composite key', () => {
      const { tokenA, tokenB } = parsePairKey('BTC-ETH');
      expect(tokenA).toBe('BTC');
      expect(tokenB).toBe('ETH');
    });

    it('throws on invalid key', () => {
      expect(() => parsePairKey('INVALID')).toThrow('Invalid pair key');
    });
  });

  describe('isSignalExpired', () => {
    it('returns true for expired signal', () => {
      const signal = makeSignal({ expiresAt: Date.now() - 1000 });
      expect(isSignalExpired(signal)).toBe(true);
    });

    it('returns false for valid signal', () => {
      const signal = makeSignal({ expiresAt: Date.now() + 60000 });
      expect(isSignalExpired(signal)).toBe(false);
    });
  });

  describe('calculateStoplossBreached', () => {
    it('returns true when combined PnL exceeds -30% of margin', () => {
      const position = makePosition({ combinedPnl: -350, marginUsed: 1000 });
      expect(calculateStoplossBreached(position, 0.30)).toBe(true);
    });

    it('returns false when combined PnL is within threshold', () => {
      const position = makePosition({ combinedPnl: -100, marginUsed: 1000 });
      expect(calculateStoplossBreached(position, 0.30)).toBe(false);
    });

    it('returns false when marginUsed is zero', () => {
      const position = makePosition({ combinedPnl: -100, marginUsed: 0 });
      expect(calculateStoplossBreached(position, 0.30)).toBe(false);
    });
  });
});
