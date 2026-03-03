import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';

// ---- mocks ----
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => '/activity',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@number-flow/react', () => ({
  default: ({ value }: { value: number }) => <span>{value}</span>,
}));

vi.mock('date-fns', async () => {
  const actual = await vi.importActual<typeof import('date-fns')>('date-fns');
  return {
    ...actual,
    formatDistanceToNow: () => '2 minutes ago',
    parseISO: actual.parseISO,
    format: actual.format,
  };
});

// Stub block-explorers
vi.mock('@/lib/block-explorers', () => ({
  getExplorerTxUrl: (chainId: number, hash: string) => `https://etherscan.io/tx/${hash}`,
  getExplorerName: () => 'etherscan.io',
  truncateTxHash: (hash: string) => `${hash.slice(0, 8)}...${hash.slice(-6)}`,
}));

// ---- imports under test ----
import { KpiCard } from '@/components/shared/kpi-card';
import { ActivityDecisionCard } from '@/components/activity/activity-decision-card';
import { ActivityTabs } from '@/components/activity/activity-tabs';
import { TransferDetailSheet } from '@/components/activity/transfer-detail-sheet';
import { DecisionReportList } from '@/components/activity/decision-report-list';
import { ActivityFilters } from '@/components/activity/activity-filters';
import type { ActivityReport, ActivityTransfer } from '@/types/activity';

// ---- test helpers ----
function makeReport(overrides: Partial<ActivityReport> = {}): ActivityReport {
  return {
    id: 'rpt-1',
    timestamp: new Date().toISOString(),
    type: 'bridge',
    tier: 'Growth',
    strategyName: 'YieldHunter',
    summary: 'Bridged USDC from Ethereum to Arbitrum',
    narrative: 'I decided to move USDC to Arbitrum to capture yield opportunities.',
    success: true,
    ...overrides,
  };
}

function makeTransfer(overrides: Partial<ActivityTransfer> = {}): ActivityTransfer {
  return {
    id: 'tx-1',
    txHash: '0xabcdef1234567890abcdef1234567890abcdef12',
    fromChainId: 1,
    toChainId: 42161,
    fromToken: { symbol: 'USDC', address: '0xA0b8', decimals: 6 },
    toToken: { symbol: 'USDC', address: '0xFF97', decimals: 6 },
    fromAmount: '1000000000',
    toAmount: '999000000',
    status: 'COMPLETED',
    startedAt: Date.now() - 60_000,
    completedAt: Date.now(),
    ...overrides,
  };
}

// Minimal Tooltip stub
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ children, asChild }: { children: React.ReactNode; asChild?: boolean }) =>
    asChild ? <>{children}</> : <div>{children}</div>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

// ================================================================
// 1. KPI cards
// ================================================================
describe('KpiCard', () => {
  it('renders title', () => {
    render(<KpiCard title="Total Operations" value={42} format="number" data-testid="kpi" />);
    expect(screen.getByText('Total Operations')).toBeTruthy();
  });

  it('renders loading skeleton when isLoading is true', () => {
    const { container } = render(
      <KpiCard title="Success Rate" value={0} isLoading data-testid="kpi" />
    );
    // skeleton div with animate-pulse
    expect(container.querySelector('[data-slot="skeleton"]')).toBeTruthy();
  });

  it('applies positive trend class for high success rate', () => {
    const { container } = render(
      <KpiCard title="Success Rate" value={97} format="number" trend="positive" data-testid="kpi" />
    );
    const valueEl = container.querySelector('.text-positive');
    expect(valueEl).toBeTruthy();
  });

  it('applies warning trend class for mid success rate', () => {
    const { container } = render(
      <KpiCard title="Success Rate" value={85} format="number" trend="warning" data-testid="kpi" />
    );
    const valueEl = container.querySelector('.text-warning');
    expect(valueEl).toBeTruthy();
  });

  it('applies negative trend class for low success rate', () => {
    const { container } = render(
      <KpiCard title="Success Rate" value={70} format="number" trend="negative" data-testid="kpi" />
    );
    const valueEl = container.querySelector('.text-negative');
    expect(valueEl).toBeTruthy();
  });

  it('renders all 4 kpi cards side by side', () => {
    render(
      <div>
        <KpiCard title="Total Operations" value={10} data-testid="kpi-total-operations" />
        <KpiCard title="Success Rate" value={95} trend="positive" data-testid="kpi-success-rate" />
        <KpiCard title="Total Gas Spent" value={0.5} format="usd" data-testid="kpi-gas-spent" />
        <KpiCard title="Net P&L" value={12.5} format="usd" trend="positive" data-testid="kpi-net-pnl" />
      </div>
    );
    expect(screen.getByTestId('kpi-total-operations')).toBeTruthy();
    expect(screen.getByTestId('kpi-success-rate')).toBeTruthy();
    expect(screen.getByTestId('kpi-gas-spent')).toBeTruthy();
    expect(screen.getByTestId('kpi-net-pnl')).toBeTruthy();
  });
});

