import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { StrategyDetailSheet } from '../strategy-detail-sheet';
import type { Strategy } from '@/stores/strategies-store';
import type { DecisionReport } from '@/hooks/use-strategy-detail';

const makeStrategy = (overrides: Partial<Strategy> = {}): Strategy => ({
  name: 'CrossChainArb',
  enabled: true,
  tier: 'Degen',
  metrics: {
    totalPnl: -321.00,
    winRate: 45.5,
    totalTrades: 22,
    openPositions: 1,
    lastSignalAt: Date.now() - 60 * 60 * 1000,
    performanceHistory: [],
  },
  params: [
    { key: 'stoploss', value: -0.08, description: 'Stop-loss percentage' },
    { key: 'maxPositions', value: 5, description: 'Maximum concurrent positions' },
  ],
  ...overrides,
});

const makeReport = (overrides: Partial<DecisionReport> = {}): DecisionReport => ({
  id: 'report-1',
  strategy: 'CrossChainArb',
  action: 'Open Long ETH/USDC',
  reasoning: 'Z-score reached -2.1, correlation 0.88, entering long position.',
  timestamp: Date.now() - 30 * 60 * 1000,
  outcome: 'success',
  ...overrides,
});

describe('StrategyDetailSheet', () => {
  const mockToggle = vi.fn();
  const mockOpenChange = vi.fn();
  const mockTimeRangeChange = vi.fn();

  const defaultProps = {
    strategy: makeStrategy(),
    open: true,
    onOpenChange: mockOpenChange,
    onToggle: mockToggle,
    togglePending: false,
    performanceHistory: [],
    decisionReports: [],
    isLoading: false,
    timeRange: '1M' as const,
    onTimeRangeChange: mockTimeRangeChange,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders strategy name in header', () => {
    render(<StrategyDetailSheet {...defaultProps} />);
    expect(screen.getByText('CrossChainArb')).toBeInTheDocument();
  });

  it('renders status badge in header', () => {
    render(<StrategyDetailSheet {...defaultProps} />);
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('renders inactive badge when strategy is disabled', () => {
    render(
      <StrategyDetailSheet
        {...defaultProps}
        strategy={makeStrategy({ enabled: false })}
      />
    );
    expect(screen.getByText('Inactive')).toBeInTheDocument();
  });

  it('renders tier badge in header', () => {
    render(<StrategyDetailSheet {...defaultProps} />);
    expect(screen.getByText('Degen')).toBeInTheDocument();
  });

  it('renders toggle switch in header', () => {
    render(<StrategyDetailSheet {...defaultProps} />);
    const switches = screen.getAllByRole('switch');
    expect(switches.length).toBeGreaterThan(0);
  });

  it('renders performance metrics section', () => {
    render(<StrategyDetailSheet {...defaultProps} />);
    expect(screen.getByText('Total P&L')).toBeInTheDocument();
    expect(screen.getByText('Win Rate')).toBeInTheDocument();
    expect(screen.getByText('Total Trades')).toBeInTheDocument();
    expect(screen.getByText('Open Positions')).toBeInTheDocument();
  });

  it('renders time range toggles: 1W, 1M, 3M, All', () => {
    render(<StrategyDetailSheet {...defaultProps} />);
    expect(screen.getByText('1W')).toBeInTheDocument();
    expect(screen.getByText('1M')).toBeInTheDocument();
    expect(screen.getByText('3M')).toBeInTheDocument();
    expect(screen.getByText('All')).toBeInTheDocument();
  });

  it('calls onTimeRangeChange when a time tab is clicked', () => {
    render(<StrategyDetailSheet {...defaultProps} />);
    fireEvent.click(screen.getByText('1W'));
    expect(mockTimeRangeChange).toHaveBeenCalledWith('1W');
  });

  it('renders configuration params section', () => {
    render(<StrategyDetailSheet {...defaultProps} />);
    expect(screen.getByText('Configuration')).toBeInTheDocument();
    expect(screen.getByText('stoploss')).toBeInTheDocument();
    expect(screen.getByText('maxPositions')).toBeInTheDocument();
  });

  it('renders param values', () => {
    render(<StrategyDetailSheet {...defaultProps} />);
    expect(screen.getByText('-0.08')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
  });

  it('renders param descriptions', () => {
    render(<StrategyDetailSheet {...defaultProps} />);
    expect(screen.getByText('Stop-loss percentage')).toBeInTheDocument();
    expect(screen.getByText('Maximum concurrent positions')).toBeInTheDocument();
  });

  it('renders decision reports when provided', () => {
    const report = makeReport();
    render(
      <StrategyDetailSheet
        {...defaultProps}
        decisionReports={[report]}
      />
    );
    expect(screen.getByText('Recent Decisions')).toBeInTheDocument();
    expect(screen.getByText('Open Long ETH/USDC')).toBeInTheDocument();
    expect(screen.getByText(/Z-score reached/)).toBeInTheDocument();
  });

  it('shows empty chart message when no performance history', () => {
    render(<StrategyDetailSheet {...defaultProps} performanceHistory={[]} />);
    expect(screen.getByText('No performance data for this range')).toBeInTheDocument();
  });

  it('renders performance chart when history data provided', () => {
    const history = [
      { timestamp: Date.now() - 7 * 24 * 60 * 60 * 1000, pnl: 100 },
      { timestamp: Date.now() - 3 * 24 * 60 * 60 * 1000, pnl: 250 },
      { timestamp: Date.now(), pnl: 320 },
    ];
    render(<StrategyDetailSheet {...defaultProps} performanceHistory={history} />);
    expect(screen.getByLabelText('Strategy performance chart')).toBeInTheDocument();
  });

  it('shows skeleton loaders when isLoading is true', () => {
    render(<StrategyDetailSheet {...defaultProps} isLoading={true} decisionReports={[makeReport()]} />);
    // The loading state renders skeleton elements
    const skeletons = document.querySelectorAll('[class*="animate-pulse"]');
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it('does not render when strategy is null', () => {
    const { container } = render(
      <StrategyDetailSheet {...defaultProps} strategy={null} open={true} />
    );
    // Should render nothing when strategy is null
    expect(container.firstChild).toBeNull();
  });

  it('calls onToggle when toggle switch is changed', () => {
    render(<StrategyDetailSheet {...defaultProps} />);
    const switches = screen.getAllByRole('switch');
    fireEvent.click(switches[0]);
    expect(mockToggle).toHaveBeenCalledWith('CrossChainArb', false);
  });

  it('shows "No signals yet" when lastSignalAt is null', () => {
    render(
      <StrategyDetailSheet
        {...defaultProps}
        strategy={makeStrategy({ metrics: { ...makeStrategy().metrics, lastSignalAt: null } })}
      />
    );
    expect(screen.getByText('No signals yet')).toBeInTheDocument();
  });
});
