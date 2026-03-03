import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PlanPreviewMessage } from '../plan-preview-message';
import { useChatStore } from '@/stores/chat-store';
import type { ChatMessage } from '@/stores/chat-store';

// Mock WebSocket provider
vi.mock('@/providers/ws-provider', () => ({
  useWebSocket: () => ({
    send: vi.fn(),
    status: 'connected',
  }),
}));

function makePlanMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'plan-1',
    role: 'assistant',
    type: 'plan_preview',
    content: 'Move 20% to Aave on Optimism',
    timestamp: Date.now(),
    planPreview: {
      summary: 'Move 20% of portfolio to Aave on Optimism',
      estimatedCost: '$2.50',
      affectedPositions: ['USDC on Arbitrum'],
      steps: [
        'Bridge USDC from Arbitrum to Optimism',
        'Deposit into Aave USDC pool',
      ],
    },
    ...overrides,
  };
}

describe('PlanPreviewMessage', () => {
  beforeEach(() => {
    useChatStore.setState({ messages: [], pending: false });
  });

  it('renders plan summary', () => {
    render(<PlanPreviewMessage message={makePlanMessage()} />);
    expect(screen.getByText('Move 20% of portfolio to Aave on Optimism')).toBeInTheDocument();
  });

  it('renders estimated cost', () => {
    render(<PlanPreviewMessage message={makePlanMessage()} />);
    expect(screen.getByText('$2.50')).toBeInTheDocument();
  });

  it('renders affected positions', () => {
    render(<PlanPreviewMessage message={makePlanMessage()} />);
    expect(screen.getByText('USDC on Arbitrum')).toBeInTheDocument();
  });

  it('renders steps', () => {
    render(<PlanPreviewMessage message={makePlanMessage()} />);
    expect(screen.getByText('Bridge USDC from Arbitrum to Optimism')).toBeInTheDocument();
    expect(screen.getByText('Deposit into Aave USDC pool')).toBeInTheDocument();
  });

  it('shows Confirm and Cancel buttons', () => {
    render(<PlanPreviewMessage message={makePlanMessage()} />);
    expect(screen.getByTestId('plan-confirm-button')).toBeInTheDocument();
    expect(screen.getByTestId('plan-cancel-button')).toBeInTheDocument();
  });

  it('confirm button calls confirmPlan in store', () => {
    const message = makePlanMessage();
    render(<PlanPreviewMessage message={message} />);

    fireEvent.click(screen.getByTestId('plan-confirm-button'));

    // Buttons should become disabled/hidden after confirm
    expect(screen.queryByTestId('plan-confirm-button')).not.toBeInTheDocument();
    expect(screen.queryByTestId('plan-cancel-button')).not.toBeInTheDocument();
    // Resolved state should show
    expect(screen.getByText(/Confirmed/i)).toBeInTheDocument();
  });

  it('cancel button adds cancelled message to store', () => {
    useChatStore.setState({ messages: [], pending: false });
    const message = makePlanMessage();
    render(<PlanPreviewMessage message={message} />);

    fireEvent.click(screen.getByTestId('plan-cancel-button'));

    const messages = useChatStore.getState().messages;
    const cancelMsg = messages.find((m) => m.content === 'Cancelled.');
    expect(cancelMsg).toBeDefined();
  });

  it('hides buttons after cancel', () => {
    const message = makePlanMessage();
    render(<PlanPreviewMessage message={message} />);

    fireEvent.click(screen.getByTestId('plan-cancel-button'));

    expect(screen.queryByTestId('plan-confirm-button')).not.toBeInTheDocument();
    expect(screen.queryByTestId('plan-cancel-button')).not.toBeInTheDocument();
    expect(screen.getByText('Cancelled')).toBeInTheDocument();
  });

  it('renders without planPreview data using message content', () => {
    const message: ChatMessage = {
      id: 'p2',
      role: 'assistant',
      type: 'plan_preview',
      content: 'Fallback content',
      timestamp: Date.now(),
    };
    render(<PlanPreviewMessage message={message} />);
    expect(screen.getByText('Fallback content')).toBeInTheDocument();
  });
});
