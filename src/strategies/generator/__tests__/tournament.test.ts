// Tests for Tournament — selection and ranking of strategy variants

import { describe, it, expect, beforeEach } from 'vitest';
import { Store } from '../../../core/store.js';
import { Tournament } from '../tournament.js';
import type { TournamentResult, GenerationConfig } from '../types.js';
import { DEFAULT_GENERATION_CONFIG } from '../types.js';

function makeTournamentResult(
  overrides: Partial<TournamentResult> & { variantId: string },
): TournamentResult {
  return {
    rank: 0,
    sharpeRatio: 1.0,
    maxDrawdown: 0.10,
    totalReturn: 0.15,
    winRate: 0.6,
    profitFactor: 1.5,
    eliminated: false,
    eliminationReason: null,
    promotedToPaperTrading: false,
    ...overrides,
  };
}

describe('Tournament', () => {
  let tournament: Tournament;
  let config: GenerationConfig;

  beforeEach(() => {
    Store.getInstance().reset();
    tournament = new Tournament();
    config = { ...DEFAULT_GENERATION_CONFIG };
  });

  describe('select', () => {
    it('eliminates variants with Sharpe < 0', () => {
      const results = new Map<string, TournamentResult>();
      results.set('v1', makeTournamentResult({ variantId: 'v1', sharpeRatio: -0.5 }));
      results.set('v2', makeTournamentResult({ variantId: 'v2', sharpeRatio: 1.2 }));

      const selected = tournament.select(results, config);

      const v1 = selected.find((r) => r.variantId === 'v1');
      expect(v1).toBeDefined();
      expect(v1!.eliminated).toBe(true);
      expect(v1!.eliminationReason).toContain('Sharpe');
    });

    it('eliminates variants with max drawdown > threshold (20%)', () => {
      const results = new Map<string, TournamentResult>();
      results.set('v1', makeTournamentResult({ variantId: 'v1', maxDrawdown: 0.25 }));
      results.set('v2', makeTournamentResult({ variantId: 'v2', maxDrawdown: 0.10 }));

      const selected = tournament.select(results, config);

      const v1 = selected.find((r) => r.variantId === 'v1');
      expect(v1).toBeDefined();
      expect(v1!.eliminated).toBe(true);
      expect(v1!.eliminationReason).toContain('drawdown');
    });

    it('selects top N=3 by Sharpe ratio descending', () => {
      const results = new Map<string, TournamentResult>();
      results.set('v1', makeTournamentResult({ variantId: 'v1', sharpeRatio: 2.5 }));
      results.set('v2', makeTournamentResult({ variantId: 'v2', sharpeRatio: 1.8 }));
      results.set('v3', makeTournamentResult({ variantId: 'v3', sharpeRatio: 1.2 }));
      results.set('v4', makeTournamentResult({ variantId: 'v4', sharpeRatio: 0.9 }));
      results.set('v5', makeTournamentResult({ variantId: 'v5', sharpeRatio: 0.5 }));

      const selected = tournament.select(results, config);

      const promoted = selected.filter((r) => r.promotedToPaperTrading);
      expect(promoted).toHaveLength(3);

      // Top 3 by Sharpe should be promoted
      const promotedIds = promoted.map((r) => r.variantId);
      expect(promotedIds).toContain('v1');
      expect(promotedIds).toContain('v2');
      expect(promotedIds).toContain('v3');
      expect(promotedIds).not.toContain('v4');
      expect(promotedIds).not.toContain('v5');
    });

    it('returns full results with rankings for audit trail', () => {
      const results = new Map<string, TournamentResult>();
      results.set('v1', makeTournamentResult({ variantId: 'v1', sharpeRatio: 2.0 }));
      results.set('v2', makeTournamentResult({ variantId: 'v2', sharpeRatio: -0.3 }));
      results.set('v3', makeTournamentResult({ variantId: 'v3', sharpeRatio: 1.5 }));

      const selected = tournament.select(results, config);

      // All variants should be in the result
      expect(selected).toHaveLength(3);

      // Surviving variants should have proper ranks
      const v1 = selected.find((r) => r.variantId === 'v1')!;
      const v3 = selected.find((r) => r.variantId === 'v3')!;
      const v2 = selected.find((r) => r.variantId === 'v2')!;

      expect(v1.rank).toBe(1); // highest Sharpe
      expect(v3.rank).toBe(2); // second
      expect(v2.eliminated).toBe(true); // negative Sharpe
      expect(v2.rank).toBe(3); // eliminated, ranked after survivors
    });

    it('respects configurable tournament top N', () => {
      const customConfig = { ...config, tournamentTopN: 1 };

      const results = new Map<string, TournamentResult>();
      results.set('v1', makeTournamentResult({ variantId: 'v1', sharpeRatio: 2.0 }));
      results.set('v2', makeTournamentResult({ variantId: 'v2', sharpeRatio: 1.5 }));
      results.set('v3', makeTournamentResult({ variantId: 'v3', sharpeRatio: 1.0 }));

      const selected = tournament.select(results, customConfig);

      const promoted = selected.filter((r) => r.promotedToPaperTrading);
      expect(promoted).toHaveLength(1);
      expect(promoted[0].variantId).toBe('v1');
    });

    it('handles empty results gracefully', () => {
      const results = new Map<string, TournamentResult>();
      const selected = tournament.select(results, config);
      expect(selected).toHaveLength(0);
    });

    it('handles all eliminated variants', () => {
      const results = new Map<string, TournamentResult>();
      results.set('v1', makeTournamentResult({ variantId: 'v1', sharpeRatio: -1.0 }));
      results.set('v2', makeTournamentResult({ variantId: 'v2', sharpeRatio: -0.5 }));

      const selected = tournament.select(results, config);

      const promoted = selected.filter((r) => r.promotedToPaperTrading);
      expect(promoted).toHaveLength(0);
      expect(selected.every((r) => r.eliminated)).toBe(true);
    });

    it('respects configurable max drawdown threshold', () => {
      const customConfig = { ...config, maxDrawdownThreshold: 0.10 };

      const results = new Map<string, TournamentResult>();
      results.set('v1', makeTournamentResult({ variantId: 'v1', sharpeRatio: 2.0, maxDrawdown: 0.15 }));
      results.set('v2', makeTournamentResult({ variantId: 'v2', sharpeRatio: 1.5, maxDrawdown: 0.08 }));

      const selected = tournament.select(results, customConfig);

      const v1 = selected.find((r) => r.variantId === 'v1')!;
      expect(v1.eliminated).toBe(true);

      const v2 = selected.find((r) => r.variantId === 'v2')!;
      expect(v2.eliminated).toBe(false);
      expect(v2.promotedToPaperTrading).toBe(true);
    });
  });
});