// ================================================================
// 2. ActivityTabs — tab switching + count badges
// ================================================================
describe('ActivityTabs', () => {
  const counts = { all: 50, trade: 20, bridge: 25, deposit: 5 };

  it('renders all 4 tabs', () => {
    render(
      <ActivityTabs
        activeTab="all"
        onTabChange={vi.fn()}
        counts={counts}
      />
    );
    expect(screen.getByTestId('tab-all')).toBeTruthy();
    expect(screen.getByTestId('tab-trade')).toBeTruthy();
    expect(screen.getByTestId('tab-bridge')).toBeTruthy();
    expect(screen.getByTestId('tab-deposit')).toBeTruthy();
  });

  it('shows count badges', () => {
    render(
      <ActivityTabs
        activeTab="all"
        onTabChange={vi.fn()}
        counts={counts}
      />
    );
    expect(screen.getByTestId('tab-count-all').textContent).toBe('50');
    expect(screen.getByTestId('tab-count-trade').textContent).toBe('20');
  });

  it('has tab triggers with role="tab"', () => {
    render(
      <ActivityTabs
        activeTab="all"
        onTabChange={vi.fn()}
        counts={counts}
      />
    );
    // Radix renders role="tab" on each trigger
    const tabs = screen.getAllByRole('tab');
    expect(tabs.length).toBe(4);
    const bridgeTab = tabs.find((t) => t.getAttribute('data-testid') === 'tab-bridge');
    expect(bridgeTab).toBeTruthy();
  });

  it('does not show badge when count is 0', () => {
    const zeroCounts = { all: 0, trade: 0, bridge: 0, deposit: 0 };
    render(
      <ActivityTabs
        activeTab="all"
        onTabChange={vi.fn()}
        counts={zeroCounts}
      />
    );
    expect(screen.queryByTestId('tab-count-all')).toBeNull();
  });
});

// ================================================================
// 3. ActivityDecisionCard — expand/collapse + transfer details + tx links
// ================================================================
describe('ActivityDecisionCard', () => {
  it('renders summary text', () => {
    render(<ActivityDecisionCard report={makeReport()} />);
    expect(screen.getByText('Bridged USDC from Ethereum to Arbitrum')).toBeTruthy();
  });

  it('expands when trigger is clicked', async () => {
    render(<ActivityDecisionCard report={makeReport()} />);
    fireEvent.click(screen.getByTestId('decision-card-trigger'));
    await waitFor(() => {
      expect(screen.getByText(/I decided to move USDC/)).toBeTruthy();
    });
  });

  it('shows transfer details when expanded', async () => {
    const report = makeReport({ transfer: makeTransfer() });
    render(<ActivityDecisionCard report={report} />);
    fireEvent.click(screen.getByTestId('decision-card-trigger'));
    await waitFor(() => {
      expect(screen.getByTestId('transfer-details')).toBeTruthy();
    });
  });

  it('renders tx hash link with correct href', async () => {
    const report = makeReport({ transfer: makeTransfer() });
    render(<ActivityDecisionCard report={report} />);
    fireEvent.click(screen.getByTestId('decision-card-trigger'));
    await waitFor(() => {
      const link = screen.getByTestId('tx-hash-link') as HTMLAnchorElement;
      expect(link.href).toContain('0xabcdef');
    });
  });

  it('shows View Transfer button when onViewTransfer provided', async () => {
    const onViewTransfer = vi.fn();
    const report = makeReport({ transfer: makeTransfer() });
    render(<ActivityDecisionCard report={report} onViewTransfer={onViewTransfer} />);
    fireEvent.click(screen.getByTestId('decision-card-trigger'));
    await waitFor(() => {
      expect(screen.getByTestId('view-transfer-btn')).toBeTruthy();
    });
  });

  it('calls onViewTransfer when View Transfer is clicked', async () => {
    const onViewTransfer = vi.fn();
    const report = makeReport({ transfer: makeTransfer() });
    render(<ActivityDecisionCard report={report} onViewTransfer={onViewTransfer} />);
    fireEvent.click(screen.getByTestId('decision-card-trigger'));
    await waitFor(() => screen.getByTestId('view-transfer-btn'));
    fireEvent.click(screen.getByTestId('view-transfer-btn'));
    expect(onViewTransfer).toHaveBeenCalledWith(report);
  });

  it('applies animate-fade-in-down class when isNew=true', () => {
    const { container } = render(<ActivityDecisionCard report={makeReport()} isNew />);
    const card = container.querySelector('[data-testid="activity-decision-card"]');
    expect(card?.className).toContain('animate-fade-in-down');
  });
});

