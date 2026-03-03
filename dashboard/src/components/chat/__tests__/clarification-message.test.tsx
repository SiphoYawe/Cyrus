import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ClarificationMessage } from '../clarification-message';
import { useChatStore } from '@/stores/chat-store';
import type { ChatMessage } from '@/stores/chat-store';

const mockSend = vi.fn();
vi.mock('@/providers/ws-provider', () => ({
  useWebSocket: () => ({
    send: mockSend,
    status: 'connected',
  }),
}));

function makeClarificationMessage(options?: string[]): ChatMessage {
  return {
    id: 'clarify-1',
    role: 'assistant',
    type: 'clarification',
    content: 'How much would you like to move?',
    timestamp: Date.now(),
    options,
  };
}

describe('ClarificationMessage', () => {
  beforeEach(() => {
    mockSend.mockClear();
    useChatStore.setState({ messages: [], pending: false });
  });

  it('renders clarification text', () => {
    render(<ClarificationMessage message={makeClarificationMessage()} />);
    expect(screen.getByText('How much would you like to move?')).toBeInTheDocument();
  });

  it('renders option chips when options are provided', () => {
    const options = ['10%', '20%', '50%'];
    render(<ClarificationMessage message={makeClarificationMessage(options)} />);

    expect(screen.getByTestId('clarification-options')).toBeInTheDocument();
    options.forEach((opt) => {
      expect(screen.getByTestId(`clarification-option-${opt}`)).toBeInTheDocument();
    });
  });

  it('does not render options section when no options', () => {
    render(<ClarificationMessage message={makeClarificationMessage()} />);
    expect(screen.queryByTestId('clarification-options')).not.toBeInTheDocument();
  });

  it('clicking option sends message via WebSocket', () => {
    const options = ['10%', '20%'];
    render(<ClarificationMessage message={makeClarificationMessage(options)} />);

    fireEvent.click(screen.getByTestId('clarification-option-10%'));

    expect(mockSend).toHaveBeenCalledWith({
      command: 'chat.message',
      payload: { text: '10%' },
    });
  });

  it('clicking option adds user message to store', () => {
    const options = ['10%'];
    render(<ClarificationMessage message={makeClarificationMessage(options)} />);

    fireEvent.click(screen.getByTestId('clarification-option-10%'));

    const messages = useChatStore.getState().messages;
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
    expect(messages[0].content).toBe('10%');
  });

  it('clicking option sets pending true', () => {
    const options = ['20%'];
    render(<ClarificationMessage message={makeClarificationMessage(options)} />);

    fireEvent.click(screen.getByTestId('clarification-option-20%'));

    expect(useChatStore.getState().pending).toBe(true);
  });
});
