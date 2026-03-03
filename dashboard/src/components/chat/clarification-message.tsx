'use client';

import { useCallback } from 'react';
import { Button } from '@/components/ui/button';
import type { ChatMessage } from '@/stores/chat-store';
import { useChatStore } from '@/stores/chat-store';
import { useWebSocket } from '@/providers/ws-provider';
import { WS_COMMANDS } from '@/types/ws';

interface ClarificationMessageProps {
  message: ChatMessage;
}

export function ClarificationMessage({ message }: ClarificationMessageProps) {
  const { send } = useWebSocket();
  const { addMessage, setPending } = useChatStore();

  const handleOptionClick = useCallback(
    (option: string) => {
      const now = Date.now();
      // Add as user message optimistically
      addMessage({
        id: `clarify-${now}`,
        role: 'user',
        type: 'text',
        content: option,
        timestamp: now,
      });

      setPending(true);

      // Send via WebSocket
      send({
        command: WS_COMMANDS.CHAT_MESSAGE,
        payload: { text: option },
      });
    },
    [addMessage, setPending, send]
  );

  const hasOptions = message.options && message.options.length > 0;

  return (
    <div
      className="max-w-[75%] rounded-2xl rounded-tl-sm bg-zinc-800 px-4 py-3 text-sm"
      data-testid="clarification-message"
    >
      <p className="text-zinc-100 leading-relaxed">{message.content}</p>

      {hasOptions && (
        <div className="mt-3 flex flex-wrap gap-2" data-testid="clarification-options">
          {message.options!.map((option) => (
            <Button
              key={option}
              variant="outline"
              size="sm"
              className="h-7 rounded-full border-zinc-600 bg-zinc-700/50 px-3 text-xs text-zinc-300 hover:bg-zinc-600 hover:text-zinc-100 hover:border-zinc-500"
              onClick={() => handleOptionClick(option)}
              data-testid={`clarification-option-${option}`}
            >
              {option}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
