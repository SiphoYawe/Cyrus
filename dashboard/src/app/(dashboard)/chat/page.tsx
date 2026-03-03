'use client';

import { useEffect, useRef, useState } from 'react';
import { useChatStore } from '@/stores/chat-store';
import { useAgentStore } from '@/stores/agent-store';
import { usePortfolioStore } from '@/stores/portfolio-store';
import { ChatContainer } from '@/components/chat/chat-container';
import { ChatInput } from '@/components/chat/chat-input';

const WELCOME_SESSION_KEY = 'cyrus-chat-welcome-shown';

function formatUsd(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toFixed(2)}`;
}

function buildWelcomeMessage(
  chainCount: number,
  totalValue: number,
  regime: string
): string {
  const portfolioStr = formatUsd(totalValue);
  const regimeLabel = regime.charAt(0).toUpperCase() + regime.slice(1);
  return `I'm monitoring ${chainCount} chain${chainCount !== 1 ? 's' : ''}. Portfolio: ${portfolioStr}. Regime: ${regimeLabel}. How can I help?`;
}

export default function ChatPage() {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [inputValue, setInputValue] = useState('');

  const { addMessage, welcomeShown, setWelcomeShown } = useChatStore();
  const { regime, config } = useAgentStore();
  const { totalValue } = usePortfolioStore();

  // Focus input when Cmd+K pressed while on chat page
  useEffect(() => {
    function handleFocusEvent() {
      inputRef.current?.focus();
    }
    window.addEventListener('cyrus:focus-chat-input', handleFocusEvent);
    return () => window.removeEventListener('cyrus:focus-chat-input', handleFocusEvent);
  }, []);

  // Show welcome message on first session visit
  useEffect(() => {
    if (welcomeShown) return;

    const sessionShown =
      typeof sessionStorage !== 'undefined'
        ? sessionStorage.getItem(WELCOME_SESSION_KEY)
        : null;

    if (sessionShown === 'true') {
      setWelcomeShown();
      return;
    }

    const chainCount = config?.chains?.length ?? 0;
    const welcomeContent = buildWelcomeMessage(chainCount, totalValue, regime);

    // Short delay for entrance feel
    const timer = setTimeout(() => {
      addMessage({
        id: `welcome-${Date.now()}`,
        role: 'assistant',
        type: 'text',
        content: welcomeContent,
        timestamp: Date.now(),
      });

      if (typeof sessionStorage !== 'undefined') {
        sessionStorage.setItem(WELCOME_SESSION_KEY, 'true');
      }
      setWelcomeShown();
    }, 300);

    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className="flex h-full flex-col -m-6"
      data-testid="chat-page"
    >
      {/* Scrollable message history */}
      <ChatContainer className="min-h-0 flex-1" />

      {/* Fixed input bar at bottom */}
      <div className="border-t border-zinc-800 bg-zinc-950 px-4 py-3">
        <ChatInput
          ref={inputRef}
          value={inputValue}
          onChange={setInputValue}
        />
      </div>
    </div>
  );
}
