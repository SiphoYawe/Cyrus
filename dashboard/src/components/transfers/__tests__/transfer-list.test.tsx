import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TransferList } from '../transfer-list';
import { useTransfersStore } from '@/stores/transfers-store';
import type { Transfer } from '@/stores/transfers-store';

// Mock HugeIcons
vi.mock('@hugeicons/react', () => ({
  CheckmarkCircle02Icon: ({ size }: { size: number }) => (
    <svg data-testid="checkmark-circle-icon" data-size={size} />
  ),
  Tick02Icon: () => <svg data-testid="tick-icon" />,
  Cancel01Icon: () => <svg data-testid="cancel-icon" />,
}));

// Mock WebSocket provider
vi.mock('@/providers/ws-provider', () => ({
  useWebSocket: () => ({
    status: 'connected',
    send: vi.fn(),
  }),
}));

const makeTransfer = (overrides: Partial<Transfer> = {}): Transfer => ({
  id: `transfer-${Math.random().toString(36).slice(2)}`,
  fromChainId: 1,
  toChainId: 42161,
  fromToken: { symbol: 'USDC', address: '0xabc', decimals: 6 },
  toToken: { symbol: 'USDC', address: '0xdef', decimals: 6 },
  fromAmount: '5000000',
  status: 'PENDING',
  startedAt: Date.now(),
  estimatedTimeMs: 60_000,
  ...overrides,
});

describe('TransferList', () => {
  beforeEach(() => {
    // Reset store state before each test
    useTransfersStore.setState({ active: new Map(), completed: [] });
  });

  describe('empty state', () => {
    it('renders empty state when no active transfers', () => {
      render(<TransferList />);
      expect(screen.getByText('No active transfers. Your capital is deployed.')).toBeDefined();
    });

    it('renders empty state icon', () => {
      render(<TransferList />);
      expect(screen.getByTestId('checkmark-circle-icon')).toBeDefined();
    });

    it('renders the container with data-testid', () => {
      render(<TransferList />);
      expect(screen.getByTestId('transfer-list')).toBeDefined();
    });
  });

  describe('active transfers', () => {
    it('renders a single active transfer', () => {
      const transfer = makeTransfer({ id: 'active-1' });
      useTransfersStore.setState({ active: new Map([['active-1', transfer]]) });

      render(<TransferList />);
      expect(screen.getByTestId('transfer-card-active-1')).toBeDefined();
    });

    it('renders multiple active transfers', () => {
      const t1 = makeTransfer({ id: 'tx-1' });
      const t2 = makeTransfer({ id: 'tx-2' });
      useTransfersStore.setState({
        active: new Map([
          ['tx-1', t1],
          ['tx-2', t2],
        ]),
      });

      render(<TransferList />);
      expect(screen.getByTestId('transfer-card-tx-1')).toBeDefined();
      expect(screen.getByTestId('transfer-card-tx-2')).toBeDefined();
    });

    it('does not show empty state when transfers are active', () => {
      const transfer = makeTransfer({ id: 'active-1' });
      useTransfersStore.setState({ active: new Map([['active-1', transfer]]) });

      render(<TransferList />);
      expect(screen.queryByText('No active transfers. Your capital is deployed.')).toBeNull();
    });

    it('orders transfers by startedAt (oldest first)', () => {
      const t1 = makeTransfer({ id: 'old', startedAt: 1000 });
      const t2 = makeTransfer({ id: 'new', startedAt: 2000 });
      // Insert in reverse order
      useTransfersStore.setState({
        active: new Map([
          ['new', t2],
          ['old', t1],
        ]),
      });

      render(<TransferList />);
      const cards = screen.getAllByTestId(/^transfer-card-/);
      expect(cards[0].getAttribute('data-testid')).toBe('transfer-card-old');
      expect(cards[1].getAttribute('data-testid')).toBe('transfer-card-new');
    });
  });

  describe('completed transfers', () => {
    it('does not show completed section when no completed transfers', () => {
      render(<TransferList />);
      expect(screen.queryByText(/Recent Completed/)).toBeNull();
    });

    it('shows completed section when there are completed transfers', () => {
      const completed = makeTransfer({ id: 'done-1', status: 'COMPLETED', completedAt: Date.now() });
      useTransfersStore.setState({
        active: new Map(),
        completed: [completed],
      });

      render(<TransferList />);
      expect(screen.getByText('Recent Completed (1)')).toBeDefined();
    });

    it('collapsed by default — completed cards are hidden', () => {
      const completed = makeTransfer({ id: 'done-1', status: 'COMPLETED', completedAt: Date.now() });
      useTransfersStore.setState({
        active: new Map(),
        completed: [completed],
      });

      render(<TransferList />);
      expect(screen.queryByTestId('completed-list')).toBeNull();
    });

    it('expands completed section on click', () => {
      const completed = makeTransfer({ id: 'done-1', status: 'COMPLETED', completedAt: Date.now() });
      useTransfersStore.setState({
        active: new Map(),
        completed: [completed],
      });

      render(<TransferList />);
      fireEvent.click(screen.getByTestId('completed-collapsible-trigger'));
      expect(screen.getByTestId('completed-list')).toBeDefined();
    });

    it('shows at most 5 completed transfers', () => {
      const completed = Array.from({ length: 8 }, (_, i) =>
        makeTransfer({ id: `done-${i}`, status: 'COMPLETED', completedAt: Date.now() })
      );
      useTransfersStore.setState({
        active: new Map(),
        completed,
      });

      render(<TransferList />);
      fireEvent.click(screen.getByTestId('completed-collapsible-trigger'));

      const cards = screen.getAllByTestId(/^transfer-card-done-/);
      expect(cards.length).toBe(5);
    });
  });

  describe('integration: active + completed', () => {
    it('renders both active and completed sections', () => {
      const activeTransfer = makeTransfer({ id: 'active-1', status: 'IN_PROGRESS' });
      const completedTransfer = makeTransfer({
        id: 'done-1',
        status: 'COMPLETED',
        completedAt: Date.now(),
      });

      useTransfersStore.setState({
        active: new Map([['active-1', activeTransfer]]),
        completed: [completedTransfer],
      });

      render(<TransferList />);

      // Active card visible
      expect(screen.getByTestId('transfer-card-active-1')).toBeDefined();
      // Completed section trigger visible
      expect(screen.getByText('Recent Completed (1)')).toBeDefined();
      // Empty state NOT visible
      expect(screen.queryByText('No active transfers. Your capital is deployed.')).toBeNull();
    });
  });
});
