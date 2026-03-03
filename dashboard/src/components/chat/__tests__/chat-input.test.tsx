import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ChatInput } from '../chat-input';
import { useChatStore } from '@/stores/chat-store';

// Mock WebSocket
const mockSend = vi.fn();
vi.mock('@/providers/ws-provider', () => ({
  useWebSocket: () => ({
    send: mockSend,
    status: 'connected',
  }),
}));

describe('ChatInput', () => {
  const mockOnChange = vi.fn();

  beforeEach(() => {
    mockSend.mockClear();
    mockOnChange.mockClear();
    useChatStore.setState({ messages: [], pending: false });
  });

  it('renders textarea and send button', () => {
    render(<ChatInput value="" onChange={mockOnChange} />);
    expect(screen.getByTestId('chat-textarea')).toBeInTheDocument();
    expect(screen.getByTestId('chat-send-button')).toBeInTheDocument();
  });

  it('send button is disabled when input is empty', () => {
    render(<ChatInput value="" onChange={mockOnChange} />);
    expect(screen.getByTestId('chat-send-button')).toBeDisabled();
  });

  it('send button is enabled when input has text', () => {
    render(<ChatInput value="Move funds" onChange={mockOnChange} />);
    expect(screen.getByTestId('chat-send-button')).not.toBeDisabled();
  });

  it('pressing Enter sends message and clears input', () => {
    render(<ChatInput value="Move funds to Aave" onChange={mockOnChange} />);

    const textarea = screen.getByTestId('chat-textarea');
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

    // onChange called with empty string to clear
    expect(mockOnChange).toHaveBeenCalledWith('');
    // WebSocket send called
    expect(mockSend).toHaveBeenCalledWith({
      command: 'chat.message',
      payload: { text: 'Move funds to Aave' },
    });
  });

  it('pressing Shift+Enter does not send', () => {
    render(<ChatInput value="Line 1" onChange={mockOnChange} />);

    const textarea = screen.getByTestId('chat-textarea');
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });

    expect(mockSend).not.toHaveBeenCalled();
    expect(mockOnChange).not.toHaveBeenCalled();
  });

  it('clicking send button sends message', () => {
    render(<ChatInput value="Do something" onChange={mockOnChange} />);

    fireEvent.click(screen.getByTestId('chat-send-button'));

    expect(mockSend).toHaveBeenCalledWith({
      command: 'chat.message',
      payload: { text: 'Do something' },
    });
    expect(mockOnChange).toHaveBeenCalledWith('');
  });

  it('adds optimistic user message to store on send', () => {
    render(<ChatInput value="Bridge funds" onChange={mockOnChange} />);

    fireEvent.click(screen.getByTestId('chat-send-button'));

    const messages = useChatStore.getState().messages;
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
    expect(messages[0].content).toBe('Bridge funds');
  });

  it('sets pending true after send', () => {
    render(<ChatInput value="Test" onChange={mockOnChange} />);

    fireEvent.click(screen.getByTestId('chat-send-button'));

    expect(useChatStore.getState().pending).toBe(true);
  });

  it('is disabled when pending', () => {
    useChatStore.setState({ pending: true });
    render(<ChatInput value="Some text" onChange={mockOnChange} />);

    expect(screen.getByTestId('chat-textarea')).toBeDisabled();
  });

  it('shows placeholder with keyboard shortcut hint', () => {
    render(<ChatInput value="" onChange={mockOnChange} />);
    const textarea = screen.getByTestId('chat-textarea');
    expect(textarea).toHaveAttribute('placeholder', 'Message CYRUS... (⌘K)');
  });
});
