import { describe, it, expect } from 'vitest';
import { evaluateCrossChainBarriers } from '../cross-chain-barriers.js';
import type { CrossChainBarrierConfig, TransferPlan } from '../types.js';

describe('evaluateCrossChainBarriers', () => {
  const defaultConfig: CrossChainBarrierConfig = {
    gasCeiling: 50, // $50 max gas
    slippageThreshold: 0.03, // 3% max slippage
    bridgeTimeout: 1800, // 30 min max bridge time
  };

  const safePlan: TransferPlan = {
    estimatedGasCostUsd: 10,
    estimatedSlippage: 0.01,
    estimatedBridgeTimeSeconds: 300,
  };

  it('holds when all barriers pass', () => {
    const result = evaluateCrossChainBarriers(safePlan, defaultConfig);
    expect(result.type).toBe('hold');
  });

  // --- Gas ceiling ---

  describe('gas ceiling', () => {
    it('aborts when gas exceeds ceiling', () => {
      const plan: TransferPlan = { ...safePlan, estimatedGasCostUsd: 75 };
      const result = evaluateCrossChainBarriers(plan, defaultConfig);

      expect(result.type).toBe('close');
      if (result.type === 'close') {
        expect(result.reason).toBe('gas-ceiling');
        expect(result.details).toContain('$75.00');
        expect(result.details).toContain('$50.00');
      }
    });

    it('holds when gas is at ceiling', () => {
      const plan: TransferPlan = { ...safePlan, estimatedGasCostUsd: 50 };
      const result = evaluateCrossChainBarriers(plan, defaultConfig);
      expect(result.type).toBe('hold');
    });
  });

  // --- Slippage threshold ---

  describe('slippage threshold', () => {
    it('aborts when slippage exceeds threshold', () => {
      const plan: TransferPlan = { ...safePlan, estimatedSlippage: 0.05 };
      const result = evaluateCrossChainBarriers(plan, defaultConfig);

      expect(result.type).toBe('close');
      if (result.type === 'close') {
        expect(result.reason).toBe('slippage-threshold');
        expect(result.details).toContain('5.00%');
        expect(result.details).toContain('3.00%');
      }
    });

    it('holds when slippage is at threshold', () => {
      const plan: TransferPlan = { ...safePlan, estimatedSlippage: 0.03 };
      const result = evaluateCrossChainBarriers(plan, defaultConfig);
      expect(result.type).toBe('hold');
    });
  });

  // --- Bridge timeout ---

  describe('bridge timeout', () => {
    it('aborts when bridge time exceeds timeout', () => {
      const plan: TransferPlan = { ...safePlan, estimatedBridgeTimeSeconds: 2400 };
      const result = evaluateCrossChainBarriers(plan, defaultConfig);

      expect(result.type).toBe('close');
      if (result.type === 'close') {
        expect(result.reason).toBe('bridge-timeout');
        expect(result.details).toContain('2400s');
        expect(result.details).toContain('1800s');
      }
    });

    it('holds when bridge time is at timeout', () => {
      const plan: TransferPlan = { ...safePlan, estimatedBridgeTimeSeconds: 1800 };
      const result = evaluateCrossChainBarriers(plan, defaultConfig);
      expect(result.type).toBe('hold');
    });
  });

  // --- Priority ---

  describe('priority', () => {
    it('gas ceiling is checked first', () => {
      const plan: TransferPlan = {
        estimatedGasCostUsd: 100,
        estimatedSlippage: 0.10,
        estimatedBridgeTimeSeconds: 5000,
      };
      const result = evaluateCrossChainBarriers(plan, defaultConfig);

      expect(result.type).toBe('close');
      if (result.type === 'close') {
        expect(result.reason).toBe('gas-ceiling');
      }
    });
  });
});
