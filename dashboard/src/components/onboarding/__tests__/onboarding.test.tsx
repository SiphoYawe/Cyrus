import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { OnboardingWizard } from '../onboarding-wizard';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock ws-provider (required by any component tree touching agent store)
vi.mock('@/providers/ws-provider', () => ({
  useWebSocket: () => ({ send: vi.fn(), status: 'connected' }),
  WebSocketProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
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

// Mock recharts (avoid SVG issues in jsdom)
vi.mock('recharts', () => ({
  PieChart: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="pie-chart">{children}</div>
  ),
  Pie: () => null,
  Cell: () => null,
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

// Mock qrcode.react
vi.mock('qrcode.react', () => ({
  QRCodeSVG: (props: Record<string, unknown>) => (
    <svg data-testid={props['data-testid'] ?? 'qr-code'} />
  ),
}));

// Mock canvas-confetti
vi.mock('canvas-confetti', () => ({
  default: vi.fn(),
}));

// ---------------------------------------------------------------------------
// localStorage helpers
// ---------------------------------------------------------------------------

function clearOnboardingStorage() {
  localStorage.removeItem('cyrus-onboarding-step');
  localStorage.removeItem('cyrus-onboarding-completed');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OnboardingWizard', () => {
  beforeEach(() => {
    clearOnboardingStorage();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    clearOnboardingStorage();
  });

  // -------------------------------------------------------------------------
  // Wizard launch check
  // -------------------------------------------------------------------------
  describe('wizard launch check', () => {
    it('renders the wizard when onboarding is not completed', async () => {
      render(<OnboardingWizard />);

      await act(async () => {
        vi.advanceTimersByTime(0);
      });

      expect(screen.getByTestId('onboarding-wizard')).toBeInTheDocument();
    });

    it('does not render the wizard when onboarding is completed', async () => {
      localStorage.setItem('cyrus-onboarding-completed', 'true');

      render(<OnboardingWizard />);

      await act(async () => {
        vi.advanceTimersByTime(0);
      });

      expect(screen.queryByTestId('onboarding-wizard')).not.toBeInTheDocument();
    });

    it('resumes from persisted step index', async () => {
      localStorage.setItem('cyrus-onboarding-step', '2');

      render(<OnboardingWizard />);

      await act(async () => {
        vi.advanceTimersByTime(0);
      });

      // Step 2 = "Select Chains" — the heading is in the step content
      // The step indicator nav also has "Select Chains" in a span.
      // Use the h2 heading to be specific.
      const headings = screen.getAllByRole('heading', { level: 2 });
      const selectChainsHeading = headings.find((h) =>
        h.textContent?.includes('Select Chains'),
      );
      expect(selectChainsHeading).toBeTruthy();
    });
  });

  // -------------------------------------------------------------------------
  // Step navigation
  // -------------------------------------------------------------------------
  describe('step navigation', () => {
    it('starts at step 1 (Connect Wallet) and advances to step 2 on Continue', async () => {
      render(<OnboardingWizard />);

      await act(async () => {
        vi.advanceTimersByTime(0);
      });

      // Step 1: Connect Wallet
      expect(screen.getByText('Wallet Connected')).toBeInTheDocument();
      expect(screen.getByText(/Step 1 of 6/)).toBeInTheDocument();

      // Click Continue
      fireEvent.click(screen.getByTestId('onboarding-next'));

      // Step 2: Risk Profile
      await waitFor(() => {
        expect(screen.getByText('Set Your Risk Profile')).toBeInTheDocument();
      });
    });

    it('navigates forward through all steps', async () => {
      render(<OnboardingWizard />);

      await act(async () => {
        vi.advanceTimersByTime(0);
      });

      // Step 1: Connect Wallet
      expect(screen.getByText('Wallet Connected')).toBeInTheDocument();
      fireEvent.click(screen.getByTestId('onboarding-next'));

      // Step 2: Risk Profile
      await waitFor(() => {
        expect(screen.getByText('Set Your Risk Profile')).toBeInTheDocument();
      });
      fireEvent.click(screen.getByTestId('onboarding-next'));

      // Step 3: Select Chains — use heading role to be specific
      await waitFor(() => {
        const headings = screen.getAllByRole('heading', { level: 2 });
        expect(
          headings.some((h) => h.textContent?.includes('Select Chains')),
        ).toBe(true);
      });
      fireEvent.click(screen.getByTestId('onboarding-next'));

      // Step 4: Review Strategy
      await waitFor(() => {
        expect(screen.getByText('Review Strategy Defaults')).toBeInTheDocument();
      });
      fireEvent.click(screen.getByTestId('onboarding-next'));

      // Step 5: Fund Wallet
      await waitFor(() => {
        expect(screen.getByText('Fund Agent Wallet')).toBeInTheDocument();
      });
      fireEvent.click(screen.getByTestId('onboarding-next'));

      // Step 6: Launch Agent
      await waitFor(() => {
        expect(screen.getByText('Launch CYRUS')).toBeInTheDocument();
      });
    });

    it('can go back from step 2 to step 1', async () => {
      render(<OnboardingWizard />);

      await act(async () => {
        vi.advanceTimersByTime(0);
      });

      // Go to step 2
      fireEvent.click(screen.getByTestId('onboarding-next'));

      await waitFor(() => {
        expect(screen.getByText('Set Your Risk Profile')).toBeInTheDocument();
      });

      // Go back to step 1
      fireEvent.click(screen.getByTestId('onboarding-back'));

      await waitFor(() => {
        expect(screen.getByText('Wallet Connected')).toBeInTheDocument();
      });
    });

    it('shows progress bar that increases with each step', async () => {
      render(<OnboardingWizard />);

      await act(async () => {
        vi.advanceTimersByTime(0);
      });

      const progressBar = screen.getByTestId('onboarding-progress');

      // Step 1 of 6 = ~16.67%
      expect(progressBar).toHaveStyle({ width: `${(1 / 6) * 100}%` });

      // Advance to step 2
      fireEvent.click(screen.getByTestId('onboarding-next'));

      await waitFor(() => {
        // Step 2 of 6 = ~33.33%
        expect(progressBar).toHaveStyle({ width: `${(2 / 6) * 100}%` });
      });
    });

    it('persists step to localStorage on navigation', async () => {
      render(<OnboardingWizard />);

      await act(async () => {
        vi.advanceTimersByTime(0);
      });

      // Step 1 -> 2
      fireEvent.click(screen.getByTestId('onboarding-next'));

      await waitFor(() => {
        expect(screen.getByText('Set Your Risk Profile')).toBeInTheDocument();
      });

      // Allow the persist effect to run
      await act(async () => {
        vi.advanceTimersByTime(0);
      });

      expect(localStorage.getItem('cyrus-onboarding-step')).toBe('1');
    });
  });

  // -------------------------------------------------------------------------
  // Completion persistence
  // -------------------------------------------------------------------------
  describe('completion persistence', () => {
    it('sets completed flag in localStorage when agent is launched', async () => {
      // Start at step 5 (launch agent)
      localStorage.setItem('cyrus-onboarding-step', '5');

      render(<OnboardingWizard />);

      await act(async () => {
        vi.advanceTimersByTime(0);
      });

      // Should be on launch step
      expect(screen.getByText('Launch CYRUS')).toBeInTheDocument();

      // Click Launch Agent
      fireEvent.click(screen.getByTestId('launch-agent-button'));

      // Advance past the 1.5s launch delay
      await act(async () => {
        vi.advanceTimersByTime(2000);
      });

      // Should show success — wizard stays visible after completion
      await waitFor(() => {
        expect(screen.getByTestId('launch-success')).toBeInTheDocument();
      });

      expect(localStorage.getItem('cyrus-onboarding-completed')).toBe('true');
    });

    it('removes step key from localStorage on completion', async () => {
      localStorage.setItem('cyrus-onboarding-step', '5');

      render(<OnboardingWizard />);

      await act(async () => {
        vi.advanceTimersByTime(0);
      });

      fireEvent.click(screen.getByTestId('launch-agent-button'));

      await act(async () => {
        vi.advanceTimersByTime(2000);
      });

      await waitFor(() => {
        expect(screen.getByTestId('launch-success')).toBeInTheDocument();
      });

      expect(localStorage.getItem('cyrus-onboarding-step')).toBeNull();
    });

    it('hides wizard when Go to Dashboard is clicked after launch', async () => {
      localStorage.setItem('cyrus-onboarding-step', '5');

      render(<OnboardingWizard />);

      await act(async () => {
        vi.advanceTimersByTime(0);
      });

      fireEvent.click(screen.getByTestId('launch-agent-button'));

      await act(async () => {
        vi.advanceTimersByTime(2000);
      });

      await waitFor(() => {
        expect(screen.getByTestId('launch-success')).toBeInTheDocument();
      });

      // Click Go to Dashboard — should dismiss the wizard
      fireEvent.click(screen.getByTestId('go-to-dashboard'));

      await waitFor(() => {
        expect(screen.queryByTestId('onboarding-wizard')).not.toBeInTheDocument();
      });
    });
  });

  // -------------------------------------------------------------------------
  // Step-specific features
  // -------------------------------------------------------------------------
  describe('step-specific features', () => {
    it('connect wallet step shows wallet address', async () => {
      render(<OnboardingWizard />);

      await act(async () => {
        vi.advanceTimersByTime(0);
      });

      expect(screen.getByTestId('wallet-address')).toHaveTextContent('0x742d...bD18');
    });

    it('select chains step shows chain cards', async () => {
      localStorage.setItem('cyrus-onboarding-step', '2');

      render(<OnboardingWizard />);

      await act(async () => {
        vi.advanceTimersByTime(0);
      });

      // Check that chain cards exist
      expect(screen.getByTestId('chain-card-1')).toBeInTheDocument();
      expect(screen.getByTestId('chain-card-42161')).toBeInTheDocument();
      expect(screen.getByTestId('chain-card-10')).toBeInTheDocument();
      expect(screen.getByTestId('chain-card-8453')).toBeInTheDocument();
      expect(screen.getByTestId('chain-card-137')).toBeInTheDocument();
      expect(screen.getByTestId('chain-card-56')).toBeInTheDocument();
    });

    it('select chains step allows toggling chains', async () => {
      localStorage.setItem('cyrus-onboarding-step', '2');

      render(<OnboardingWizard />);

      await act(async () => {
        vi.advanceTimersByTime(0);
      });

      // Default: 4 chains selected (Ethereum, Arbitrum, Optimism, Base)
      expect(screen.getByText('4 chains selected')).toBeInTheDocument();

      // Toggle Polygon on
      fireEvent.click(screen.getByTestId('chain-card-137'));

      await waitFor(() => {
        expect(screen.getByText('5 chains selected')).toBeInTheDocument();
      });

      // Toggle Ethereum off
      fireEvent.click(screen.getByTestId('chain-card-1'));

      await waitFor(() => {
        expect(screen.getByText('4 chains selected')).toBeInTheDocument();
      });
    });

    it('fund wallet step shows QR code and address', async () => {
      localStorage.setItem('cyrus-onboarding-step', '4');

      render(<OnboardingWizard />);

      await act(async () => {
        vi.advanceTimersByTime(0);
      });

      expect(screen.getByTestId('qr-code')).toBeInTheDocument();
      expect(screen.getByTestId('agent-wallet-address')).toBeInTheDocument();
      expect(screen.getByTestId('agent-balance')).toHaveTextContent('$0.00');
    });

    it('review strategy step shows YieldHunter defaults', async () => {
      localStorage.setItem('cyrus-onboarding-step', '3');

      render(<OnboardingWizard />);

      await act(async () => {
        vi.advanceTimersByTime(0);
      });

      expect(screen.getByText('YieldHunter')).toBeInTheDocument();
      expect(screen.getByText('0.5%')).toBeInTheDocument();
      expect(screen.getByText('$25/day')).toBeInTheDocument();
      expect(screen.getByText('3.0% APY')).toBeInTheDocument();
    });
  });
});
