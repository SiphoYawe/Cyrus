import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EmptyState } from '@/components/shared/empty-state';

describe('EmptyState', () => {
  it('renders icon, message, and description', () => {
    render(
      <EmptyState
        icon={<svg data-testid="icon" />}
        message="All quiet. Your agent is monitoring."
        description="Decisions will appear here once the agent starts."
      />
    );
    expect(screen.getByTestId('icon')).toBeInTheDocument();
    expect(screen.getByText('All quiet. Your agent is monitoring.')).toBeInTheDocument();
    expect(screen.getByText(/Decisions will appear/)).toBeInTheDocument();
  });

  it('renders without description', () => {
    render(
      <EmptyState
        icon={<svg data-testid="icon" />}
        message="No data yet."
      />
    );
    expect(screen.getByText('No data yet.')).toBeInTheDocument();
  });

  it('renders optional action slot', () => {
    render(
      <EmptyState
        icon={<svg />}
        message="Empty"
        action={<button>Refresh</button>}
      />
    );
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument();
  });

  it('does not render description if not provided', () => {
    const { container } = render(
      <EmptyState icon={<svg />} message="Empty" />
    );
    const paras = container.querySelectorAll('p');
    // Only the message paragraph should exist
    expect(paras).toHaveLength(1);
  });
});
