import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MarketMakingCard } from '@/components/trading/market-making-card';
import type { MarketMakingPosition } from '@/components/trading/types';

const mockMM: MarketMakingPosition = {
  id: 'mm-1',
  market: 'ETH/USDC',
  baseToken: 'ETH',
  quoteToken: 'USDC',
  bidCount: 5,
  bestBid: 3100,
  askCount: 4,
  bestAsk: 3110,
  baseInventory: 60,
  quoteInventory: 40,
  spreadBps: 32.3,
  sessionPnl: 150,
};

describe('MarketMakingCard', () => {
  it('renders market name', () => {
    render(<MarketMakingCard position={mockMM} onClick={vi.fn()} />);
    expect(screen.getByText('ETH/USDC')).toBeInTheDocument();
  });

  it('renders bid/ask info', () => {
    render(<MarketMakingCard position={mockMM} onClick={vi.fn()} />);
    expect(screen.getByText('Bids (5)')).toBeInTheDocument();
    expect(screen.getByText('Asks (4)')).toBeInTheDocument();
  });

  it('renders token labels', () => {
    render(<MarketMakingCard position={mockMM} onClick={vi.fn()} />);
    expect(screen.getByText('ETH')).toBeInTheDocument();
    expect(screen.getByText('USDC')).toBeInTheDocument();
  });

  it('shows spread in bps', () => {
    render(<MarketMakingCard position={mockMM} onClick={vi.fn()} />);
    expect(screen.getByText('32.3 bps')).toBeInTheDocument();
  });

  it('calls onClick when card is clicked', () => {
    const onClick = vi.fn();
    render(<MarketMakingCard position={mockMM} onClick={onClick} />);
    fireEvent.click(screen.getByText('ETH/USDC'));
    expect(onClick).toHaveBeenCalledWith(mockMM);
  });
});
