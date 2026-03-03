import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PairsTable } from '@/components/trading/pairs-table';
import type { PairPosition } from '@/components/trading/types';

const mockPair: PairPosition = {
  id: 'pair-1',
  pairName: 'ETH/BTC',
  direction: 'long_pair',
  longLeg: { token: 'ETH', amount: 10, entryPrice: 3000 },
  shortLeg: { token: 'BTC', amount: 0.5, entryPrice: 60000 },
  entryZScore: 2.1,
  currentZScore: 1.2,
  combinedPnl: 450,
  openedAt: Date.now() - 7_200_000,
};

describe('PairsTable', () => {
  it('shows empty state when no positions', () => {
    render(<PairsTable positions={[]} onRowClick={vi.fn()} />);
    expect(screen.getByText('No pair trades active.')).toBeInTheDocument();
  });

  it('renders pair data', () => {
    render(<PairsTable positions={[mockPair]} onRowClick={vi.fn()} />);
    expect(screen.getByText('ETH/BTC')).toBeInTheDocument();
    expect(screen.getByText('Long Pair')).toBeInTheDocument();
    expect(screen.getByText('2.10')).toBeInTheDocument();
    expect(screen.getByText('1.20')).toBeInTheDocument();
  });

  it('calls onRowClick when row is clicked', () => {
    const onClick = vi.fn();
    render(<PairsTable positions={[mockPair]} onRowClick={onClick} />);
    fireEvent.click(screen.getByText('ETH/BTC'));
    expect(onClick).toHaveBeenCalledWith(mockPair);
  });

  it('shows combined P&L formatted as USD', () => {
    render(<PairsTable positions={[mockPair]} onRowClick={vi.fn()} />);
    expect(screen.getByText('$450.00')).toBeInTheDocument();
  });
});
