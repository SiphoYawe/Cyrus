import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { StrategyCard } from '../strategy-card';
import type { Strategy } from '@/stores/strategies-store';

const makeStrategy = (overrides: Partial<Strategy> = {}): Strategy => ({
  name: 'YieldHunter',
  enabled: true,
  tier: 'Growth',
  metrics: {
    totalPnl: 1234.56,
    winRate: 72.5,
    totalTrades: 48,
    openPositions: 3,
    lastSignalAt: Date.now() - 3 * 60 * 60 * 1000,
    performanceHistory: [],
  },
  params: [
    { key: 'stoploss', value: -0.05, description: 'Stop-loss percentage' },
    { key: 'minimalRoi', value: 0.02, description: 'Minimum ROI target' },
  ],
  ...overrides,
});

describe('StrategyCard', () => {
  const mockToggle = vi.fn();
  const mockClick = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders strategy name', () => {
    render(
      <StrategyCard
        strategy={makeStrategy()}
        onToggle={mockToggle}
        togglePending={false}
        onClick={mockClick}
      />
    );
    expect(screen.getByText('YieldHunter')).toBeInTheDocument();
  });

  it('renders active status badge when enabled', () => {
    render(
      <StrategyCard
        strategy={makeStrategy({ enabled: true })}
        onToggle={mockToggle}
        togglePending={false}
        onClick={mockClick}
      />
    );
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('renders inactive status badge when disabled', () => {
    render(
      <StrategyCard
        strategy={makeStrategy({ enabled: false })}
        onToggle={mockToggle}
        togglePending={false}
        onClick={mockClick}
      />
    );
    expect(screen.getByText('Inactive')).toBeInTheDocument();
  });

  it('renders tier badge with correct label', () => {
    render(
      <StrategyCard
        strategy={makeStrategy({ tier: 'Safe' })}
        onToggle={mockToggle}
        togglePending={false}
        onClick={mockClick}
      />
    );
    expect(screen.getByText('Safe')).toBeInTheDocument();
  });

  it('renders all three tier labels correctly', () => {
    const tiers: Array<Strategy['tier']> = ['Safe', 'Growth', 'Degen'];
    tiers.forEach((tier) => {
      const { unmount } = render(
        <StrategyCard
          strategy={makeStrategy({ tier })}
          onToggle={mockToggle}
          togglePending={false}
          onClick={mockClick}
        />
      );
      expect(screen.getByText(tier)).toBeInTheDocument();
      unmount();
    });
  });

  it('renders total trades count', () => {
    render(
      <StrategyCard
        strategy={makeStrategy()}
        onToggle={mockToggle}
        togglePending={false}
        onClick={mockClick}
      />
    );
    // The NumberFlow component renders the value
    expect(screen.getByLabelText(/Total trades: 48/i)).toBeInTheDocument();
  });

  it('renders open positions count', () => {
    render(
      <StrategyCard
        strategy={makeStrategy()}
        onToggle={mockToggle}
        togglePending={false}
        onClick={mockClick}
      />
    );
    expect(screen.getByLabelText(/Open positions: 3/i)).toBeInTheDocument();
  });

  it('renders P&L with positive color class', () => {
    render(
      <StrategyCard
        strategy={makeStrategy({ metrics: { ...makeStrategy().metrics, totalPnl: 500 } })}
        onToggle={mockToggle}
        togglePending={false}
        onClick={mockClick}
      />
    );
    const pnlEl = screen.getByLabelText(/Total P&L:/i);
    const pnlContainer = pnlEl.closest('span');
    expect(pnlContainer?.className).toContain('text-positive');
  });

  it('renders P&L with negative color class', () => {
    render(
      <StrategyCard
        strategy={makeStrategy({ metrics: { ...makeStrategy().metrics, totalPnl: -200 } })}
        onToggle={mockToggle}
        togglePending={false}
        onClick={mockClick}
      />
    );
    const pnlEl = screen.getByLabelText(/Total P&L:/i);
    const pnlContainer = pnlEl.closest('span');
    expect(pnlContainer?.className).toContain('text-negative');
  });

  it('renders win rate with green color when >= 70%', () => {
    render(
      <StrategyCard
        strategy={makeStrategy({ metrics: { ...makeStrategy().metrics, winRate: 75 } })}
        onToggle={mockToggle}
        togglePending={false}
        onClick={mockClick}
      />
    );
    const winRateEl = screen.getByLabelText(/Win rate: 75.0%/i);
    const winRateContainer = winRateEl.closest('span');
    expect(winRateContainer?.className).toContain('text-positive');
  });

  it('renders win rate with amber color when >= 50% and < 70%', () => {
    render(
      <StrategyCard
        strategy={makeStrategy({ metrics: { ...makeStrategy().metrics, winRate: 60 } })}
        onToggle={mockToggle}
        togglePending={false}
        onClick={mockClick}
      />
    );
    const winRateEl = screen.getByLabelText(/Win rate: 60.0%/i);
    const winRateContainer = winRateEl.closest('span');
    expect(winRateContainer?.className).toContain('text-warning');
  });

  it('renders win rate with red color when < 50%', () => {
    render(
      <StrategyCard
        strategy={makeStrategy({ metrics: { ...makeStrategy().metrics, winRate: 40 } })}
        onToggle={mockToggle}
        togglePending={false}
        onClick={mockClick}
      />
    );
    const winRateEl = screen.getByLabelText(/Win rate: 40.0%/i);
    const winRateContainer = winRateEl.closest('span');
    expect(winRateContainer?.className).toContain('text-negative');
  });

  it('shows "No signals yet" when lastSignalAt is null', () => {
    render(
      <StrategyCard
        strategy={makeStrategy({ metrics: { ...makeStrategy().metrics, lastSignalAt: null } })}
        onToggle={mockToggle}
        togglePending={false}
        onClick={mockClick}
      />
    );
    expect(screen.getByText('No signals yet')).toBeInTheDocument();
  });

  it('calls onClick when card is clicked', () => {
    const strategy = makeStrategy();
    render(
      <StrategyCard
        strategy={strategy}
        onToggle={mockToggle}
        togglePending={false}
        onClick={mockClick}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /Open YieldHunter strategy details/i }));
    expect(mockClick).toHaveBeenCalledWith(strategy);
  });

  it('does not call onClick when toggle switch is clicked', () => {
    render(
      <StrategyCard
        strategy={makeStrategy()}
        onToggle={mockToggle}
        togglePending={false}
        onClick={mockClick}
      />
    );
    // Click the presentation wrapper around the switch
    const switchWrapper = screen.getByRole('switch', { name: /Toggle YieldHunter strategy/i });
    fireEvent.click(switchWrapper);
    expect(mockClick).not.toHaveBeenCalled();
  });

  it('toggle switch calls onToggle with correct arguments', () => {
    render(
      <StrategyCard
        strategy={makeStrategy({ enabled: true })}
        onToggle={mockToggle}
        togglePending={false}
        onClick={mockClick}
      />
    );
    const switchEl = screen.getByRole('switch', { name: /Toggle YieldHunter strategy off/i });
    fireEvent.click(switchEl);
    expect(mockToggle).toHaveBeenCalledWith('YieldHunter', false);
  });

  it('disables switch when togglePending is true', () => {
    render(
      <StrategyCard
        strategy={makeStrategy()}
        onToggle={mockToggle}
        togglePending={true}
        onClick={mockClick}
      />
    );
    const switchEl = screen.getByRole('switch');
    expect(switchEl).toBeDisabled();
  });
});
