'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { cn } from '@/lib/utils';
import { useChatStore } from '@/stores/chat-store';
import { useWebSocket } from '@/providers/ws-provider';
import { MessageBubble } from './message-bubble';
import { PlanPreviewMessage } from './plan-preview-message';
import { ClarificationMessage } from './clarification-message';
import { TypingIndicator } from './typing-indicator';
import type { ChatMessage } from '@/stores/chat-store';

function ChevronDownIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function CyrusAvatar() {
  return (
    <div
      className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-violet-600 to-violet-400 text-sm font-bold text-white select-none"
      aria-label="CYRUS avatar"
    >
      C
    </div>
  );
}

function DisconnectedBanner() {
  return (
    <div className="flex items-center justify-center gap-2 rounded-lg border border-yellow-500/20 bg-yellow-500/10 px-4 py-2.5 text-xs text-yellow-400">
      <span>Reconnecting to CYRUS...</span>
    </div>
  );
}

function renderMessage(message: ChatMessage) {
  switch (message.type) {
    case 'plan_preview':
      return (
        <div key={message.id} className="flex gap-3" data-testid="plan-preview-row">
          <CyrusAvatar />
          <PlanPreviewMessage message={message} />
        </div>
      );
    case 'clarification':
      return (
        <div key={message.id} className="flex gap-3" data-testid="clarification-row">
          <CyrusAvatar />
          <ClarificationMessage message={message} />
        </div>
      );
    default:
      return <MessageBubble key={message.id} message={message} />;
  }
}

interface ChatContainerProps {
  className?: string;
}

export function ChatContainer({ className }: ChatContainerProps) {
  const messages = useChatStore((s) => s.messages);
  const pending = useChatStore((s) => s.pending);
  const { status: wsStatus } = useWebSocket();

  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const isUserScrolledUp = useRef(false);

  const scrollToBottom = useCallback((smooth = true) => {
    messagesEndRef.current?.scrollIntoView({ behavior: smooth ? 'smooth' : 'instant' });
  }, []);

  // Auto-scroll on new messages unless user scrolled up
  useEffect(() => {
    if (!isUserScrolledUp.current) {
      scrollToBottom(true);
    }
  }, [messages, pending, scrollToBottom]);

  // Track scroll position to show/hide scroll-to-bottom button
  function handleScroll() {
    const el = scrollAreaRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const scrolledUp = distanceFromBottom > 80;
    isUserScrolledUp.current = scrolledUp;
    setShowScrollButton(scrolledUp);
  }

  const isDisconnected = wsStatus === 'disconnected';

  return (
    <div className={cn('relative flex flex-1 flex-col overflow-hidden', className)}>
      {/* Message area */}
      <div
        ref={scrollAreaRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-4 py-4 space-y-4"
        data-testid="chat-messages-area"
      >
        {messages.map((message) => renderMessage(message))}

        {/* Typing indicator */}
        {pending && (
          <div className="flex gap-3" data-testid="typing-indicator-row">
            <CyrusAvatar />
            <div className="rounded-2xl rounded-tl-sm bg-zinc-800 px-4 py-3">
              <TypingIndicator />
            </div>
          </div>
        )}

        {/* Disconnected banner */}
        {isDisconnected && (
          <DisconnectedBanner />
        )}

        {/* Scroll anchor */}
        <div ref={messagesEndRef} className="h-0" aria-hidden="true" />
      </div>

      {/* Scroll-to-bottom button */}
      {showScrollButton && (
        <button
          type="button"
          onClick={() => {
            isUserScrolledUp.current = false;
            setShowScrollButton(false);
            scrollToBottom(true);
          }}
          className="absolute bottom-2 right-4 z-10 flex h-8 w-8 items-center justify-center rounded-full border border-zinc-700 bg-zinc-800 text-zinc-400 shadow-lg hover:bg-zinc-700 hover:text-zinc-100 transition-colors"
          aria-label="Scroll to bottom"
          data-testid="scroll-to-bottom-button"
        >
          <ChevronDownIcon />
        </button>
      )}
    </div>
  );
}
