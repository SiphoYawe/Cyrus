import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TransferProgressBar, getSegmentsForStatus } from '../transfer-progress-bar';
import type { ProgressSegments } from '../transfer-progress-bar';

describe('getSegmentsForStatus', () => {
  it('returns source TX active for PENDING status', () => {
    const segments = getSegmentsForStatus('PENDING');
    expect(segments.sourceTx).toBe('active');
    expect(segments.bridge).toBe('pending');
    expect(segments.destinationTx).toBe('pending');
  });

  it('returns source TX active for NOT_FOUND status', () => {
    const segments = getSegmentsForStatus('NOT_FOUND');
    expect(segments.sourceTx).toBe('active');
    expect(segments.bridge).toBe('pending');
    expect(segments.destinationTx).toBe('pending');
  });

  it('returns bridge active for IN_PROGRESS status', () => {
    const segments = getSegmentsForStatus('IN_PROGRESS');
    expect(segments.sourceTx).toBe('completed');
    expect(segments.bridge).toBe('active');
    expect(segments.destinationTx).toBe('pending');
  });

  it('returns all completed for COMPLETED status', () => {
    const segments = getSegmentsForStatus('COMPLETED');
    expect(segments.sourceTx).toBe('completed');
    expect(segments.bridge).toBe('completed');
    expect(segments.destinationTx).toBe('completed');
  });

  it('returns all completed for PARTIAL status', () => {
    const segments = getSegmentsForStatus('PARTIAL');
    expect(segments.sourceTx).toBe('completed');
    expect(segments.bridge).toBe('completed');
    expect(segments.destinationTx).toBe('completed');
  });

  it('returns all completed for REFUNDED status', () => {
    const segments = getSegmentsForStatus('REFUNDED');
    expect(segments.sourceTx).toBe('completed');
    expect(segments.bridge).toBe('completed');
    expect(segments.destinationTx).toBe('completed');
  });

  it('returns source completed, bridge/dest pending for FAILED', () => {
    const segments = getSegmentsForStatus('FAILED');
    expect(segments.sourceTx).toBe('completed');
    expect(segments.bridge).toBe('pending');
    expect(segments.destinationTx).toBe('pending');
  });
});

describe('TransferProgressBar', () => {
  const renderWithSegments = (segments: ProgressSegments) => {
    return render(
      <TransferProgressBar segments={segments} />
    );
  };

  it('renders with progressbar role', () => {
    renderWithSegments({ sourceTx: 'active', bridge: 'pending', destinationTx: 'pending' });
    expect(screen.getByRole('progressbar')).toBeDefined();
  });

  it('renders data-testid for test targeting', () => {
    renderWithSegments({ sourceTx: 'active', bridge: 'pending', destinationTx: 'pending' });
    expect(screen.getByTestId('transfer-progress-bar')).toBeDefined();
  });

  it('renders Source TX label', () => {
    renderWithSegments({ sourceTx: 'active', bridge: 'pending', destinationTx: 'pending' });
    expect(screen.getByText('Source TX')).toBeDefined();
  });

  it('renders Bridge label', () => {
    renderWithSegments({ sourceTx: 'active', bridge: 'pending', destinationTx: 'pending' });
    expect(screen.getByText('Bridge')).toBeDefined();
  });

  it('renders Destination TX label', () => {
    renderWithSegments({ sourceTx: 'active', bridge: 'pending', destinationTx: 'pending' });
    expect(screen.getByText('Destination TX')).toBeDefined();
  });

  it('applies violet color for active segment', () => {
    const { container } = renderWithSegments({
      sourceTx: 'active',
      bridge: 'pending',
      destinationTx: 'pending',
    });
    const violetSegments = container.querySelectorAll('.bg-violet-500');
    expect(violetSegments.length).toBeGreaterThan(0);
  });

  it('applies green color for completed segments', () => {
    const { container } = renderWithSegments({
      sourceTx: 'completed',
      bridge: 'completed',
      destinationTx: 'active',
    });
    // Two completed segments should have green
    const greenSegments = container.querySelectorAll('.bg-\\[\\#22C55E\\]');
    expect(greenSegments.length).toBeGreaterThanOrEqual(2);
  });

  it('applies zinc-700 for pending segments', () => {
    const { container } = renderWithSegments({
      sourceTx: 'pending',
      bridge: 'pending',
      destinationTx: 'pending',
    });
    const pendingSegments = container.querySelectorAll('.bg-zinc-700');
    // 3 segment bars + 2 connectors = 5 zinc-700 elements
    expect(pendingSegments.length).toBeGreaterThanOrEqual(3);
  });

  it('shows shimmer overlay on active segment only', () => {
    const { container } = renderWithSegments({
      sourceTx: 'completed',
      bridge: 'active',
      destinationTx: 'pending',
    });
    const shimmerElements = container.querySelectorAll('.animate-shimmer');
    expect(shimmerElements.length).toBe(1);
  });

  it('shows no shimmer when all segments are completed', () => {
    const { container } = renderWithSegments({
      sourceTx: 'completed',
      bridge: 'completed',
      destinationTx: 'completed',
    });
    const shimmerElements = container.querySelectorAll('.animate-shimmer');
    expect(shimmerElements.length).toBe(0);
  });
});
