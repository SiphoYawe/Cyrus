'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { ChatMessage, PlanPreview } from '@/stores/chat-store';
import { useWebSocket } from '@/providers/ws-provider';
import { WS_COMMANDS } from '@/types/ws';
import { useChatStore } from '@/stores/chat-store';

function CheckIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function SpinnerIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="animate-spin"
      aria-hidden="true"
    >
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  );
}

interface PlanPreviewMessageProps {
  message: ChatMessage;
}

export function PlanPreviewMessage({ message }: PlanPreviewMessageProps) {
  const { send } = useWebSocket();
  const { confirmPlan, cancelPlan, addMessage } = useChatStore();
  const [isConfirming, setIsConfirming] = useState(false);
  const [resolved, setResolved] = useState<'confirmed' | 'cancelled' | null>(
    message.confirmed === true
      ? 'confirmed'
      : message.confirmed === false
      ? 'cancelled'
      : null
  );

  const plan = message.planPreview as PlanPreview;
  const isDisabled = resolved !== null || isConfirming;

  function handleConfirm() {
    if (isDisabled) return;
    setIsConfirming(true);
    confirmPlan(message.id);
    send({
      command: WS_COMMANDS.CHAT_CONFIRM,
      payload: { messageId: message.id },
    });
    setResolved('confirmed');
    setIsConfirming(false);
  }

  function handleCancel() {
    if (isDisabled) return;
    cancelPlan(message.id);
    send({
      command: WS_COMMANDS.CHAT_CANCEL,
      payload: { messageId: message.id },
    });
    setResolved('cancelled');

    // Add cancellation message
    addMessage({
      id: `cancel-${message.id}`,
      role: 'assistant',
      type: 'text',
      content: 'Cancelled.',
      timestamp: Date.now(),
    });
  }

  return (
    <div
      className="max-w-[75%] rounded-2xl rounded-tl-sm bg-zinc-800 px-4 py-3 text-sm"
      data-testid="plan-preview-message"
    >
      {/* Summary */}
      <p className="font-medium text-zinc-100 leading-relaxed">{plan?.summary ?? message.content}</p>

      {/* Plan details */}
      {plan && (
        <div className="mt-3 space-y-2.5">
          {plan.estimatedCost && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-zinc-500 w-24 shrink-0">Est. Cost</span>
              <Badge variant="outline" className="text-xs border-zinc-700 text-zinc-300">
                {plan.estimatedCost}
              </Badge>
            </div>
          )}

          {plan.affectedPositions && plan.affectedPositions.length > 0 && (
            <div className="flex items-start gap-2">
              <span className="text-xs text-zinc-500 w-24 shrink-0 pt-0.5">Positions</span>
              <div className="flex flex-wrap gap-1">
                {plan.affectedPositions.map((pos) => (
                  <Badge
                    key={pos}
                    variant="secondary"
                    className="text-xs bg-zinc-700 text-zinc-300"
                  >
                    {pos}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {plan.steps && plan.steps.length > 0 && (
            <div className="mt-3 space-y-1.5 border-t border-zinc-700 pt-3">
              {plan.steps.map((step, i) => (
                <div key={i} className="flex items-start gap-2 text-xs text-zinc-400">
                  <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-zinc-700 text-xs font-medium text-zinc-300 mt-0.5">
                    {i + 1}
                  </span>
                  <span>{step}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Action buttons or resolution status */}
      <div className="mt-4 flex items-center gap-2">
        {resolved === null ? (
          <>
            <Button
              size="sm"
              variant="default"
              className={cn(
                'h-8 gap-1.5 bg-violet-500 hover:bg-violet-600 text-white text-xs font-medium',
                isConfirming && 'opacity-70 cursor-not-allowed'
              )}
              onClick={handleConfirm}
              disabled={isDisabled}
              data-testid="plan-confirm-button"
            >
              {isConfirming ? <SpinnerIcon /> : <CheckIcon />}
              Confirm
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-8 gap-1.5 text-zinc-400 hover:text-zinc-200 text-xs"
              onClick={handleCancel}
              disabled={isDisabled}
              data-testid="plan-cancel-button"
            >
              <XIcon />
              Cancel
            </Button>
          </>
        ) : (
          <span
            className={cn(
              'text-xs font-medium',
              resolved === 'confirmed' ? 'text-violet-400' : 'text-zinc-500'
            )}
          >
            {resolved === 'confirmed' ? 'Confirmed — executing...' : 'Cancelled'}
          </span>
        )}
      </div>
    </div>
  );
}
