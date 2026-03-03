import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MessageBubble } from '../message-bubble';
import type { ChatMessage } from '@/stores/chat-store';

function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'test-id',
    role: 'user',
    type: 'text',
    content: 'Hello CYRUS',
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('MessageBubble', () => {
  it('renders user message right-aligned with violet background', () => {
    const message = makeMessage({ role: 'user', content: 'Test user message' });
    const { container } = render(<MessageBubble message={message} />);

    // The outer container should have flex-row-reverse for user messages
    const wrapper = container.querySelector('[data-testid="message-bubble-user"]');
    expect(wrapper).toBeInTheDocument();
    expect(wrapper).toHaveClass('flex-row-reverse');

    // Message content renders
    expect(screen.getByText('Test user message')).toBeInTheDocument();
  });

  it('renders assistant message left-aligned with zinc-800 background', () => {
    const message = makeMessage({ role: 'assistant', content: 'Hello! How can I help?' });
    const { container } = render(<MessageBubble message={message} />);

    const wrapper = container.querySelector('[data-testid="message-bubble-assistant"]');
    expect(wrapper).toBeInTheDocument();
    // assistant messages use flex-row (default, no flex-row-reverse)
    expect(wrapper).not.toHaveClass('flex-row-reverse');

    expect(screen.getByText('Hello! How can I help?')).toBeInTheDocument();
  });

  it('renders CYRUS avatar for assistant messages', () => {
    const message = makeMessage({ role: 'assistant', content: 'Hi' });
    render(<MessageBubble message={message} />);

    // CYRUS avatar has aria-label "CYRUS avatar"
    expect(screen.getByLabelText('CYRUS avatar')).toBeInTheDocument();
  });

  it('renders user avatar for user messages', () => {
    const message = makeMessage({ role: 'user', content: 'Hi' });
    render(<MessageBubble message={message} />);

    expect(screen.getByLabelText('User avatar')).toBeInTheDocument();
  });

  it('shows typing indicator when isTyping is true', () => {
    const message = makeMessage({ role: 'assistant', content: 'will be replaced by indicator' });
    render(<MessageBubble message={message} isTyping />);

    expect(screen.getByLabelText('CYRUS is typing')).toBeInTheDocument();
    // Typing indicator shown, not the content text
    expect(screen.queryByText('will be replaced by indicator')).not.toBeInTheDocument();
  });

  it('renders message content when not typing', () => {
    const message = makeMessage({ role: 'assistant', content: 'Plan generated.' });
    render(<MessageBubble message={message} />);

    expect(screen.getByText('Plan generated.')).toBeInTheDocument();
    expect(screen.queryByLabelText('CYRUS is typing')).not.toBeInTheDocument();
  });

  it('shows message id as data attribute', () => {
    const message = makeMessage({ id: 'my-unique-id', role: 'user', content: 'Test' });
    const { container } = render(<MessageBubble message={message} />);

    const wrapper = container.querySelector('[data-message-id="my-unique-id"]');
    expect(wrapper).toBeInTheDocument();
  });
});
