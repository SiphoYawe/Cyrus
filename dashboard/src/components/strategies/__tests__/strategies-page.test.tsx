import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { Strategy } from '@/stores/strategies-store';
import { useStrategiesStore } from '@/stores/strategies-store';

// Mock hooks
vi.mock('@/hooks/use-strategies', () => ({
  useStrategies: vi.fn(),
}));

vi.mock('@/hooks/use-strategy-detail', () => ({
  useStrategyDetail: vi.fn(),
}));

vi.mock('@/providers/ws-provider', () => ({
  useWebSocket: vi.fn(() => ({
    status: 'connected',
    send: vi.fn(),
  })),
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

import { useStrategies } from '@/hooks/use-strategies';
import { useStrategyDetail } from '@/hooks/use-strategy-detail';
import { useWebSocket } from '@/providers/ws-provider';
import { toast } from 'sonner';
import StrategiesPage from '../../../app/(dashboard)/strategies/page';

const makeStrategy = (overrides: Partial<Strategy> = {}): Strategy => ({
  name: 'YieldHunter',
  enabled: true,
  tier: 'Growth',
  metrics: {
    totalPnl: 800.00,
    winRate: 68.0,
    totalTrades: 30,
    openPositions: 2,
    lastSignalAt: Date.now() - 60 * 60 * 1000,
    performanceHistory: [],
  },
  params: [],
  ...overrides,
});

const defaultDetailHookResult = {
  data: null,
  isLoading: false,
  error: null,
  timeRange: '1M' as const,
  setTimeRange: vi.fn(),
  filteredHistory: [],
  decisionReports: [],
};

describe('StrategiesPage', () => {
  const mockSend = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useWebSocket).mockReturnValue({
      status: 'connected',
      send: mockSend,
    });
    vi.mocked(useStrategyDetail).mockReturnValue(defaultDetailHookResult);
    // Reset store
    useStrategiesStore.setState({
      strategies: [],
      isLoading: false,
      setStrategies: useStrategiesStore.getState().setStrategies,
      setLoading: useStrategiesStore.getState().setLoading,
      toggleStrategy: useStrategiesStore.getState().toggleStrategy,
      handleWsEvent: useStrategiesStore.getState().handleWsEvent,
    });
  });

  it('renders page header with Strategies title', () => {
    vi.mocked(useStrategies).mockReturnValue({
      strategies: [],
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });
    render(<StrategiesPage />);
    expect(screen.getByText('Strategies')).toBeInTheDocument();
  });

  it('renders count badge with correct strategy count', () => {
    const strategies = [makeStrategy(), makeStrategy({ name: 'CrossChainArb', tier: 'Degen' })];
    vi.mocked(useStrategies).mockReturnValue({
      strategies,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });
    useStrategiesStore.setState((s) => ({ ...s, strategies }));
    render(<StrategiesPage />);
    expect(screen.getByLabelText('2 strategies loaded')).toBeInTheDocument();
  });

  it('renders empty state when no strategies', () => {
    vi.mocked(useStrategies).mockReturnValue({
      strategies: [],
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });
    render(<StrategiesPage />);
    expect(screen.getByText('No strategies loaded')).toBeInTheDocument();
  });

  it('renders documentation link in empty state', () => {
    vi.mocked(useStrategies).mockReturnValue({
      strategies: [],
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });
    render(<StrategiesPage />);
    expect(screen.getByText('Read strategy documentation')).toBeInTheDocument();
  });

  it('renders skeleton loaders while loading', () => {
    vi.mocked(useStrategies).mockReturnValue({
      strategies: [],
      isLoading: true,
      error: null,
      refetch: vi.fn(),
    });
    render(<StrategiesPage />);
    const skeletons = document.querySelectorAll('[class*="animate-pulse"]');
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it('renders strategy cards for each strategy', () => {
    const strategies = [
      makeStrategy({ name: 'YieldHunter' }),
      makeStrategy({ name: 'CrossChainArb', tier: 'Degen' }),
      makeStrategy({ name: 'StableYield', tier: 'Safe' }),
    ];
    vi.mocked(useStrategies).mockReturnValue({
      strategies,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });
    useStrategiesStore.setState((s) => ({ ...s, strategies }));
    render(<StrategiesPage />);
    expect(screen.getByText('YieldHunter')).toBeInTheDocument();
    expect(screen.getByText('CrossChainArb')).toBeInTheDocument();
    expect(screen.getByText('StableYield')).toBeInTheDocument();
  });

  it('opens detail sheet when strategy card is clicked', () => {
    const strategies = [makeStrategy()];
    vi.mocked(useStrategies).mockReturnValue({
      strategies,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });
    useStrategiesStore.setState((s) => ({ ...s, strategies }));
    render(<StrategiesPage />);

    const cardButton = screen.getByRole('button', { name: /Open YieldHunter strategy details/i });
    fireEvent.click(cardButton);

    // Sheet title should now be visible
    expect(screen.getAllByText('YieldHunter').length).toBeGreaterThanOrEqual(2);
  });

  it('sends strategy.toggle WS command on toggle', () => {
    const strategies = [makeStrategy()];
    vi.mocked(useStrategies).mockReturnValue({
      strategies,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });
    useStrategiesStore.setState((s) => ({ ...s, strategies }));
    render(<StrategiesPage />);

    const switchEl = screen.getByRole('switch', { name: /Toggle YieldHunter strategy off/i });
    fireEvent.click(switchEl);

    expect(mockSend).toHaveBeenCalledWith({
      command: 'strategy.toggle',
      payload: { strategy: 'YieldHunter', enabled: false },
    });
  });

  it('shows success toast on toggle', () => {
    const strategies = [makeStrategy({ enabled: false })];
    vi.mocked(useStrategies).mockReturnValue({
      strategies,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });
    useStrategiesStore.setState((s) => ({ ...s, strategies }));
    render(<StrategiesPage />);

    const switchEl = screen.getByRole('switch', { name: /Toggle YieldHunter strategy on/i });
    fireEvent.click(switchEl);

    expect(toast.success).toHaveBeenCalledWith('Strategy YieldHunter enabled');
  });

  it('renders grid with responsive classes', () => {
    const strategies = [makeStrategy()];
    vi.mocked(useStrategies).mockReturnValue({
      strategies,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });
    useStrategiesStore.setState((s) => ({ ...s, strategies }));
    const { container } = render(<StrategiesPage />);

    const grid = container.querySelector('.grid');
    expect(grid?.className).toContain('grid-cols-1');
    expect(grid?.className).toContain('sm:grid-cols-2');
    expect(grid?.className).toContain('xl:grid-cols-3');
  });
});