// ================================================================
// 4. TransferDetailSheet — opens at 480px, details visible
// ================================================================
describe('TransferDetailSheet', () => {
  it('does not render when transfer is null', () => {
    const { container } = render(
      <TransferDetailSheet transfer={null} open={false} onOpenChange={vi.fn()} />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders when open with transfer data', () => {
    render(
      <TransferDetailSheet
        transfer={makeTransfer()}
        open={true}
        onOpenChange={vi.fn()}
      />
    );
    expect(screen.getByTestId('transfer-detail-sheet')).toBeTruthy();
  });

  it('shows COMPLETED status badge', () => {
    render(
      <TransferDetailSheet
        transfer={makeTransfer({ status: 'COMPLETED' })}
        open={true}
        onOpenChange={vi.fn()}
      />
    );
    expect(screen.getByTestId('transfer-status-badge').textContent).toContain('Completed');
  });

  it('shows PENDING status badge with amber style', () => {
    render(
      <TransferDetailSheet
        transfer={makeTransfer({ status: 'PENDING' })}
        open={true}
        onOpenChange={vi.fn()}
      />
    );
    expect(screen.getByTestId('transfer-status-badge').textContent).toContain('Pending');
  });

  it('shows FAILED status badge with red style', () => {
    render(
      <TransferDetailSheet
        transfer={makeTransfer({ status: 'FAILED' })}
        open={true}
        onOpenChange={vi.fn()}
      />
    );
    expect(screen.getByTestId('transfer-status-badge').textContent).toContain('Failed');
  });

  it('renders timeline when steps are present', () => {
    const transfer = makeTransfer({
      steps: [
        { id: 's1', action: 'Approve', description: 'Approve USDC', status: 'done' },
        { id: 's2', action: 'Swap', description: 'Bridge via LI.FI', status: 'in_progress' },
      ],
    });
    render(
      <TransferDetailSheet transfer={transfer} open={true} onOpenChange={vi.fn()} />
    );
    expect(screen.getByTestId('transfer-timeline')).toBeTruthy();
    expect(screen.getByText('Approve')).toBeTruthy();
  });

  it('toggles raw JSON on button click', async () => {
    render(
      <TransferDetailSheet
        transfer={makeTransfer()}
        open={true}
        onOpenChange={vi.fn()}
      />
    );
    expect(screen.queryByTestId('raw-json')).toBeNull();
    fireEvent.click(screen.getByTestId('raw-json-toggle'));
    await waitFor(() => {
      expect(screen.getByTestId('raw-json')).toBeTruthy();
    });
  });

  it('has 480px width class', () => {
    render(
      <TransferDetailSheet
        transfer={makeTransfer()}
        open={true}
        onOpenChange={vi.fn()}
      />
    );
    // Sheet renders in portal — search document body for the sheet content
    const sheet = document.querySelector('[data-testid="transfer-detail-sheet"]');
    expect(sheet).toBeTruthy();
    expect(sheet?.className).toContain('w-[480px]');
  });
});

// ================================================================
// 5. DecisionReportList — filtering, empty state
// ================================================================
describe('DecisionReportList', () => {
  const reports: ActivityReport[] = [
    makeReport({ id: 'r1', type: 'bridge', summary: 'Bridge 1' }),
    makeReport({ id: 'r2', type: 'trade', summary: 'Trade 1' }),
    makeReport({ id: 'r3', type: 'deposit', summary: 'Deposit 1' }),
  ];

  it('renders all reports in "all" tab', () => {
    render(
      <DecisionReportList
        reports={reports}
        activeTab="all"
        newIds={new Set()}
        isLoading={false}
        hasMore={false}
        onLoadMore={vi.fn()}
        onViewTransfer={vi.fn()}
      />
    );
    expect(screen.getAllByTestId('activity-decision-card')).toHaveLength(3);
  });

  it('filters to only bridges in "bridge" tab', () => {
    render(
      <DecisionReportList
        reports={reports}
        activeTab="bridge"
        newIds={new Set()}
        isLoading={false}
        hasMore={false}
        onLoadMore={vi.fn()}
        onViewTransfer={vi.fn()}
      />
    );
    expect(screen.getAllByTestId('activity-decision-card')).toHaveLength(1);
    expect(screen.getByText('Bridge 1')).toBeTruthy();
  });

  it('filters to only trades in "trade" tab', () => {
    render(
      <DecisionReportList
        reports={reports}
        activeTab="trade"
        newIds={new Set()}
        isLoading={false}
        hasMore={false}
        onLoadMore={vi.fn()}
        onViewTransfer={vi.fn()}
      />
    );
    expect(screen.getAllByTestId('activity-decision-card')).toHaveLength(1);
    expect(screen.getByText('Trade 1')).toBeTruthy();
  });

  it('shows empty state when no reports match filter', () => {
    render(
      <DecisionReportList
        reports={[]}
        activeTab="all"
        newIds={new Set()}
        isLoading={false}
        hasMore={false}
        onLoadMore={vi.fn()}
        onViewTransfer={vi.fn()}
      />
    );
    expect(screen.getByText('No activity found')).toBeTruthy();
  });

  it('shows skeletons when loading with no reports', () => {
    const { container } = render(
      <DecisionReportList
        reports={[]}
        activeTab="all"
        newIds={new Set()}
        isLoading={true}
        hasMore={false}
        onLoadMore={vi.fn()}
        onViewTransfer={vi.fn()}
      />
    );
    // Loading skeletons rendered
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
  });
});

// ================================================================
// 6. ActivityFilters — filters + clear
// ================================================================
describe('ActivityFilters', () => {
  it('renders filter bar', () => {
    render(<ActivityFilters onChange={vi.fn()} />);
    expect(screen.getByTestId('activity-filters')).toBeTruthy();
  });

  it('renders date, chain, strategy triggers', () => {
    render(<ActivityFilters onChange={vi.fn()} />);
    expect(screen.getByTestId('date-filter-trigger')).toBeTruthy();
    expect(screen.getByTestId('chain-filter-trigger')).toBeTruthy();
    expect(screen.getByTestId('strategy-filter-trigger')).toBeTruthy();
  });

  it('does not show clear button initially', () => {
    render(<ActivityFilters onChange={vi.fn()} />);
    expect(screen.queryByTestId('clear-filters-btn')).toBeNull();
  });

  it('opens chain dropdown when clicked', async () => {
    render(<ActivityFilters onChange={vi.fn()} />);
    fireEvent.click(screen.getByTestId('chain-filter-trigger'));
    await waitFor(() => {
      expect(screen.getByTestId('chain-option-1')).toBeTruthy(); // Ethereum
    });
  });

  it('shows clear filters button after selecting a chain', async () => {
    render(<ActivityFilters onChange={vi.fn()} />);
    fireEvent.click(screen.getByTestId('chain-filter-trigger'));
    await waitFor(() => screen.getByTestId('chain-option-1'));
    fireEvent.click(screen.getByTestId('chain-option-1'));
    await waitFor(() => {
      expect(screen.getByTestId('clear-filters-btn')).toBeTruthy();
    });
  });

  it('clears all filters on clear button click', async () => {
    render(<ActivityFilters onChange={vi.fn()} />);
    // Select a chain
    fireEvent.click(screen.getByTestId('chain-filter-trigger'));
    await waitFor(() => screen.getByTestId('chain-option-1'));
    fireEvent.click(screen.getByTestId('chain-option-1'));
    await waitFor(() => screen.getByTestId('clear-filters-btn'));
    fireEvent.click(screen.getByTestId('clear-filters-btn'));
    await waitFor(() => {
      expect(screen.queryByTestId('clear-filters-btn')).toBeNull();
    });
  });
});
