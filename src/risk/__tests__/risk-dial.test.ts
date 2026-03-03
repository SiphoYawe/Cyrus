import { describe, it, expect, beforeEach } from 'vitest';
import {
  calculateTierAllocation,
  toTierConfigs,
  RiskDialManager,
  DIAL_1_ALLOCATION,
  DIAL_5_ALLOCATION,
  DIAL_10_ALLOCATION,
} from '../risk-dial.js';
import type { RiskDialChangedEvent } from '../risk-dial.js';
import type { RiskDialLevel, RiskDialTierAllocation } from '../types.js';
import { Store } from '../../core/store.js';

describe('Risk Dial', () => {
  beforeEach(() => {
    Store.getInstance().reset();
  });

  // --- calculateTierAllocation ---

  describe('calculateTierAllocation', () => {
    it('dial 1 produces Safe ~90%, Growth ~5%, Degen 0%, Reserve 5%', () => {
      const alloc = calculateTierAllocation(1);
      expect(alloc.safe).toBeCloseTo(0.90);
      expect(alloc.growth).toBeCloseTo(0.05);
      expect(alloc.degen).toBeCloseTo(0.00);
      expect(alloc.reserve).toBeCloseTo(0.05);
    });

    it('dial 5 produces Safe ~50%, Growth ~30%, Degen ~15%, Reserve 5%', () => {
      const alloc = calculateTierAllocation(5);
      expect(alloc.safe).toBeCloseTo(0.50);
      expect(alloc.growth).toBeCloseTo(0.30);
      expect(alloc.degen).toBeCloseTo(0.15);
      expect(alloc.reserve).toBeCloseTo(0.05);
    });

    it('dial 10 produces Safe ~10%, Growth ~40%, Degen ~45%, Reserve 5%', () => {
      const alloc = calculateTierAllocation(10);
      expect(alloc.safe).toBeCloseTo(0.10);
      expect(alloc.growth).toBeCloseTo(0.40);
      expect(alloc.degen).toBeCloseTo(0.45);
      expect(alloc.reserve).toBeCloseTo(0.05);
    });

    it('dial 3 produces interpolated values between dial 1 and dial 5', () => {
      const alloc = calculateTierAllocation(3);
      // t = (3-1)/4 = 0.5
      // safe: lerp(0.90, 0.50, 0.5) = 0.70
      // growth: lerp(0.05, 0.30, 0.5) = 0.175
      // degen: lerp(0.00, 0.15, 0.5) = 0.075
      expect(alloc.safe).toBeCloseTo(0.70);
      expect(alloc.growth).toBeCloseTo(0.175);
      expect(alloc.degen).toBeCloseTo(0.075);
    });

    it('dial 7 produces interpolated values between dial 5 and dial 10', () => {
      const alloc = calculateTierAllocation(7);
      // t = (7-5)/5 = 0.4
      // safe: lerp(0.50, 0.10, 0.4) = 0.34
      // growth: lerp(0.30, 0.40, 0.4) = 0.34
      // degen: lerp(0.15, 0.45, 0.4) = 0.27
      expect(alloc.safe).toBeCloseTo(0.34);
      expect(alloc.growth).toBeCloseTo(0.34);
      expect(alloc.degen).toBeCloseTo(0.27);
    });

    it('Reserve is always 5% regardless of dial value', () => {
      for (let d = 1; d <= 10; d++) {
        const alloc = calculateTierAllocation(d as RiskDialLevel);
        expect(alloc.reserve).toBeCloseTo(0.05);
      }
    });

    it('all dial values (1-10) produce allocations summing to 100%', () => {
      for (let d = 1; d <= 10; d++) {
        const alloc = calculateTierAllocation(d as RiskDialLevel);
        const sum = alloc.safe + alloc.growth + alloc.degen + alloc.reserve;
        expect(sum).toBeCloseTo(1.0, 3);
      }
    });

    // --- Invalid inputs ---

    it('throws on dial 0', () => {
      expect(() => calculateTierAllocation(0 as RiskDialLevel)).toThrow('Invalid risk dial level');
    });

    it('throws on dial 11', () => {
      expect(() => calculateTierAllocation(11 as RiskDialLevel)).toThrow('Invalid risk dial level');
    });

    it('throws on non-integer dial 5.5', () => {
      expect(() => calculateTierAllocation(5.5 as RiskDialLevel)).toThrow('Invalid risk dial level');
    });

    it('throws on NaN dial', () => {
      expect(() => calculateTierAllocation(NaN as RiskDialLevel)).toThrow('Invalid risk dial level');
    });
  });

  // --- toTierConfigs ---

  describe('toTierConfigs', () => {
    it('produces correct TierConfig array with tolerance bands', () => {
      const alloc = calculateTierAllocation(5);
      const configs = toTierConfigs(alloc);

      expect(configs).toHaveLength(4);

      const safeConfig = configs.find((c) => c.tier === 'safe')!;
      expect(safeConfig.targetPercent).toBeCloseTo(0.50);
      expect(safeConfig.minPercent).toBeCloseTo(0.47);
      expect(safeConfig.maxPercent).toBeCloseTo(0.53);
      expect(safeConfig.tolerance).toBe(0.03);
    });

    it('sets maxPercent to 0 for Degen at dial 1 (target is 0%)', () => {
      const alloc = calculateTierAllocation(1);
      const configs = toTierConfigs(alloc);

      const degenConfig = configs.find((c) => c.tier === 'degen')!;
      expect(degenConfig.targetPercent).toBe(0);
      expect(degenConfig.maxPercent).toBe(0);
    });

    it('reserve gets tighter tolerance (0.02)', () => {
      const alloc = calculateTierAllocation(5);
      const configs = toTierConfigs(alloc);

      const reserveConfig = configs.find((c) => c.tier === 'reserve')!;
      expect(reserveConfig.tolerance).toBe(0.02);
    });
  });

  // --- RiskDialManager ---

  describe('RiskDialManager', () => {
    let manager: RiskDialManager;
    let emittedEvents: RiskDialChangedEvent[];

    beforeEach(() => {
      emittedEvents = [];
      manager = new RiskDialManager(5, undefined, (event) => emittedEvents.push(event));
    });

    it('starts with initial dial value', () => {
      expect(manager.getDial()).toBe(5);
    });

    it('returns current allocation', () => {
      const alloc = manager.getCurrentAllocation();
      expect(alloc.safe).toBeCloseTo(0.50);
      expect(alloc.growth).toBeCloseTo(0.30);
    });

    it('dial change triggers event emission', () => {
      manager.setDial(7);

      expect(emittedEvents).toHaveLength(1);
      expect(emittedEvents[0].type).toBe('risk_dial_changed');
      expect(emittedEvents[0].oldDial).toBe(5);
      expect(emittedEvents[0].newDial).toBe(7);
    });

    it('dial change updates current dial', () => {
      manager.setDial(3);
      expect(manager.getDial()).toBe(3);
    });

    it('dial change returns rebalancing plan with correct allocations', () => {
      const plan = manager.setDial(8);

      expect(plan.oldDial).toBe(5);
      expect(plan.newDial).toBe(8);
      expect(plan.oldAllocation.safe).toBeCloseTo(0.50);
      expect(plan.newAllocation.safe).toBeCloseTo(0.26);
    });

    it('reset returns to default dial', () => {
      manager.setDial(9);
      manager.reset();
      expect(manager.getDial()).toBe(5);
    });
  });
});
