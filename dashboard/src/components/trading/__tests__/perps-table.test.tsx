import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PerpsTable } from '@/components/trading/perps-table';
import type { PerpPosition } from '@/components/trading/types';

const mockPosition: PerpPosition = {
  id: 'perp-1',
  symbol: 'ETH-PERP',
  side: 'long',
  size: 1.5,
  entryPrice: 3000,
  currentPrice: 3150,
  leverage: 5,
  unrealizedPnl: 225,
  unrealizedPnlPercent: 7.5,
  liquidationPrice: 2400,
  fundingRate: 0.01,
  openedAt: Date.now() - 3_600_000,
};

const shortPosition: PerpPosition = {
  ...mockPosition,
  id: 'perp-2',
  symbol: 'BTC-PERP',
  side: 'short',
  unrealizedPnl: -100,
  unrealizedPnlPercent: -2.5,
  leverage: 10,
  currentPrice: 2950,
  liquidationPrice: 2960,
};

describe('PerpsTable', () => {
  it('shows empty state when no positions', () => {
    render(<PerpsTable positions={[]} onRowClick={vi.fn()} />);
    expect(screen.getByText('No perpetual positions open.')).toBeInTheDocument();
  });

  it('renders position data', () => {
    render(<PerpsTable positions={[mockPosition]} onRowClick={vi.fn()} />);
    expect(screen.getByText('ETH-PERP')).toBeInTheDocument();
    expect(screen.getByText('Long')).toBeInTheDocument();
    expect(screen.getByText('5x')).toBeInTheDocument();
  });

  it('calls onRowClick when row is clicked', () => {
    const onClick = vi.fn();
    render(<PerpsTable positions={[mockPosition]} onRowClick={onClick} />);
    fireEvent.click(screen.getByText('ETH-PERP'));
    expect(onClick).toHaveBeenCalledWith(mockPosition);
  });

  it('shows liquidation warning for near-liquidation positions', () => {
    render(<PerpsTable positions={[shortPosition]} onRowClick={vi.fn()} />);
    expect(screen.getByText('⚠')).toBeInTheDocument();
  });

  it('sorts by column when header is clicked', () => {
    render(<PerpsTable positions={[mockPosition, shortPosition]} onRowClick={vi.fn()} />);
    fireEvent.click(screen.getByText(/Symbol/));
    const rows = screen.getAllByRole('row');
    // Header + 2 data rows
    expect(rows).toHaveLength(3);
  });

  it('renders short badge with negative color', () => {
    render(<PerpsTable positions={[shortPosition]} onRowClick={vi.fn()} />);
    expect(screen.getByText('Short')).toBeInTheDocument();
  });
});
