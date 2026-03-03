'use client';

import { cn } from '@/lib/utils';
import type { Transfer } from '@/stores/transfers-store';

export type SegmentState = 'pending' | 'active' | 'completed';

export interface ProgressSegments {
  sourceTx: SegmentState;
  bridge: SegmentState;
  destinationTx: SegmentState;
}

export function getSegmentsForStatus(status: Transfer['status']): ProgressSegments {
  switch (status) {
    case 'NOT_FOUND':
    case 'PENDING':
      return { sourceTx: 'active', bridge: 'pending', destinationTx: 'pending' };
    case 'IN_PROGRESS':
      return { sourceTx: 'completed', bridge: 'active', destinationTx: 'pending' };
    case 'COMPLETED':
    case 'PARTIAL':
    case 'REFUNDED':
      return { sourceTx: 'completed', bridge: 'completed', destinationTx: 'completed' };
    case 'FAILED':
      return { sourceTx: 'completed', bridge: 'pending', destinationTx: 'pending' };
    default:
      return { sourceTx: 'pending', bridge: 'pending', destinationTx: 'pending' };
  }
}

interface SegmentProps {
  state: SegmentState;
  label: string;
  isLast?: boolean;
}

function Segment({ state, label, isLast = false }: SegmentProps) {
  return (
    <div className={cn('flex flex-col items-center gap-1.5', !isLast && 'flex-1')}>
      <div className="relative w-full h-1.5 rounded-full overflow-hidden">
        <div
          className={cn(
            'absolute inset-0 transition-all duration-300 ease-in-out rounded-full',
            state === 'pending' && 'bg-zinc-700',
            state === 'completed' && 'bg-[#22C55E]',
            state === 'active' && 'bg-violet-500'
          )}
        />
        {state === 'active' && (
          <div
            className="absolute inset-0 rounded-full animate-shimmer"
            style={{
              background:
                'linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.3) 50%, transparent 100%)',
            }}
            aria-hidden="true"
          />
        )}
      </div>
      <span className="text-[10px] text-muted-foreground whitespace-nowrap">{label}</span>
    </div>
  );
}

interface SegmentConnectorProps {
  completed: boolean;
}

function SegmentConnector({ completed }: SegmentConnectorProps) {
  return (
    <div
      className={cn(
        'h-1.5 w-4 rounded-full flex-shrink-0 -mt-[18px] transition-all duration-300 ease-in-out',
        completed ? 'bg-[#22C55E]' : 'bg-zinc-700'
      )}
      aria-hidden="true"
    />
  );
}

interface TransferProgressBarProps {
  segments: ProgressSegments;
  className?: string;
}

export function TransferProgressBar({ segments, className }: TransferProgressBarProps) {
  return (
    <div
      className={cn('flex items-start gap-1 w-full', className)}
      role="progressbar"
      aria-label="Transfer progress"
      data-testid="transfer-progress-bar"
    >
      <Segment state={segments.sourceTx} label="Source TX" />
      <SegmentConnector completed={segments.sourceTx === 'completed'} />
      <Segment state={segments.bridge} label="Bridge" />
      <SegmentConnector completed={segments.bridge === 'completed'} />
      <Segment state={segments.destinationTx} label="Destination TX" />
    </div>
  );
}
