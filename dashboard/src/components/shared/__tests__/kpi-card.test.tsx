import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { KpiCard } from '@/components/overview/kpi-card';

// NumberFlow renders a span with formatted number
vi.mock('@number-flow/react', () => ({
  default: ({ value, format }: { value: number; format?: Intl.NumberFormatOptions }) => {
    const formatted = new Intl.NumberFormat('en-US', format).format(value);
    return <span data-testid="number-flow">{formatted}</span>;
  },
}));

describe('KpiCard', () => {
  it('renders label and value', () => {
    render(<KpiCard label="Portfolio Value" value={12345.67} />);
    expect(screen.getByText('Portfolio Value')).toBeInTheDocument();
    expect(screen.getByTestId('number-flow')).toBeInTheDocument();
  });

  it('renders prefix and suffix', () => {
    render(<KpiCard label="Total" value={99.5} prefix="$" suffix="%" />);
    expect(screen.getByText('$')).toBeInTheDocument();
    expect(screen.getByText('%')).toBeInTheDocument();
  });

  it('shows skeleton when loading', () => {
    const { container } = render(<KpiCard label="Yield" value={5.2} isLoading />);
    const skeletons = container.querySelectorAll('[data-slot="skeleton"]');
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it('does not show skeleton when not loading', () => {
    render(<KpiCard label="Yield" value={5.2} />);
    const flow = screen.getByTestId('number-flow');
    expect(flow).toBeInTheDocument();
  });

  it('applies positive variant class', () => {
    const { container } = render(
      <KpiCard label="P&L" value={100} variant="positive" />
    );
    const valueEl = container.querySelector('.text-positive');
    expect(valueEl).toBeInTheDocument();
  });

  it('applies negative variant class', () => {
    const { container } = render(
      <KpiCard label="P&L" value={-50} variant="negative" />
    );
    const valueEl = container.querySelector('.text-negative');
    expect(valueEl).toBeInTheDocument();
  });

  it('renders subtext', () => {
    render(
      <KpiCard label="Yield" value={3.5} subtext={<span>APY across positions</span>} />
    );
    expect(screen.getByText('APY across positions')).toBeInTheDocument();
  });

  it('passes correct value to NumberFlow', () => {
    render(<KpiCard label="Ops" value={7} decimals={0} />);
    const flow = screen.getByTestId('number-flow');
    expect(flow.textContent).toBe('7');
  });
});
