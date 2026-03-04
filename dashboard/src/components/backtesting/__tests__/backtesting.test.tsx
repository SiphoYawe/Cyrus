import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type {
  BacktestSummary,
  BacktestDetail,
  EquityPoint,
  DrawdownPoint,
  TradeHistogramBin,
} from '@/hooks/use-backtests';

// ── Mock recharts ──────────────────────────────────────────────────────

vi.mock('recharts', () => {
  const MockResponsiveContainer = ({ children }: { children: React.ReactNode }) => (
    <div data-testid="responsive-container">{children}</div>
  );
  const MockAreaChart = ({ children }: { children: React.ReactNode }) => (
    <div data-testid="area-chart">{children}</div>
  );
  const MockBarChart = ({ children }: { children: React.ReactNode }) => (
    <div data-testid="bar-chart">{children}</div>
  );
  const MockArea = () => <div data-testid="chart-area" />;
  const MockBar = ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="chart-bar">{children}</div>
  );
  const MockXAxis = () => <div data-testid="x-axis" />;
  const MockYAxis = () => <div data-testid="y-axis" />;
  const MockCartesianGrid = () => <div data-testid="cartesian-grid" />;
  const MockTooltip = () => <div data-testid="tooltip" />;
  const MockLegend = () => <div data-testid="legend" />;
  const MockCell = () => <div data-testid="cell" />;

  return {
    ResponsiveContainer: MockResponsiveContainer,
    AreaChart: MockAreaChart,
    BarChart: MockBarChart,
    Area: MockArea,
    Bar: MockBar,
    XAxis: MockXAxis,
    YAxis: MockYAxis,
    CartesianGrid: MockCartesianGrid,
    Tooltip: MockTooltip,
    Legend: MockLegend,
    Cell: MockCell,
  };
});

// ── Mock hooks ─────────────────────────────────────────────────────────

vi.mock('@/hooks/use-backtests', () => ({
  useBacktests: vi.fn(),
  useBacktestDetail: vi.fn(),
  useBacktestComparison: vi.fn(),
}));

import { useBacktests, useBacktestDetail, useBacktestComparison } from '@/hooks/use-backtests';
import { BacktestList } from '../backtest-list';
import { BacktestDetailSheet } from '../backtest-detail-sheet';
import { ComparisonView } from '../comparison-view';
import { EquityCurveChart } from '../equity-curve-chart';
import { DrawdownChart } from '../drawdown-chart';
import { TradeHistogram } from '../trade-histogram';
import BacktestingPage from '../../../app/(dashboard)/backtesting/page';

// ── Factories ──────────────────────────────────────────────────────────

const makeSummary = (overrides: Partial<BacktestSummary> = {}): BacktestSummary => ({
  id: 'bt-1',
  strategy: 'YieldHunter',
  dateFrom: '2024-01-01',
  dateTo: '2024-03-01',
  sharpe: 1.42,
  sortino: 1.85,
  totalReturn: 12.5,
  maxDrawdown: -8.3,
  winRate: 64.2,
  totalTrades: 48,
  avgTradePnl: 26.04,
  createdAt: 1709251200000,
  ...overrides,
});

const makeDetail = (overrides: Partial<BacktestDetail> = {}): BacktestDetail => ({
  ...makeSummary(),
  equityCurve: [
    { date: '2024-01-01', value: 10000 },
    { date: '2024-01-15', value: 10500 },
    { date: '2024-02-01', value: 11000 },
    { date: '2024-03-01', value: 11250 },
  ],
  drawdownCurve: [
    { date: '2024-01-01', drawdown: 0 },
    { date: '2024-01-15', drawdown: -2.1 },
    { date: '2024-02-01', drawdown: -4.5 },
    { date: '2024-03-01', drawdown: -1.2 },
  ],
  tradeDistribution: [
    { range: '-$100 to -$50', count: 3, isPositive: false },
    { range: '-$50 to $0', count: 8, isPositive: false },
    { range: '$0 to $50', count: 20, isPositive: true },
    { range: '$50 to $100', count: 12, isPositive: true },
    { range: '$100+', count: 5, isPositive: true },
  ],
  params: { slippage: 0.005, interval: '1h', lookback: 14 },
  ...overrides,
});

// ── Tests ──────────────────────────────────────────────────────────────

