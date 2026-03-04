'use client';

import { useState, useCallback } from 'react';
function CheckmarkCircleSvg({ size }: { size?: number }) {
  const s = size ?? 24;
  return (
    <svg data-testid="checkmark-circle-icon" width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12L11 15L16 9" />
    </svg>
  );
}
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useTransfersStore } from '@/stores/transfers-store';
import { TransferStatusCard } from './transfer-status-card';
import { EmptyState } from '@/components/shared/empty-state';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';

const MAX_COMPLETED_SHOWN = 5;

export function TransferList({ className }: { className?: string }) {
  const active = useTransfersStore((s) => s.active);
  const completed = useTransfersStore((s) => s.completed);
  const [completedOpen, setCompletedOpen] = useState(false);

  // IDs that have faded out from active area but not yet in store's completed list
  // (because store moves them instantly; the fade is purely visual on the card)
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const handleFadedOut = useCallback((_id: string) => {
    // The store already moved the transfer to completed via WS events.
    // Nothing extra needed — the card unmounts when it's no longer in active map.
  }, []);

  const activeTransfers = Array.from(active.values()).sort(
    (a, b) => a.startedAt - b.startedAt
  );

  const recentCompleted = completed.slice(0, MAX_COMPLETED_SHOWN);

  return (
    <div className={cn('flex flex-col gap-4', className)} data-testid="transfer-list">
      {/* Active transfers section */}
      <div className="flex flex-col gap-3">
        {activeTransfers.length === 0 ? (
          <EmptyState
            icon={<CheckmarkCircleSvg size={24} />}
            message="No active transfers. Your capital is deployed."
            data-testid="empty-state"
          />
        ) : (
          activeTransfers.map((transfer) => (
            <TransferStatusCard
              key={transfer.id}
              transfer={transfer}
              onFadedOut={handleFadedOut}
            />
          ))
        )}
      </div>

      {/* Completed transfers section */}
      {recentCompleted.length > 0 && (
        <Collapsible open={completedOpen} onOpenChange={setCompletedOpen}>
          <CollapsibleTrigger
            className="flex w-full items-center justify-between px-1 py-2 text-xs text-muted-foreground hover:text-foreground transition-colors"
            data-testid="completed-collapsible-trigger"
          >
            <span className="font-medium">
              Recent Completed ({recentCompleted.length})
            </span>
            {completedOpen ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="flex flex-col gap-2 pt-1" data-testid="completed-list">
              {recentCompleted.map((transfer) => (
                <TransferStatusCard
                  key={transfer.id}
                  transfer={transfer}
                />
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}
