'use client';

import { useRef, KeyboardEvent, forwardRef } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useWebSocket } from '@/providers/ws-provider';
import { useChatStore } from '@/stores/chat-store';
import { WS_COMMANDS } from '@/types/ws';

// Inline send icon (paper plane) — uses HugeiconsIcon-style SVG inline, no Lucide
function SendIcon({ className }: { className?: string }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  );
}

interface ChatInputProps {
  value: string;
  onChange: (value: string) => void;
  className?: string;
}

export const ChatInput = forwardRef<HTMLTextAreaElement, ChatInputProps>(
  function ChatInput({ value, onChange, className }, ref) {
    const { send } = useWebSocket();
    const { addMessage, setPending, pending } = useChatStore();
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);

    // Merge refs
    function setRef(el: HTMLTextAreaElement | null) {
      textareaRef.current = el;
      if (typeof ref === 'function') {
        ref(el);
      } else if (ref) {
        (ref as React.MutableRefObject<HTMLTextAreaElement | null>).current = el;
      }
    }

    const isEmpty = value.trim().length === 0;
    const isDisabled = pending;

    function sendMessage() {
      const text = value.trim();
      if (!text || isDisabled) return;

      // Optimistic user message
      addMessage({
        id: `user-${Date.now()}`,
        role: 'user',
        type: 'text',
        content: text,
        timestamp: Date.now(),
      });

      // Mark pending
      setPending(true);

      // Send via WebSocket
      send({
        command: WS_COMMANDS.CHAT_MESSAGE,
        payload: { text },
      });

      // Clear input
      onChange('');

      // Reset textarea height
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }
    }

    function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    }

    function handleInput(e: React.ChangeEvent<HTMLTextAreaElement>) {
      onChange(e.target.value);
      // Auto-resize
      const el = e.target;
      el.style.height = 'auto';
      el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
    }

    return (
      <div
        className={cn(
          'flex items-end gap-2 rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-2 transition-colors',
          'focus-within:border-violet-500/50',
          isDisabled && 'opacity-70',
          className
        )}
        data-testid="chat-input-container"
      >
        <textarea
          ref={setRef}
          value={value}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          placeholder="Message CYRUS... (⌘K)"
          disabled={isDisabled}
          rows={1}
          className={cn(
            'flex-1 resize-none bg-transparent text-sm text-zinc-100',
            'placeholder:text-zinc-500',
            'focus:outline-none',
            'disabled:cursor-not-allowed',
            'max-h-40 min-h-[1.5rem]',
            'leading-6'
          )}
          aria-label="Message CYRUS"
          data-testid="chat-textarea"
        />
        <Button
          size="icon-sm"
          variant={isEmpty || isDisabled ? 'ghost' : 'default'}
          className={cn(
            'h-8 w-8 shrink-0 rounded-lg transition-all',
            isEmpty || isDisabled
              ? 'text-zinc-600 cursor-default'
              : 'bg-violet-500 text-white hover:bg-violet-600'
          )}
          onClick={sendMessage}
          disabled={isEmpty || isDisabled}
          aria-label="Send message"
          data-testid="chat-send-button"
        >
          <SendIcon />
        </Button>
      </div>
    );
  }
);
