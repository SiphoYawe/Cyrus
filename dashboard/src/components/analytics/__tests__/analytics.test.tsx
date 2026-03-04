import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

// ── Mock lightweight-charts (canvas-based, not usable in jsdom) ──────
vi.mock('lightweight-charts', () => ({
  createChart: vi.fn(() => ({
    addSeries: vi.fn(() => ({
      setData: vi.fn(),
    })),
    timeScale: vi.fn(() => ({
      fitContent: vi.fn(),
    })),
    applyOptions: vi.fn(),
    remove: vi.fn(),
  })),
  CandlestickSeries: {},
  createSeriesMarkers: vi.fn(),
  ColorType: { Solid: 'solid' },
}));

// ── Mock recharts to render plain DOM for testing ──────────────────
vi.mock('recharts', () => ({
  Treemap: ({ data }: { data: unknown[] }) => (
    <div data-testid="recharts-treemap">{JSON.stringify(data)}</div>
  ),
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="recharts-responsive">{children}</div>
  ),
}));

// ── Imports (after mocks) ─────────────────────────────────────────
import { ChartSkeleton } from '@/components/analytics/chart-skeleton';
import { PriceChart } from '@/components/analytics/price-chart';
import { PortfolioTreemap } from '@/components/analytics/portfolio-treemap';
import { CorrelationMatrix } from '@/components/analytics/correlation-matrix';
import { RiskMetricsPanel } from '@/components/analytics/risk-metrics-panel';
import {
  calculateSharpeRatio,
  calculateSortinoRatio,
  calculateMaxDrawdown,
  calculateVaR,
} from '@/hooks/use-analytics-data';
import type {
  PriceHistory,
  AllocationNode,
  CorrelationData,
  RiskMetrics,
} from '@/hooks/use-analytics-data';

// ── Fixtures ─────────────────────────────────────────────────────

const mockPriceHistory: PriceHistory = {
  symbol: 'ETH',
  candles: [
    { time: '2025-01-01', open: 3000, high: 3100, low: 2950, close: 3050 },
    { time: '2025-01-02', open: 3050, high: 3200, low: 3020, close: 3150 },
    { time: '2025-01-03', open: 3150, high: 3180, low: 3050, close: 3080 },
  ],
  markers: [
    {
      time: '2025-01-01',
      position: 'belowBar',
      color: '#22C55E',
      shape: 'arrowUp',
      text: 'BUY',
    },
    {
      time: '2025-01-03',
      position: 'aboveBar',
      color: '#EF4444',
      shape: 'arrowDown',
      text: 'SELL',
    },
  ],
};

const mockAllocations: AllocationNode[] = [
  { name: 'Ethereum', symbol: 'ETH', value: 45000, change24h: 2.3 },
  { name: 'Bitcoin', symbol: 'BTC', value: 30000, change24h: -0.8 },
  { name: 'Arbitrum', symbol: 'ARB', value: 12000, change24h: 5.1 },
];

const mockCorrelation: CorrelationData = {
  assets: ['ETH', 'BTC', 'ARB'],
  matrix: [
    [1.0, 0.85, 0.72],
    [0.85, 1.0, 0.65],
    [0.72, 0.65, 1.0],
  ],
};

const mockRiskMetrics: RiskMetrics = {
  sharpeRatio: 1.85,
  sortinoRatio: 2.42,
  maxDrawdown: 0.127,
  var95: 2340,
  var99: 4120,
  annualizedReturn: 0.342,
  annualizedVolatility: 0.185,
  calmarRatio: 2.69,
  winRate: 0.63,
  profitFactor: 1.72,
};

// ═══════════════════════════════════════════════════════════════════
// ChartSkeleton Tests
// ═══════════════════════════════════════════════════════════════════

describe('ChartSkeleton', () => {
  it('renders price chart skeleton', () => {
    render(<ChartSkeleton variant="price" />);
    expect(screen.getByTestId('price-chart-skeleton')).toBeInTheDocument();
  });

  it('renders treemap skeleton', () => {
    render(<ChartSkeleton variant="treemap" />);
    expect(screen.getByTestId('treemap-skeleton')).toBeInTheDocument();
  });

  it('renders matrix skeleton', () => {
    render(<ChartSkeleton variant="matrix" />);
    expect(screen.getByTestId('matrix-skeleton')).toBeInTheDocument();
  });

  it('renders metrics skeleton', () => {
    render(<ChartSkeleton variant="metrics" />);
    expect(screen.getByTestId('metrics-skeleton')).toBeInTheDocument();
  });

  it('defaults to price variant', () => {
    render(<ChartSkeleton />);
    expect(screen.getByTestId('price-chart-skeleton')).toBeInTheDocument();
  });
});

// ═══════════════════════════════════════════════════════════════════
// PriceChart Tests
// ═══════════════════════════════════════════════════════════════════

