'use client';

import { cn } from '@/lib/utils';
import type { ChatMessage } from '@/stores/chat-store';
import { TypingIndicator } from './typing-indicator';

interface CyrusAvatarProps {
  className?: string;
}

function CyrusAvatar({ className }: CyrusAvatarProps) {
  return (
    <div
      className={cn(
        'flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full',
        'bg-gradient-to-br from-violet-600 to-violet-400',
        'text-sm font-bold text-white select-none',
        className
      )}
      aria-label="CYRUS avatar"
    >
      C
    </div>
  );
}

interface UserAvatarProps {
  address?: string;
  className?: string;
}

function UserAvatar({ address, className }: UserAvatarProps) {
  return (
    <div
      className={cn(
        'flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full',
        'bg-zinc-700 text-xs font-medium text-zinc-300 select-none',
        className
      )}
      title={address ? `${address.slice(0, 4)}...${address.slice(-4)}` : 'You'}
      aria-label="User avatar"
    >
      {address ? `${address.slice(0, 2)}` : 'U'}
    </div>
  );
}

function formatTimestamp(timestamp: number): string {
  const diffMs = Date.now() - timestamp;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHr = Math.floor(diffMin / 60);

  if (diffSec < 60) return 'just now';
  if (diffMin < 60) return `${diffMin} min ago`;
  return `${diffHr}h ago`;
}

interface MessageBubbleProps {
  message: ChatMessage;
  walletAddress?: string;
  isTyping?: boolean;
}

export function MessageBubble({ message, walletAddress, isTyping }: MessageBubbleProps) {
  const isAssistant = message.role === 'assistant';

  return (
    <div
      className={cn(
        'group flex gap-3',
        isAssistant ? 'flex-row' : 'flex-row-reverse'
      )}
      data-testid={`message-bubble-${message.role}`}
      data-message-id={message.id}
    >
      {isAssistant ? (
        <CyrusAvatar />
      ) : (
        <UserAvatar address={walletAddress} />
      )}

      <div
        className={cn(
          'max-w-[75%] rounded-2xl px-4 py-3 text-sm leading-relaxed',
          isAssistant
            ? 'rounded-tl-sm bg-zinc-800 text-zinc-100'
            : 'rounded-tr-sm bg-violet-500/10 text-zinc-100 border border-violet-500/20'
        )}
      >
        {isTyping ? (
          <TypingIndicator />
        ) : (
          <p className="whitespace-pre-wrap break-words">{message.content}</p>
        )}

        {/* Timestamp on hover */}
        <p
          className={cn(
            'mt-1 text-xs opacity-0 transition-opacity group-hover:opacity-100',
            isAssistant ? 'text-zinc-500' : 'text-violet-400/60'
          )}
          aria-label={`Sent ${formatTimestamp(message.timestamp)}`}
        >
          {formatTimestamp(message.timestamp)}
        </p>
      </div>
    </div>
  );
}
