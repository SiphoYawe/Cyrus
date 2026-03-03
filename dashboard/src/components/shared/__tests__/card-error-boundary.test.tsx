import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CardErrorBoundary } from '@/components/shared/card-error-boundary';

// A component that throws during render
function ThrowingComponent({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) {
    throw new Error('Test render error');
  }
  return <div data-testid="child-content">Child content</div>;
}

// Suppress console.error for expected error boundary output
const originalError = console.error;
beforeEach(() => {
  console.error = vi.fn();
});
afterEach(() => {
  console.error = originalError;
});

describe('CardErrorBoundary', () => {
  it('renders children when no error', () => {
    render(
      <CardErrorBoundary>
        <ThrowingComponent shouldThrow={false} />
      </CardErrorBoundary>
    );
    expect(screen.getByTestId('child-content')).toBeInTheDocument();
  });

  it('renders error fallback when child throws', () => {
    render(
      <CardErrorBoundary>
        <ThrowingComponent shouldThrow={true} />
      </CardErrorBoundary>
    );
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
    expect(screen.getByText(/test render error/i)).toBeInTheDocument();
  });

  it('shows custom fallback when provided', () => {
    render(
      <CardErrorBoundary fallback={<div data-testid="custom-fallback">Custom</div>}>
        <ThrowingComponent shouldThrow={true} />
      </CardErrorBoundary>
    );
    expect(screen.getByTestId('custom-fallback')).toBeInTheDocument();
  });

  it('calls onRetry and resets error state on Retry click', () => {
    const onRetry = vi.fn();
    render(
      <CardErrorBoundary onRetry={onRetry}>
        <ThrowingComponent shouldThrow={true} />
      </CardErrorBoundary>
    );
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
