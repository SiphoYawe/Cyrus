/** Tier allocation formula matching the backend PortfolioTierAllocationEngine */

export interface TierAllocation {
  readonly safe: number;
  readonly growth: number;
  readonly degen: number;
  readonly reserve: number;
}

export const RISK_ALLOCATIONS: Record<number, TierAllocation> = {
  1:  { safe: 70, growth: 15, degen: 5,  reserve: 10 },
  2:  { safe: 60, growth: 20, degen: 10, reserve: 10 },
  3:  { safe: 50, growth: 25, degen: 15, reserve: 10 },
  4:  { safe: 40, growth: 30, degen: 20, reserve: 10 },
  5:  { safe: 30, growth: 35, degen: 25, reserve: 10 },
  6:  { safe: 25, growth: 35, degen: 30, reserve: 10 },
  7:  { safe: 20, growth: 30, degen: 40, reserve: 10 },
  8:  { safe: 15, growth: 25, degen: 50, reserve: 10 },
  9:  { safe: 10, growth: 20, degen: 60, reserve: 10 },
  10: { safe: 5,  growth: 15, degen: 70, reserve: 10 },
} as const;

export const TIER_COLORS = {
  safe:    '#3B82F6',  // blue-500
  growth:  '#8B5CF6',  // violet-500
  degen:   '#F59E0B',  // amber-500
  reserve: '#71717A',  // zinc-500
} as const;

export type TierKey = keyof TierAllocation;

export const TIER_LABELS: Record<TierKey, string> = {
  safe:    'Safe',
  growth:  'Growth',
  degen:   'Degen',
  reserve: 'Reserve',
} as const;

/** Returns the named tier for a given risk level 1-10 */
export function getRiskTierLabel(level: number): 'Conservative' | 'Balanced' | 'Aggressive' {
  if (level <= 3) return 'Conservative';
  if (level <= 6) return 'Balanced';
  return 'Aggressive';
}

export function getAllocation(level: number): TierAllocation {
  const clamped = Math.max(1, Math.min(10, Math.round(level)));
  return RISK_ALLOCATIONS[clamped];
}

/** Pie chart data format expected by recharts PieChart */
export function toChartData(alloc: TierAllocation) {
  return [
    { name: TIER_LABELS.safe,    value: alloc.safe,    fill: TIER_COLORS.safe    },
    { name: TIER_LABELS.growth,  value: alloc.growth,  fill: TIER_COLORS.growth  },
    { name: TIER_LABELS.degen,   value: alloc.degen,   fill: TIER_COLORS.degen   },
    { name: TIER_LABELS.reserve, value: alloc.reserve, fill: TIER_COLORS.reserve },
  ];
}

/** Estimate rough rebalancing cost based on how many tiers change significantly */
export function estimateRebalancingCost(
  currentLevel: number,
  newLevel: number,
): { operations: number; estimatedGasUsd: number; estimatedMinutes: number } {
  const diff = Math.abs(newLevel - currentLevel);
  // Each level step typically requires ~0.5 operations on average
  const operations = Math.max(1, Math.round(diff * 0.6));
  const estimatedGasUsd = operations * 4.5;  // rough $4.50 per op
  const estimatedMinutes = operations * 3;    // ~3 min per op (cross-chain)
  return { operations, estimatedGasUsd, estimatedMinutes };
}
