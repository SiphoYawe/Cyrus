import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import ChatPage from '@/app/(dashboard)/chat/page';
import { useChatStore } from '@/stores/chat-store';
import { useAgentStore } from '@/stores/agent-store';
import { usePortfolioStore } from '@/stores/portfolio-store';

// Mock Next.js navigation
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/chat',
}));

// Mock WebSocket
vi.mock('@/providers/ws-provider', () => ({
  useWebSocket: () => ({
    send: vi.fn(),
    status: 'connected',
  }),
}));

describe('ChatPage — Welcome Message', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useChatStore.setState({ messages: [], pending: false, welcomeShown: false });
    useAgentStore.setState({
      status: 'running',
      regime: 'bull',
      config: {
        mode: 'live',
        tickIntervalMs: 1000,
        chains: [1, 42161, 10],
        strategies: [],
        riskLevel: 5,
      },
      lastTick: null,
      tickCount: 0,
      error: null,
      activeStrategies: [],
    });
    usePortfolioStore.setState({
      totalValue: 12500,
      isLoading: false,
      balances: [],
      allocations: [],
      chainAllocations: [],
      dailyPnl: 0,
      dailyPnlPercent: 0,
      weightedYield: 0,
    });

    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.removeItem('cyrus-chat-welcome-shown');
    }
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('shows welcome message on first visit', async () => {
    render(<ChatPage />);

    await act(async () => {
      vi.advanceTimersByTime(400);
    });

    const messages = useChatStore.getState().messages;
    expect(messages.length).toBeGreaterThan(0);
    const welcome = messages.find((m) => m.content.includes("I'm monitoring"));
    expect(welcome).toBeDefined();
  });

  it('welcome message contains chain count, portfolio, and regime', async () => {
    render(<ChatPage />);

    await act(async () => {
      vi.advanceTimersByTime(400);
    });

    const messages = useChatStore.getState().messages;
    const welcome = messages.find((m) => m.content.includes("I'm monitoring"));
    expect(welcome).toBeDefined();
    expect(welcome?.content).toContain('3 chains');
    expect(welcome?.content).toContain('$12.5K');
    expect(welcome?.content).toContain('Bull');
  });

  it('does not show welcome message on second visit (welcomeShown=true)', async () => {
    useChatStore.setState({ welcomeShown: true, messages: [], pending: false });
    render(<ChatPage />);

    await act(async () => {
      vi.advanceTimersByTime(400);
    });

    const messages = useChatStore.getState().messages;
    const welcome = messages.find((m) => m.content.includes("I'm monitoring"));
    expect(welcome).toBeUndefined();
  });

  it('does not show welcome if sessionStorage flag is set', async () => {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.setItem('cyrus-chat-welcome-shown', 'true');
    }
    render(<ChatPage />);

    await act(async () => {
      vi.advanceTimersByTime(400);
    });

    const messages = useChatStore.getState().messages;
    const welcome = messages.find((m) => m.content.includes("I'm monitoring"));
    expect(welcome).toBeUndefined();
  });

  it('sets sessionStorage flag after showing welcome', async () => {
    render(<ChatPage />);

    await act(async () => {
      vi.advanceTimersByTime(400);
    });

    if (typeof sessionStorage !== 'undefined') {
      expect(sessionStorage.getItem('cyrus-chat-welcome-shown')).toBe('true');
    }
  });

  it('sets welcomeShown in store after showing welcome', async () => {
    render(<ChatPage />);

    await act(async () => {
      vi.advanceTimersByTime(400);
    });

    expect(useChatStore.getState().welcomeShown).toBe(true);
  });
});

describe('ChatPage — Layout', () => {
  beforeEach(() => {
    useChatStore.setState({ messages: [], pending: false, welcomeShown: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the chat page container', () => {
    render(<ChatPage />);
    expect(screen.getByTestId('chat-page')).toBeInTheDocument();
  });

  it('renders the messages area', () => {
    render(<ChatPage />);
    expect(screen.getByTestId('chat-messages-area')).toBeInTheDocument();
  });

  it('renders the chat input', () => {
    render(<ChatPage />);
    expect(screen.getByTestId('chat-textarea')).toBeInTheDocument();
  });
});

describe('ChatPage — Keyboard shortcut', () => {
  beforeEach(() => {
    useChatStore.setState({ messages: [], pending: false, welcomeShown: true });
  });

  it('focuses chat input when cyrus:focus-chat-input event fires', async () => {
    render(<ChatPage />);
    const textarea = screen.getByTestId('chat-textarea');

    await act(async () => {
      window.dispatchEvent(new CustomEvent('cyrus:focus-chat-input'));
    });

    expect(document.activeElement).toBe(textarea);
  });
});
