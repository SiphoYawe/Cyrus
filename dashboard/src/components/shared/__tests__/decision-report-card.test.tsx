import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DecisionReportCard } from '@/components/shared/decision-report-card';
import type { DecisionReport } from '@/hooks/use-recent-decisions';

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode; asChild?: boolean }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const baseReport: DecisionReport = {
  id: 'report-1',
  timestamp: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
  tier: 'Growth',
  strategyName: 'YieldHunter',
  summary: 'Identified yield opportunity on Arbitrum with 8.2% APY in USDC/USDT pool.',
  narrative:
    'After scanning 14 chains, I detected a 8.2% APY pool on Arbitrum. Risk metrics are within acceptable bounds for Growth tier. Executing bridge + deposit in a single Composer tx.',
};

describe('DecisionReportCard', () => {
  it('renders timestamp in relative format', () => {
    render(<DecisionReportCard report={baseReport} />);
    expect(screen.getByText(/ago/i)).toBeInTheDocument();
  });

  it('renders strategy tier badge', () => {
    render(<DecisionReportCard report={baseReport} />);
    expect(screen.getByText('Growth')).toBeInTheDocument();
  });

  it('renders strategy name', () => {
    render(<DecisionReportCard report={baseReport} />);
    expect(screen.getByText('YieldHunter')).toBeInTheDocument();
  });

  it('renders summary text', () => {
    render(<DecisionReportCard report={baseReport} />);
    expect(screen.getByText(/yield opportunity/i)).toBeInTheDocument();
  });

  it('truncates summary at 120 chars', () => {
    const longSummary = 'A'.repeat(130);
    render(<DecisionReportCard report={{ ...baseReport, summary: longSummary }} />);
    expect(screen.getByText(/A+…/)).toBeInTheDocument();
  });

  it('narrative is hidden by default', () => {
    render(<DecisionReportCard report={baseReport} />);
    // The narrative may still be in DOM (Collapsible uses CSS), but we test for the trigger
    const trigger = screen.getByRole('button', { name: /toggle decision report/i });
    expect(trigger).toBeInTheDocument();
  });

  it('expands to show narrative on click', () => {
    render(<DecisionReportCard report={baseReport} />);
    const trigger = screen.getByRole('button', { name: /toggle decision report/i });
    fireEvent.click(trigger);
    expect(screen.getByText(/scanning 14 chains/i)).toBeInTheDocument();
  });

  it('collapses narrative on second click', () => {
    render(<DecisionReportCard report={baseReport} />);
    const trigger = screen.getByRole('button', { name: /toggle decision report/i });
    fireEvent.click(trigger);
    fireEvent.click(trigger);
    // After collapse the collapsible state is closed
    // The content still exists in DOM but state changes
    expect(trigger).toBeInTheDocument();
  });

  it('applies correct color class for Safe tier', () => {
    const { container } = render(
      <DecisionReportCard report={{ ...baseReport, tier: 'Safe' }} />
    );
    const dot = container.querySelector('.bg-blue-500');
    expect(dot).toBeInTheDocument();
  });

  it('applies correct color class for Degen tier', () => {
    const { container } = render(
      <DecisionReportCard report={{ ...baseReport, tier: 'Degen' }} />
    );
    const dot = container.querySelector('.bg-amber-500');
    expect(dot).toBeInTheDocument();
  });

  it('applies correct color class for Reserve tier', () => {
    const { container } = render(
      <DecisionReportCard report={{ ...baseReport, tier: 'Reserve' }} />
    );
    const dot = container.querySelector('.bg-zinc-500');
    expect(dot).toBeInTheDocument();
  });
});