describe('PriceChart', () => {
  it('renders chart container', () => {
    render(<PriceChart data={mockPriceHistory} />);
    expect(screen.getByTestId('price-chart-container')).toBeInTheDocument();
  });

  it('displays the symbol name', () => {
    render(<PriceChart data={mockPriceHistory} />);
    expect(screen.getByText('Price Chart')).toBeInTheDocument();
    expect(
      screen.getByText('ETH candlestick with trade entry/exit markers')
    ).toBeInTheDocument();
  });

  it('calls createChart from lightweight-charts', async () => {
    const lwc = await import('lightweight-charts');
    render(<PriceChart data={mockPriceHistory} />);
    expect(lwc.createChart).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════
// PortfolioTreemap Tests
// ═══════════════════════════════════════════════════════════════════

describe('PortfolioTreemap', () => {
  it('renders treemap container', () => {
    render(<PortfolioTreemap data={mockAllocations} />);
    expect(screen.getByTestId('portfolio-treemap')).toBeInTheDocument();
  });

  it('renders card header with title', () => {
    render(<PortfolioTreemap data={mockAllocations} />);
    expect(screen.getByText('Portfolio Heatmap')).toBeInTheDocument();
    expect(
      screen.getByText('Allocation size with 24h performance tinting')
    ).toBeInTheDocument();
  });

  it('passes data to Recharts Treemap', () => {
    render(<PortfolioTreemap data={mockAllocations} />);
    const treemap = screen.getByTestId('recharts-treemap');
    expect(treemap.textContent).toContain('ETH');
    expect(treemap.textContent).toContain('BTC');
    expect(treemap.textContent).toContain('ARB');
  });
});

// ═══════════════════════════════════════════════════════════════════
// CorrelationMatrix Tests
// ═══════════════════════════════════════════════════════════════════

describe('CorrelationMatrix', () => {
  it('renders matrix container', () => {
    render(<CorrelationMatrix data={mockCorrelation} />);
    expect(screen.getByTestId('correlation-matrix')).toBeInTheDocument();
  });

  it('renders all asset labels', () => {
    render(<CorrelationMatrix data={mockCorrelation} />);
    // Column headers + row headers = 2 x each asset
    const ethElements = screen.getAllByText('ETH');
    expect(ethElements.length).toBeGreaterThanOrEqual(2);
    const btcElements = screen.getAllByText('BTC');
    expect(btcElements.length).toBeGreaterThanOrEqual(2);
  });

  it('renders correlation values in cells', () => {
    render(<CorrelationMatrix data={mockCorrelation} />);
    // Diagonal cells should show 1.00
    const diagonalCells = screen.getAllByText('1.00');
    expect(diagonalCells.length).toBe(3); // 3 assets = 3 diagonal cells
  });

  it('renders off-diagonal correlation values', () => {
    render(<CorrelationMatrix data={mockCorrelation} />);
    // ETH-BTC correlation = 0.85
    const cells085 = screen.getAllByText('0.85');
    expect(cells085.length).toBe(2); // symmetric: (0,1) and (1,0)
  });

  it('renders individual cells with data-testid', () => {
    render(<CorrelationMatrix data={mockCorrelation} />);
    expect(screen.getByTestId('cell-0-0')).toBeInTheDocument();
    expect(screen.getByTestId('cell-1-2')).toBeInTheDocument();
    expect(screen.getByTestId('cell-2-2')).toBeInTheDocument();
  });

  it('renders legend', () => {
    render(<CorrelationMatrix data={mockCorrelation} />);
    expect(screen.getByText('-1.0')).toBeInTheDocument();
    expect(screen.getByText('0.0')).toBeInTheDocument();
    expect(screen.getByText('+1.0')).toBeInTheDocument();
  });
});

// ═══════════════════════════════════════════════════════════════════
// RiskMetricsPanel Tests
// ═══════════════════════════════════════════════════════════════════

describe('RiskMetricsPanel', () => {
  it('renders panel container', () => {
    render(<RiskMetricsPanel data={mockRiskMetrics} />);
    expect(screen.getByTestId('risk-metrics-panel')).toBeInTheDocument();
  });

  it('displays all metric labels', () => {
    render(<RiskMetricsPanel data={mockRiskMetrics} />);
    expect(screen.getByText('Sharpe Ratio')).toBeInTheDocument();
    expect(screen.getByText('Sortino Ratio')).toBeInTheDocument();
    expect(screen.getByText('Max Drawdown')).toBeInTheDocument();
    expect(screen.getByText('VaR (95%)')).toBeInTheDocument();
    expect(screen.getByText('VaR (99%)')).toBeInTheDocument();
    expect(screen.getByText('Annualized Return')).toBeInTheDocument();
    expect(screen.getByText('Annualized Vol')).toBeInTheDocument();
    expect(screen.getByText('Calmar Ratio')).toBeInTheDocument();
    expect(screen.getByText('Win Rate')).toBeInTheDocument();
    expect(screen.getByText('Profit Factor')).toBeInTheDocument();
  });

  it('displays formatted metric values', () => {
    render(<RiskMetricsPanel data={mockRiskMetrics} />);
    // Sharpe Ratio = 1.85
    expect(screen.getByText('1.85')).toBeInTheDocument();
    // Sortino Ratio = 2.42
    expect(screen.getByText('2.42')).toBeInTheDocument();
    // Max Drawdown = 0.127 -> 12.7%
    expect(screen.getByText('12.7%')).toBeInTheDocument();
  });

  it('displays VaR values in USD', () => {
    render(<RiskMetricsPanel data={mockRiskMetrics} />);
    expect(screen.getByText('$2,340')).toBeInTheDocument();
    expect(screen.getByText('$4,120')).toBeInTheDocument();
  });

  it('renders card header', () => {
    render(<RiskMetricsPanel data={mockRiskMetrics} />);
    expect(screen.getByText('Risk Metrics')).toBeInTheDocument();
    expect(
      screen.getByText('Portfolio risk analysis and performance ratios')
    ).toBeInTheDocument();
  });
});

// ═══════════════════════════════════════════════════════════════════
// Risk Metric Calculations (Pure Function Tests)
// ═══════════════════════════════════════════════════════════════════

describe('calculateSharpeRatio', () => {
  it('returns 0 for empty array', () => {
    expect(calculateSharpeRatio([])).toBe(0);
  });

  it('returns 0 for single element', () => {
    expect(calculateSharpeRatio([0.05])).toBe(0);
  });

  it('calculates correctly for positive returns', () => {
    const returns = [0.01, 0.02, 0.015, 0.025, 0.01];
    const result = calculateSharpeRatio(returns);
    // mean = 0.016, stdDev = ~0.00632, sharpe = 0.016 / 0.00632 ~ 2.53
    expect(result).toBeGreaterThan(2);
    expect(result).toBeLessThan(3);
  });

  it('handles zero standard deviation', () => {
    const returns = [0.01, 0.01, 0.01];
    expect(calculateSharpeRatio(returns)).toBe(0);
  });

  it('accounts for risk-free rate', () => {
    const returns = [0.01, 0.02, 0.015, 0.025, 0.01];
    const withRf = calculateSharpeRatio(returns, 0.01);
    const withoutRf = calculateSharpeRatio(returns, 0);
    expect(withRf).toBeLessThan(withoutRf);
  });
});

describe('calculateSortinoRatio', () => {
  it('returns 0 for empty array', () => {
    expect(calculateSortinoRatio([])).toBe(0);
  });

  it('returns Infinity when no downside returns', () => {
    const returns = [0.01, 0.02, 0.03];
    expect(calculateSortinoRatio(returns)).toBe(Infinity);
  });

  it('is greater than or equal to Sharpe when mean > 0', () => {
    const returns = [0.02, -0.01, 0.03, -0.005, 0.015, 0.01];
    const sharpe = calculateSharpeRatio(returns);
    const sortino = calculateSortinoRatio(returns);
    expect(sortino).toBeGreaterThanOrEqual(sharpe);
  });
});

describe('calculateMaxDrawdown', () => {
  it('returns 0 for empty array', () => {
    expect(calculateMaxDrawdown([])).toBe(0);
  });

  it('returns 0 for always increasing equity', () => {
    expect(calculateMaxDrawdown([100, 110, 120, 130])).toBe(0);
  });

  it('calculates correct drawdown', () => {
    const equity = [100, 120, 90, 110, 80];
    // Peak at 120, trough at 80 = (120-80)/120 = 0.333
    const dd = calculateMaxDrawdown(equity);
    expect(dd).toBeCloseTo(0.333, 2);
  });

  it('finds the maximum drawdown, not the last', () => {
    const equity = [100, 200, 100, 150, 120];
    // Biggest: 200 -> 100 = 50%
    expect(calculateMaxDrawdown(equity)).toBeCloseTo(0.5, 2);
  });
});

describe('calculateVaR', () => {
  it('returns 0 for empty array', () => {
    expect(calculateVaR([], 100000, 0.95)).toBe(0);
  });

  it('calculates historical VaR at 95% confidence', () => {
    // 20 sorted returns, 5th percentile = index 1
    const returns = Array.from({ length: 20 }, (_, i) => (i - 10) / 100);
    // sorted: -0.10, -0.09, ..., +0.09
    const portfolioValue = 100000;
    const var95 = calculateVaR(returns, portfolioValue, 0.95);
    // 5% of 20 = 1, index 1 = -0.09 -> 9000
    expect(var95).toBeGreaterThan(0);
    expect(var95).toBeLessThan(portfolioValue);
  });

  it('VaR at 99% is >= VaR at 95%', () => {
    const returns = Array.from({ length: 100 }, (_, i) => (i - 50) / 100);
    const portfolioValue = 100000;
    const var95 = calculateVaR(returns, portfolioValue, 0.95);
    const var99 = calculateVaR(returns, portfolioValue, 0.99);
    expect(var99).toBeGreaterThanOrEqual(var95);
  });
});
