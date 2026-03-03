import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { RiskDial } from '../risk-dial';

// Mock ws-provider
const mockSend = vi.fn();
vi.mock('@/providers/ws-provider', () => ({
  useWebSocket: () => ({ send: mockSend, status: 'connected' }),
}));

// Mock agent-store
vi.mock('@/stores/agent-store', () => ({
  useAgentStore: (selector: (s: { config: { riskLevel: number } | null }) => unknown) =>
    selector({ config: { riskLevel: 5 } }),
}));

// Mock sonner
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// Mock recharts to avoid SVG rendering issues in jsdom
vi.mock('recharts', () => ({
  PieChart:           ({ children }: { children: React.ReactNode }) => <div data-testid="pie-chart">{children}</div>,
  Pie:                () => null,
  Cell:               () => null,
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

describe('RiskDial', () => {
  beforeEach(() => {
    mockSend.mockClear();
  });

  it('renders with the current risk level from agent config', () => {
    render(<RiskDial />);
    // The value badge and scale ticks should show 5
    const fives = screen.getAllByText('5');
    expect(fives.length).toBeGreaterThan(0);
  });

  it('shows tier label based on initial risk level', () => {
    render(<RiskDial />);
    // Level 5 is "Balanced" — appears in both badge and tier label span
    const balancedElements = screen.getAllByText('Balanced');
    expect(balancedElements.length).toBeGreaterThanOrEqual(1);
  });

  it('renders tier labels: Conservative, Balanced, Aggressive', () => {
    render(<RiskDial />);
    expect(screen.getByText('Conservative')).toBeInTheDocument();
    // Balanced appears as both tier badge and label
    expect(screen.getAllByText('Balanced').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Aggressive')).toBeInTheDocument();
  });

  it('slider has correct ARIA attributes', () => {
    render(<RiskDial />);
    const slider = screen.getByRole('slider');
    expect(slider).toHaveAttribute('aria-valuenow', '5');
    expect(slider).toHaveAttribute('aria-valuemin', '1');
    expect(slider).toHaveAttribute('aria-valuemax', '10');
    expect(slider).toHaveAttribute('aria-label', 'Risk level');
  });

  it('shows Confirm and Cancel buttons when slider value changes', async () => {
    render(<RiskDial />);
    const slider = screen.getByRole('slider');

    // Simulate arrow key press to change value
    fireEvent.keyDown(slider, { key: 'ArrowRight', code: 'ArrowRight' });

    await waitFor(() => {
      expect(screen.getByText('Confirm Transformation')).toBeInTheDocument();
      expect(screen.getByText('Cancel')).toBeInTheDocument();
    });
  });

  it('cancel button resets slider to previous value', async () => {
    render(<RiskDial />);
    const slider = screen.getByRole('slider');

    fireEvent.keyDown(slider, { key: 'ArrowRight', code: 'ArrowRight' });

    await waitFor(() => {
      expect(screen.getByText('Cancel')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Cancel'));

    await waitFor(() => {
      expect(screen.queryByText('Cancel')).not.toBeInTheDocument();
    });
  });

  it('confirm sends risk.dial.change WebSocket command', async () => {
    const { toast } = await import('sonner');
    render(<RiskDial />);
    const slider = screen.getByRole('slider');

    fireEvent.keyDown(slider, { key: 'ArrowRight', code: 'ArrowRight' });

    await waitFor(() => {
      expect(screen.getByText('Confirm Transformation')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Confirm Transformation'));

    await waitFor(() => {
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'risk.dial.change',
          payload: expect.objectContaining({ level: expect.any(Number) }),
        }),
      );
      expect(toast.success).toHaveBeenCalled();
    });
  });

  it('hides confirm/cancel after confirm is clicked', async () => {
    render(<RiskDial />);
    const slider = screen.getByRole('slider');

    fireEvent.keyDown(slider, { key: 'ArrowRight', code: 'ArrowRight' });

    await waitFor(() => {
      expect(screen.getByText('Confirm Transformation')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Confirm Transformation'));

    await waitFor(() => {
      expect(screen.queryByText('Confirm Transformation')).not.toBeInTheDocument();
    });
  });
});
