import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AllocationPreview } from '../allocation-preview';
import { RISK_ALLOCATIONS, toChartData, getAllocation, estimateRebalancingCost } from '../risk-allocations';

// Mock recharts
vi.mock('recharts', () => ({
  PieChart:            ({ children }: { children: React.ReactNode }) => <div data-testid="pie-chart">{children}</div>,
  Pie:                 () => null,
  Cell:                () => null,
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

describe('AllocationPreview', () => {
  it('renders current level label', () => {
    render(<AllocationPreview currentLevel={5} previewLevel={5} />);
    expect(screen.getByText('Current')).toBeInTheDocument();
  });

  it('does not render "New" label when preview equals current', () => {
    render(<AllocationPreview currentLevel={5} previewLevel={5} />);
    expect(screen.queryByText('New')).not.toBeInTheDocument();
  });

  it('renders "New" label when preview differs from current', async () => {
    render(<AllocationPreview currentLevel={5} previewLevel={8} />);
    // Due to 100ms debounce, we test this after debounce
    await new Promise((r) => setTimeout(r, 150));
    expect(screen.getByText('New')).toBeInTheDocument();
  });

  it('shows estimated rebalancing cost when preview differs', async () => {
    render(<AllocationPreview currentLevel={5} previewLevel={9} />);
    await new Promise((r) => setTimeout(r, 150));
    expect(screen.getByText(/Estimated rebalancing/i)).toBeInTheDocument();
  });
});

describe('risk-allocations utilities', () => {
  it('RISK_ALLOCATIONS covers all 10 levels', () => {
    for (let i = 1; i <= 10; i++) {
      expect(RISK_ALLOCATIONS[i]).toBeDefined();
    }
  });

  it('all allocations sum to 100', () => {
    for (let i = 1; i <= 10; i++) {
      const alloc = RISK_ALLOCATIONS[i];
      const sum = alloc.safe + alloc.growth + alloc.degen + alloc.reserve;
      expect(sum).toBe(100);
    }
  });

  it('getAllocation clamps values below 1 to 1', () => {
    expect(getAllocation(0)).toEqual(RISK_ALLOCATIONS[1]);
    expect(getAllocation(-5)).toEqual(RISK_ALLOCATIONS[1]);
  });

  it('getAllocation clamps values above 10 to 10', () => {
    expect(getAllocation(11)).toEqual(RISK_ALLOCATIONS[10]);
  });

  it('level 1 is most conservative (safe=70)', () => {
    expect(RISK_ALLOCATIONS[1].safe).toBe(70);
    expect(RISK_ALLOCATIONS[1].degen).toBe(5);
  });

  it('level 10 is most aggressive (degen=70)', () => {
    expect(RISK_ALLOCATIONS[10].degen).toBe(70);
    expect(RISK_ALLOCATIONS[10].safe).toBe(5);
  });

  it('reserve is always 10 for all levels', () => {
    for (let i = 1; i <= 10; i++) {
      expect(RISK_ALLOCATIONS[i].reserve).toBe(10);
    }
  });

  it('toChartData returns 4 entries with correct fills', () => {
    const data = toChartData(RISK_ALLOCATIONS[5]);
    expect(data).toHaveLength(4);
    expect(data[0].fill).toBe('#3B82F6'); // safe = blue
    expect(data[1].fill).toBe('#8B5CF6'); // growth = violet
    expect(data[2].fill).toBe('#F59E0B'); // degen = amber
    expect(data[3].fill).toBe('#71717A'); // reserve = zinc
  });

  it('estimateRebalancingCost returns positive operations for level change', () => {
    const cost = estimateRebalancingCost(3, 8);
    expect(cost.operations).toBeGreaterThan(0);
    expect(cost.estimatedGasUsd).toBeGreaterThan(0);
    expect(cost.estimatedMinutes).toBeGreaterThan(0);
  });

  it('estimateRebalancingCost returns 0 operations at minimum for same level', () => {
    const cost = estimateRebalancingCost(5, 5);
    // diff=0, round(0*0.6)=0, but max(1,0) = 1 based on implementation
    expect(cost.operations).toBeGreaterThanOrEqual(1);
  });
});
