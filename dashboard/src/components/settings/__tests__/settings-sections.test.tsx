import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ChainsSettings } from '../chains-settings';
import { StrategiesSettings } from '../strategies-settings';
import { AgentSettings } from '../agent-settings';
import { ApiKeysSettings } from '../api-keys-settings';

const mockSend = vi.fn();

vi.mock('@/providers/ws-provider', () => ({
  useWebSocket: () => ({ send: mockSend, status: 'connected' }),
}));

vi.mock('@/stores/agent-store', () => ({
  useAgentStore: (selector: (s: { activeStrategies: string[] }) => unknown) =>
    selector({ activeStrategies: ['YieldHunter'] }),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// ---- ChainsSettings --------------------------------------------------------

describe('ChainsSettings', () => {
  beforeEach(() => mockSend.mockClear());

  it('renders all 6 supported chains', () => {
    render(<ChainsSettings />);
    expect(screen.getByText('Ethereum')).toBeInTheDocument();
    expect(screen.getByText('Arbitrum')).toBeInTheDocument();
    expect(screen.getByText('Optimism')).toBeInTheDocument();
    expect(screen.getByText('Polygon')).toBeInTheDocument();
    expect(screen.getByText('Base')).toBeInTheDocument();
    expect(screen.getByText('BSC')).toBeInTheDocument();
  });

  it('renders chain ID labels', () => {
    render(<ChainsSettings />);
    expect(screen.getByText('Chain ID 1')).toBeInTheDocument();
    expect(screen.getByText('Chain ID 42161')).toBeInTheDocument();
  });

  it('sends config.update when a chain is toggled', async () => {
    render(<ChainsSettings />);
    const switches = screen.getAllByRole('switch');
    fireEvent.click(switches[0]); // toggle Ethereum

    await waitFor(() => {
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'config.update',
          payload: expect.objectContaining({ chains: expect.any(Object) }),
        }),
      );
    });
  });

  it('all chain toggles are accessible via aria-label', () => {
    render(<ChainsSettings />);
    const toggle = screen.getByRole('switch', { name: /Toggle Ethereum/i });
    expect(toggle).toBeInTheDocument();
  });
});

// ---- StrategiesSettings ----------------------------------------------------

describe('StrategiesSettings', () => {
  beforeEach(() => mockSend.mockClear());

  it('renders YieldHunter, CrossChainArb, StatArb strategies', () => {
    render(<StrategiesSettings />);
    expect(screen.getByText('YieldHunter')).toBeInTheDocument();
    expect(screen.getByText('CrossChainArb')).toBeInTheDocument();
    expect(screen.getByText('StatArb')).toBeInTheDocument();
  });

  it('sends strategy.toggle when a strategy switch is clicked', async () => {
    render(<StrategiesSettings />);
    const toggle = screen.getByRole('switch', { name: /Toggle YieldHunter/i });
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'strategy.toggle',
          payload: expect.objectContaining({ strategy: 'YieldHunter' }),
        }),
      );
    });
  });

  it('expands strategy param editor on trigger click', async () => {
    render(<StrategiesSettings />);
    const expandButton = screen.getAllByRole('button')[0];
    fireEvent.click(expandButton);

    await waitFor(() => {
      expect(screen.getByText('Parameters')).toBeInTheDocument();
    });
  });

  it('shows Save Parameters button when a param is changed', async () => {
    render(<StrategiesSettings />);
    const expandButton = screen.getAllByRole('button')[0];
    fireEvent.click(expandButton);

    await waitFor(() => {
      const input = screen.getByLabelText(/Min yield/i);
      fireEvent.change(input, { target: { value: '75' } });
    });

    await waitFor(() => {
      expect(screen.getByText('Save Parameters')).toBeInTheDocument();
    });
  });
});

// ---- AgentSettings ---------------------------------------------------------

describe('AgentSettings', () => {
  beforeEach(() => mockSend.mockClear());

  it('renders tick interval input', () => {
    render(<AgentSettings />);
    expect(screen.getByLabelText(/Tick Interval/i)).toBeInTheDocument();
  });

  it('renders log level select', () => {
    render(<AgentSettings />);
    expect(screen.getByText(/Log Level/i)).toBeInTheDocument();
  });

  it('renders confirmation threshold slider', () => {
    render(<AgentSettings />);
    const slider = screen.getByRole('slider', { name: /Confirmation threshold/i });
    expect(slider).toBeInTheDocument();
    expect(slider).toHaveAttribute('aria-valuenow', '3');
    expect(slider).toHaveAttribute('aria-valuemin', '1');
    expect(slider).toHaveAttribute('aria-valuemax', '12');
  });

  it('sends config.update when tick interval changes', async () => {
    vi.useFakeTimers();
    render(<AgentSettings />);
    const input = screen.getByLabelText(/Tick Interval/i);
    fireEvent.change(input, { target: { value: '60' } });

    // Run all pending timers to flush the 600ms debounce
    vi.runAllTimers();
    vi.useRealTimers();

    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'config.update',
        payload: expect.objectContaining({ tickIntervalMs: 60000 }),
      }),
    );
  });
});

// ---- ApiKeysSettings -------------------------------------------------------

describe('ApiKeysSettings', () => {
  it('renders all three API key entries', () => {
    render(<ApiKeysSettings />);
    expect(screen.getByText('LI.FI API Key')).toBeInTheDocument();
    expect(screen.getByText('Anthropic API Key')).toBeInTheDocument();
    expect(screen.getByText('Wallet Private Key')).toBeInTheDocument();
  });

  it('shows env var names for each key', () => {
    render(<ApiKeysSettings />);
    expect(screen.getByText('LIFI_API_KEY')).toBeInTheDocument();
    expect(screen.getByText('ANTHROPIC_API_KEY')).toBeInTheDocument();
    expect(screen.getByText('CYRUS_PRIVATE_KEY')).toBeInTheDocument();
  });

  it('shows Configured or Missing badges (not actual key values)', () => {
    render(<ApiKeysSettings />);
    const badges = screen.getAllByRole('generic').filter((el) => {
      const text = el.textContent ?? '';
      return text === 'Configured' || text === 'Missing';
    });
    expect(badges.length).toBeGreaterThan(0);
  });

  it('shows note that keys are never editable from UI', () => {
    render(<ApiKeysSettings />);
    expect(
      screen.getByText(/never displayed or editable from this UI/i),
    ).toBeInTheDocument();
  });
});
