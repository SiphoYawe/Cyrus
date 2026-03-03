import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { TransferStatusCard } from '../transfer-status-card';
import type { Transfer } from '@/stores/transfers-store';

// Mock WebSocket provider
vi.mock('@/providers/ws-provider', () => ({
  useWebSocket: () => ({
    status: 'connected',
    send: vi.fn(),
  }),
}));

// Mock HugeIcons
vi.mock('@hugeicons/react', () => ({
  Tick02Icon: ({ size, color }: { size: number; color: string }) => (
    <svg data-testid="tick-icon" data-size={size} data-color={color} />
  ),
  Cancel01Icon: ({ size, color }: { size: number; color: string }) => (
    <svg data-testid="cancel-icon" data-size={size} data-color={color} />
  ),
}));

const NOW = 1_700_000_000_000;

const baseTransfer: Transfer = {
  id: 'test-transfer-1',
  fromChainId: 1,
  toChainId: 42161,
  fromToken: { symbol: 'USDC', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
  toToken: { symbol: 'USDC', address: '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8', decimals: 6 },
  fromAmount: '10000000', // 10 USDC
  status: 'PENDING',
  startedAt: NOW - 30_000,
  estimatedTimeMs: 120_000,
};

describe('TransferStatusCard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  describe('basic rendering', () => {
    it('renders card with data-testid', () => {
      render(<TransferStatusCard transfer={baseTransfer} />);
      expect(screen.getByTestId('transfer-card-test-transfer-1')).toBeDefined();
    });

    it('shows from and to chain logos', () => {
      render(<TransferStatusCard transfer={baseTransfer} />);
      expect(screen.getByTestId('chain-logo-1')).toBeDefined();
      expect(screen.getByTestId('chain-logo-42161')).toBeDefined();
    });

    it('shows chain names below logos', () => {
      render(<TransferStatusCard transfer={baseTransfer} />);
      expect(screen.getByText('Ethereum')).toBeDefined();
      expect(screen.getByText('Arbitrum')).toBeDefined();
    });

    it('shows from amount formatted', () => {
      render(<TransferStatusCard transfer={baseTransfer} />);
      expect(screen.getByText('10 USDC')).toBeDefined();
    });
  });

  describe('status badges', () => {
    it('shows Pending badge for PENDING status', () => {
      render(<TransferStatusCard transfer={{ ...baseTransfer, status: 'PENDING' }} />);
      expect(screen.getByText('Pending')).toBeDefined();
    });

    it('shows In Progress badge for IN_PROGRESS status', () => {
      render(<TransferStatusCard transfer={{ ...baseTransfer, status: 'IN_PROGRESS' }} />);
      expect(screen.getByText('In Progress')).toBeDefined();
    });

    it('shows Completed badge for COMPLETED status', () => {
      render(
        <TransferStatusCard
          transfer={{ ...baseTransfer, status: 'COMPLETED', toAmount: '10000000', completedAt: NOW }}
        />
      );
      expect(screen.getByText('Completed')).toBeDefined();
    });

    it('shows Failed badge for FAILED status', () => {
      render(
        <TransferStatusCard
          transfer={{ ...baseTransfer, status: 'FAILED', error: 'Bridge timeout' }}
        />
      );
      expect(screen.getByText('Failed')).toBeDefined();
    });

    it('shows Partial badge for PARTIAL status', () => {
      render(
        <TransferStatusCard
          transfer={{ ...baseTransfer, status: 'PARTIAL', toAmount: '9900000', completedAt: NOW }}
        />
      );
      expect(screen.getByText('Partial')).toBeDefined();
    });

    it('shows Refunded badge for REFUNDED status', () => {
      render(
        <TransferStatusCard
          transfer={{ ...baseTransfer, status: 'REFUNDED', completedAt: NOW }}
        />
      );
      expect(screen.getByText('Refunded')).toBeDefined();
    });
  });

  describe('progress bar', () => {
    it('shows progress bar for PENDING status', () => {
      render(<TransferStatusCard transfer={{ ...baseTransfer, status: 'PENDING' }} />);
      expect(screen.getByTestId('transfer-progress-bar')).toBeDefined();
    });

    it('shows progress bar for IN_PROGRESS status', () => {
      render(<TransferStatusCard transfer={{ ...baseTransfer, status: 'IN_PROGRESS' }} />);
      expect(screen.getByTestId('transfer-progress-bar')).toBeDefined();
    });

    it('does not show progress bar for COMPLETED status', () => {
      render(
        <TransferStatusCard
          transfer={{ ...baseTransfer, status: 'COMPLETED', completedAt: NOW }}
        />
      );
      expect(screen.queryByTestId('transfer-progress-bar')).toBeNull();
    });

    it('does not show progress bar for FAILED status', () => {
      render(
        <TransferStatusCard transfer={{ ...baseTransfer, status: 'FAILED', error: 'Error' }} />
      );
      expect(screen.queryByTestId('transfer-progress-bar')).toBeNull();
    });
  });

  describe('completed state', () => {
    it('shows green checkmark icon on completion', () => {
      render(
        <TransferStatusCard
          transfer={{
            ...baseTransfer,
            status: 'COMPLETED',
            toAmount: '10000000',
            completedAt: NOW,
          }}
        />
      );
      expect(screen.getByTestId('tick-icon')).toBeDefined();
      expect(screen.getByTestId('completion-icon')).toBeDefined();
    });

    it('shows received amount on completion', () => {
      render(
        <TransferStatusCard
          transfer={{
            ...baseTransfer,
            status: 'COMPLETED',
            toAmount: '10000000',
            completedAt: NOW,
          }}
        />
      );
      expect(screen.getByText('Received')).toBeDefined();
      expect(screen.getAllByText('10 USDC').length).toBeGreaterThan(0);
    });

    it('calls onFadedOut after 10 seconds + fade duration', () => {
      const onFadedOut = vi.fn();
      render(
        <TransferStatusCard
          transfer={{
            ...baseTransfer,
            status: 'COMPLETED',
            toAmount: '10000000',
            completedAt: NOW,
          }}
          onFadedOut={onFadedOut}
        />
      );

      expect(onFadedOut).not.toHaveBeenCalled();

      // Advance past 10s delay + 500ms fade
      act(() => {
        vi.advanceTimersByTime(10_000 + 500 + 100);
      });

      expect(onFadedOut).toHaveBeenCalledWith('test-transfer-1');
    });

    it('does not call onFadedOut before 10 seconds', () => {
      const onFadedOut = vi.fn();
      render(
        <TransferStatusCard
          transfer={{
            ...baseTransfer,
            status: 'COMPLETED',
            toAmount: '10000000',
            completedAt: NOW,
          }}
          onFadedOut={onFadedOut}
        />
      );

      act(() => {
        vi.advanceTimersByTime(5_000);
      });

      expect(onFadedOut).not.toHaveBeenCalled();
    });
  });

  describe('failed state', () => {
    const failedTransfer: Transfer = {
      ...baseTransfer,
      status: 'FAILED',
      error: 'Bridge timeout after 30 minutes',
    };

    it('shows cancel icon on failure', () => {
      render(<TransferStatusCard transfer={failedTransfer} />);
      expect(screen.getByTestId('cancel-icon')).toBeDefined();
      expect(screen.getByTestId('failure-icon')).toBeDefined();
    });

    it('shows error description', () => {
      render(<TransferStatusCard transfer={failedTransfer} />);
      expect(screen.getByText('Bridge timeout after 30 minutes')).toBeDefined();
    });

    it('renders Retry button', () => {
      render(<TransferStatusCard transfer={failedTransfer} />);
      expect(screen.getByTestId('recovery-retry')).toBeDefined();
      expect(screen.getByText('Retry')).toBeDefined();
    });

    it('renders Hold button', () => {
      render(<TransferStatusCard transfer={failedTransfer} />);
      expect(screen.getByTestId('recovery-hold')).toBeDefined();
      expect(screen.getByText('Hold')).toBeDefined();
    });

    it('does not render Reverse button when not applicable', () => {
      render(<TransferStatusCard transfer={failedTransfer} />);
      expect(screen.queryByTestId('recovery-reverse')).toBeNull();
    });

    it('renders Reverse button when bridge is hop', () => {
      render(
        <TransferStatusCard
          transfer={{ ...failedTransfer, bridge: 'hop' }}
        />
      );
      expect(screen.getByTestId('recovery-reverse')).toBeDefined();
    });

    it('renders Reverse button when bridge is across', () => {
      render(
        <TransferStatusCard
          transfer={{ ...failedTransfer, bridge: 'across' }}
        />
      );
      expect(screen.getByTestId('recovery-reverse')).toBeDefined();
    });

    it('recovery buttons are clickable without error', () => {
      render(<TransferStatusCard transfer={failedTransfer} />);
      // Should not throw
      fireEvent.click(screen.getByTestId('recovery-retry'));
      fireEvent.click(screen.getByTestId('recovery-hold'));
      expect(screen.getByTestId('recovery-retry')).toBeDefined();
    });

    it('disables buttons after action is triggered', () => {
      render(<TransferStatusCard transfer={failedTransfer} />);
      fireEvent.click(screen.getByTestId('recovery-retry'));
      // After click, other buttons should be disabled (loading state)
      const holdBtn = screen.getByTestId('recovery-hold') as HTMLButtonElement;
      expect(holdBtn.disabled).toBe(true);
    });
  });

  describe('ETA countdown', () => {
    it('shows ETA for active transfers with estimatedTimeMs', () => {
      render(
        <TransferStatusCard
          transfer={{
            ...baseTransfer,
            status: 'PENDING',
            estimatedTimeMs: 120_000,
            startedAt: NOW - 30_000,
          }}
        />
      );
      const etaEl = screen.getByTestId('eta-countdown');
      expect(etaEl).toBeDefined();
      // ~1m 30s remaining
      expect(etaEl.textContent).toMatch(/~\d+ min|~\d+s|< 1s/);
    });

    it('does not show ETA for completed transfers', () => {
      render(
        <TransferStatusCard
          transfer={{
            ...baseTransfer,
            status: 'COMPLETED',
            completedAt: NOW,
          }}
        />
      );
      expect(screen.queryByTestId('eta-countdown')).toBeNull();
    });

    it('does not show ETA for failed transfers', () => {
      render(
        <TransferStatusCard
          transfer={{
            ...baseTransfer,
            status: 'FAILED',
            error: 'Failed',
          }}
        />
      );
      expect(screen.queryByTestId('eta-countdown')).toBeNull();
    });
  });

  describe('bridge info', () => {
    it('shows bridge name when present', () => {
      render(
        <TransferStatusCard transfer={{ ...baseTransfer, bridge: 'stargate' }} />
      );
      expect(screen.getByText('via stargate')).toBeDefined();
    });

    it('does not show bridge info when not present', () => {
      render(<TransferStatusCard transfer={baseTransfer} />);
      expect(screen.queryByText(/via /)).toBeNull();
    });
  });

  describe('data-status attribute', () => {
    it('sets correct data-status on card', () => {
      render(<TransferStatusCard transfer={{ ...baseTransfer, status: 'IN_PROGRESS' }} />);
      const card = screen.getByTestId('transfer-card-test-transfer-1');
      expect(card.getAttribute('data-status')).toBe('IN_PROGRESS');
    });
  });
});
