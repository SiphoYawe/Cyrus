import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ChainLogo, getChainName, getChainColor } from '../chain-logo';

describe('ChainLogo', () => {
  it('renders with Ethereum chain (id=1)', () => {
    render(<ChainLogo chainId={1} />);
    const svg = screen.getByRole('img', { name: 'Ethereum' });
    expect(svg).toBeDefined();
  });

  it('renders with Arbitrum chain (id=42161)', () => {
    render(<ChainLogo chainId={42161} />);
    const svg = screen.getByRole('img', { name: 'Arbitrum' });
    expect(svg).toBeDefined();
  });

  it('renders with Optimism chain (id=10)', () => {
    render(<ChainLogo chainId={10} />);
    const svg = screen.getByRole('img', { name: 'Optimism' });
    expect(svg).toBeDefined();
  });

  it('renders with Polygon chain (id=137)', () => {
    render(<ChainLogo chainId={137} />);
    const svg = screen.getByRole('img', { name: 'Polygon' });
    expect(svg).toBeDefined();
  });

  it('renders with Base chain (id=8453)', () => {
    render(<ChainLogo chainId={8453} />);
    const svg = screen.getByRole('img', { name: 'Base' });
    expect(svg).toBeDefined();
  });

  it('renders with BSC chain (id=56)', () => {
    render(<ChainLogo chainId={56} />);
    const svg = screen.getByRole('img', { name: 'BSC' });
    expect(svg).toBeDefined();
  });

  it('renders with unknown chain id gracefully', () => {
    render(<ChainLogo chainId={999} />);
    const svg = screen.getByRole('img', { name: 'Chain 999' });
    expect(svg).toBeDefined();
  });

  it('shows chain name when showName=true', () => {
    render(<ChainLogo chainId={1} showName />);
    expect(screen.getByText('Ethereum')).toBeDefined();
  });

  it('does not show chain name when showName is false (default)', () => {
    render(<ChainLogo chainId={1} />);
    expect(screen.queryByText('Ethereum')).toBeNull();
  });

  it('uses correct size attribute', () => {
    render(<ChainLogo chainId={1} size={48} />);
    const svg = screen.getByRole('img', { name: 'Ethereum' });
    expect(svg.getAttribute('width')).toBe('48');
    expect(svg.getAttribute('height')).toBe('48');
  });

  it('uses data-testid for chain identification', () => {
    render(<ChainLogo chainId={42161} />);
    const el = screen.getByTestId('chain-logo-42161');
    expect(el).toBeDefined();
  });
});

describe('getChainName', () => {
  it('returns correct name for known chains', () => {
    expect(getChainName(1)).toBe('Ethereum');
    expect(getChainName(42161)).toBe('Arbitrum');
    expect(getChainName(10)).toBe('Optimism');
    expect(getChainName(137)).toBe('Polygon');
    expect(getChainName(8453)).toBe('Base');
    expect(getChainName(56)).toBe('BSC');
  });

  it('returns fallback for unknown chain id', () => {
    expect(getChainName(9999)).toBe('Chain 9999');
  });
});

describe('getChainColor', () => {
  it('returns correct color for Ethereum', () => {
    expect(getChainColor(1)).toBe('#627EEA');
  });

  it('returns correct color for Arbitrum', () => {
    expect(getChainColor(42161)).toBe('#28A0F0');
  });

  it('returns fallback color for unknown chain', () => {
    expect(getChainColor(9999)).toBe('#71717A');
  });
});