describe('BacktestList', () => {
  it('renders empty state when no backtests exist', () => {
    render(
      <BacktestList
        backtests={[]}
        isLoading={false}
        selectedIds={new Set()}
        onToggleSelect={vi.fn()}
        onRowClick={vi.fn()}
      />
    );

    expect(screen.getByText('No backtests yet')).toBeInTheDocument();
    expect(
      screen.getByText(/Run a backtest from the agent CLI/)
    ).toBeInTheDocument();
  });

  it('renders loading skeletons when loading', () => {
    render(
      <BacktestList
        backtests={[]}
        isLoading={true}
        selectedIds={new Set()}
        onToggleSelect={vi.fn()}
        onRowClick={vi.fn()}
      />
    );

    expect(screen.getByTestId('backtest-loading')).toBeInTheDocument();
  });

  it('renders backtest rows with strategy names', () => {
    const backtests = [
      makeSummary({ id: 'bt-1', strategy: 'YieldHunter' }),
      makeSummary({ id: 'bt-2', strategy: 'CrossChainArb' }),
    ];

    render(
      <BacktestList
        backtests={backtests}
        isLoading={false}
        selectedIds={new Set()}
        onToggleSelect={vi.fn()}
        onRowClick={vi.fn()}
      />
    );

    expect(screen.getByText('YieldHunter')).toBeInTheDocument();
    expect(screen.getByText('CrossChainArb')).toBeInTheDocument();
  });

  it('renders Sharpe ratio values', () => {
    const backtests = [makeSummary({ id: 'bt-1', sharpe: 1.42 })];

    render(
      <BacktestList
        backtests={backtests}
        isLoading={false}
        selectedIds={new Set()}
        onToggleSelect={vi.fn()}
        onRowClick={vi.fn()}
      />
    );

    expect(screen.getByText('1.42')).toBeInTheDocument();
  });

  it('renders return badge with correct sign', () => {
    const backtests = [makeSummary({ id: 'bt-1', totalReturn: 12.5 })];

    render(
      <BacktestList
        backtests={backtests}
        isLoading={false}
        selectedIds={new Set()}
        onToggleSelect={vi.fn()}
        onRowClick={vi.fn()}
      />
    );

    expect(screen.getByText('+12.5%')).toBeInTheDocument();
  });

  it('calls onRowClick when a row is clicked', () => {
    const onRowClick = vi.fn();
    const backtests = [makeSummary({ id: 'bt-1' })];

    render(
      <BacktestList
        backtests={backtests}
        isLoading={false}
        selectedIds={new Set()}
        onToggleSelect={vi.fn()}
        onRowClick={onRowClick}
      />
    );

    fireEvent.click(screen.getByTestId('backtest-row-bt-1'));
    expect(onRowClick).toHaveBeenCalledWith('bt-1');
  });

  it('calls onToggleSelect when checkbox is clicked', () => {
    const onToggleSelect = vi.fn();
    const backtests = [makeSummary({ id: 'bt-1', strategy: 'YieldHunter' })];

    render(
      <BacktestList
        backtests={backtests}
        isLoading={false}
        selectedIds={new Set()}
        onToggleSelect={onToggleSelect}
        onRowClick={vi.fn()}
      />
    );

    const checkbox = screen.getByRole('checkbox', {
      name: /Select YieldHunter backtest for comparison/i,
    });
    fireEvent.click(checkbox);
    expect(onToggleSelect).toHaveBeenCalledWith('bt-1');
  });

  it('disables checkbox when max compare reached and item not selected', () => {
    const backtests = [
      makeSummary({ id: 'bt-1', strategy: 'A' }),
      makeSummary({ id: 'bt-2', strategy: 'B' }),
      makeSummary({ id: 'bt-3', strategy: 'C' }),
      makeSummary({ id: 'bt-4', strategy: 'D' }),
      makeSummary({ id: 'bt-5', strategy: 'E' }),
    ];

    render(
      <BacktestList
        backtests={backtests}
        isLoading={false}
        selectedIds={new Set(['bt-1', 'bt-2', 'bt-3', 'bt-4'])}
        onToggleSelect={vi.fn()}
        onRowClick={vi.fn()}
      />
    );

    const cbE = screen.getByRole('checkbox', {
      name: /Select E backtest for comparison/i,
    });
    expect(cbE).toBeDisabled();
  });

  it('sorts by strategy name when column header clicked', () => {
    const backtests = [
      makeSummary({ id: 'bt-1', strategy: 'Zeta' }),
      makeSummary({ id: 'bt-2', strategy: 'Alpha' }),
    ];

    render(
      <BacktestList
        backtests={backtests}
        isLoading={false}
        selectedIds={new Set()}
        onToggleSelect={vi.fn()}
        onRowClick={vi.fn()}
      />
    );

    const strategyBtn = screen.getByRole('button', { name: /Strategy/i });
    fireEvent.click(strategyBtn); // first click -> desc
    fireEvent.click(strategyBtn); // second click -> asc

    const rows = screen.getAllByText(/Alpha|Zeta/);
    expect(rows[0].textContent).toBe('Alpha');
    expect(rows[1].textContent).toBe('Zeta');
  });
});

describe('BacktestDetailSheet', () => {
  it('renders detail sheet with strategy name and stats', () => {
    const detail = makeDetail();

    render(
      <BacktestDetailSheet
        detail={detail}
        open={true}
        onOpenChange={vi.fn()}
        isLoading={false}
      />
    );

    expect(screen.getByText('YieldHunter')).toBeInTheDocument();
    expect(screen.getByText('+12.50%')).toBeInTheDocument();
    expect(screen.getByText('1.42')).toBeInTheDocument();
    expect(screen.getByText('1.85')).toBeInTheDocument();
    expect(screen.getByText('-8.30%')).toBeInTheDocument();
    expect(screen.getByText('64.2%')).toBeInTheDocument();
    expect(screen.getByText('$26.04')).toBeInTheDocument();
    expect(screen.getByText('48')).toBeInTheDocument();
  });

  it('renders charts section titles', () => {
    const detail = makeDetail();

    render(
      <BacktestDetailSheet
        detail={detail}
        open={true}
        onOpenChange={vi.fn()}
        isLoading={false}
      />
    );

    expect(screen.getByText('Equity Curve')).toBeInTheDocument();
    expect(screen.getByText('Drawdown')).toBeInTheDocument();
    expect(screen.getByText('Trade P&L Distribution')).toBeInTheDocument();
  });

  it('renders parameters table', () => {
    const detail = makeDetail();

    render(
      <BacktestDetailSheet
        detail={detail}
        open={true}
        onOpenChange={vi.fn()}
        isLoading={false}
      />
    );

    expect(screen.getByText('slippage')).toBeInTheDocument();
    expect(screen.getByText('0.005')).toBeInTheDocument();
    expect(screen.getByText('interval')).toBeInTheDocument();
    expect(screen.getByText('1h')).toBeInTheDocument();
  });

  it('renders skeletons when loading', () => {
    render(
      <BacktestDetailSheet
        detail={null}
        open={true}
        onOpenChange={vi.fn()}
        isLoading={true}
      />
    );

    const skeletons = document.querySelectorAll('[class*="animate-pulse"]');
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it('renders empty message when no detail', () => {
    render(
      <BacktestDetailSheet
        detail={null}
        open={true}
        onOpenChange={vi.fn()}
        isLoading={false}
      />
    );

    expect(screen.getByText('Select a backtest to view details')).toBeInTheDocument();
  });
});

describe('EquityCurveChart', () => {
  it('renders empty state when no data', () => {
    render(<EquityCurveChart data={[]} />);
    expect(screen.getByText('No equity data available')).toBeInTheDocument();
  });

  it('renders chart with data', () => {
    const data: EquityPoint[] = [
      { date: '2024-01-01', value: 10000 },
      { date: '2024-02-01', value: 11000 },
    ];

    render(<EquityCurveChart data={data} />);
    expect(screen.getByTestId('responsive-container')).toBeInTheDocument();
    expect(screen.getByTestId('area-chart')).toBeInTheDocument();
  });
});

describe('DrawdownChart', () => {
  it('renders empty state when no data', () => {
    render(<DrawdownChart data={[]} />);
    expect(screen.getByText('No drawdown data available')).toBeInTheDocument();
  });

  it('renders chart with data', () => {
    const data: DrawdownPoint[] = [
      { date: '2024-01-01', drawdown: 0 },
      { date: '2024-02-01', drawdown: -5.2 },
    ];

    render(<DrawdownChart data={data} />);
    expect(screen.getByTestId('responsive-container')).toBeInTheDocument();
    expect(screen.getByTestId('area-chart')).toBeInTheDocument();
  });
});

describe('TradeHistogram', () => {
  it('renders empty state when no data', () => {
    render(<TradeHistogram data={[]} />);
    expect(screen.getByText('No trade data available')).toBeInTheDocument();
  });

  it('renders chart with data', () => {
    const data: TradeHistogramBin[] = [
      { range: '-$50 to $0', count: 5, isPositive: false },
      { range: '$0 to $50', count: 12, isPositive: true },
    ];

    render(<TradeHistogram data={data} />);
    expect(screen.getByTestId('responsive-container')).toBeInTheDocument();
    expect(screen.getByTestId('bar-chart')).toBeInTheDocument();
  });
});

describe('ComparisonView', () => {
  it('renders empty state when no details', () => {
    render(
      <ComparisonView details={[]} isLoading={false} onClose={vi.fn()} />
    );

    expect(screen.getByText('No backtests selected')).toBeInTheDocument();
    expect(
      screen.getByText(/Select up to 4 backtests/)
    ).toBeInTheDocument();
  });

  it('renders loading state', () => {
    render(
      <ComparisonView details={[]} isLoading={true} onClose={vi.fn()} />
    );

    expect(screen.getByTestId('comparison-loading')).toBeInTheDocument();
  });

  it('renders comparison with strategy names', () => {
    const details = [
      makeDetail({ id: 'bt-1', strategy: 'YieldHunter' }),
      makeDetail({ id: 'bt-2', strategy: 'CrossChainArb', sharpe: 0.98, totalReturn: 5.2 }),
    ];

    render(
      <ComparisonView details={details} isLoading={false} onClose={vi.fn()} />
    );

    expect(screen.getByText('Comparing 2 Backtests')).toBeInTheDocument();
    // Strategy names appear in the metric headers
    expect(screen.getAllByText('YieldHunter').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('CrossChainArb').length).toBeGreaterThanOrEqual(1);
  });

  it('renders metrics table with comparison values', () => {
    const details = [
      makeDetail({ id: 'bt-1', strategy: 'A', totalReturn: 12.5 }),
      makeDetail({ id: 'bt-2', strategy: 'B', totalReturn: 5.2 }),
    ];

    render(
      <ComparisonView details={details} isLoading={false} onClose={vi.fn()} />
    );

    expect(screen.getByText('Metrics')).toBeInTheDocument();
    expect(screen.getByText('Return')).toBeInTheDocument();
    expect(screen.getByText('Sharpe')).toBeInTheDocument();
  });

  it('renders parameter diff table', () => {
    const details = [
      makeDetail({ id: 'bt-1', strategy: 'A', params: { slippage: 0.005 } }),
      makeDetail({ id: 'bt-2', strategy: 'B', params: { slippage: 0.01 } }),
    ];

    render(
      <ComparisonView details={details} isLoading={false} onClose={vi.fn()} />
    );

    expect(screen.getByText('Parameter Differences')).toBeInTheDocument();
    expect(screen.getByText('slippage')).toBeInTheDocument();
  });

  it('calls onClose when clear comparison is clicked', () => {
    const onClose = vi.fn();
    const details = [
      makeDetail({ id: 'bt-1' }),
      makeDetail({ id: 'bt-2' }),
    ];

    render(
      <ComparisonView details={details} isLoading={false} onClose={onClose} />
    );

    fireEvent.click(screen.getByText('Clear comparison'));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe('BacktestingPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders page title', () => {
    vi.mocked(useBacktests).mockReturnValue({
      backtests: [],
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });
    vi.mocked(useBacktestDetail).mockReturnValue({
      detail: null,
      isLoading: false,
      error: null,
    });
    vi.mocked(useBacktestComparison).mockReturnValue({
      details: [],
      isLoading: false,
      error: null,
    });

    render(<BacktestingPage />);
    expect(screen.getByText('Backtesting')).toBeInTheDocument();
  });

  it('renders empty state when no backtests', () => {
    vi.mocked(useBacktests).mockReturnValue({
      backtests: [],
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });
    vi.mocked(useBacktestDetail).mockReturnValue({
      detail: null,
      isLoading: false,
      error: null,
    });
    vi.mocked(useBacktestComparison).mockReturnValue({
      details: [],
      isLoading: false,
      error: null,
    });

    render(<BacktestingPage />);
    expect(screen.getByText('No backtests yet')).toBeInTheDocument();
  });

  it('renders backtests count badge', () => {
    const backtests = [makeSummary({ id: 'bt-1' }), makeSummary({ id: 'bt-2' })];
    vi.mocked(useBacktests).mockReturnValue({
      backtests,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });
    vi.mocked(useBacktestDetail).mockReturnValue({
      detail: null,
      isLoading: false,
      error: null,
    });
    vi.mocked(useBacktestComparison).mockReturnValue({
      details: [],
      isLoading: false,
      error: null,
    });

    render(<BacktestingPage />);
    expect(screen.getByLabelText('2 backtests')).toBeInTheDocument();
  });

  it('renders backtest list with strategy names', () => {
    const backtests = [
      makeSummary({ id: 'bt-1', strategy: 'YieldHunter' }),
      makeSummary({ id: 'bt-2', strategy: 'CrossChainArb' }),
    ];
    vi.mocked(useBacktests).mockReturnValue({
      backtests,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });
    vi.mocked(useBacktestDetail).mockReturnValue({
      detail: null,
      isLoading: false,
      error: null,
    });
    vi.mocked(useBacktestComparison).mockReturnValue({
      details: [],
      isLoading: false,
      error: null,
    });

    render(<BacktestingPage />);
    expect(screen.getByText('YieldHunter')).toBeInTheDocument();
    expect(screen.getByText('CrossChainArb')).toBeInTheDocument();
  });
});
