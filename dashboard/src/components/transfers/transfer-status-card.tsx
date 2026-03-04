'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
function Tick02Svg({ size, color }: { size?: number; color?: string }) {
  const s = size ?? 20;
  return (
    <svg data-testid="tick-icon" width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={color ?? 'currentColor'} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 13L9 18L20 7" />
    </svg>
  );
}

function Cancel01Svg({ size, color }: { size?: number; color?: string }) {
  const s = size ?? 16;
  return (
    <svg data-testid="cancel-icon" width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={color ?? 'currentColor'} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 18L18 6M6 6L18 18" />
    </svg>
  );
}
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ChainLogo, getChainName } from './chain-logo';
import { TransferProgressBar, getSegmentsForStatus } from './transfer-progress-bar';
import type { Transfer } from '@/stores/transfers-store';
import { useWebSocket } from '@/providers/ws-provider';
import { WS_COMMANDS } from '@/types/ws';

const COMPLETED_FADE_DELAY_MS = 10_000;
const COMPLETED_FADE_DURATION_MS = 500;

interface StatusBadgeProps {
  status: Transfer['status'];
}

function StatusBadge({ status }: StatusBadgeProps) {
  switch (status) {
    case 'PENDING':
    case 'NOT_FOUND':
      return (
        <Badge className="bg-warning/20 text-warning border-warning/30">
          Pending
        </Badge>
      );
    case 'IN_PROGRESS':
      return (
        <Badge className="bg-violet-500/20 text-violet-400 border-violet-500/30 animate-pulse">
          In Progress
        </Badge>
      );
    case 'COMPLETED':
      return (
        <Badge className="bg-positive/20 text-positive border-positive/30">
          Completed
        </Badge>
      );
    case 'PARTIAL':
      return (
        <Badge className="bg-warning/20 text-warning border-warning/30">
          Partial
        </Badge>
      );
    case 'REFUNDED':
      return (
        <Badge className="bg-info/20 text-info border-info/30">
          Refunded
        </Badge>
      );
    case 'FAILED':
      return (
        <Badge className="bg-negative/20 text-negative border-negative/30">
          Failed
        </Badge>
      );
    default:
      return (
        <Badge variant="secondary">Unknown</Badge>
      );
  }
}

function formatAmount(amount: string, decimals: number, symbol: string): string {
  const raw = BigInt(amount);
  const divisor = BigInt(10 ** decimals);
  const whole = raw / divisor;
  const fraction = raw % divisor;
  const fractionStr = fraction.toString().padStart(decimals, '0').slice(0, 4).replace(/0+$/, '');
  const formatted = fractionStr ? `${whole}.${fractionStr}` : whole.toString();
  const withCommas = Number(formatted).toLocaleString('en-US', { maximumFractionDigits: 4 });
  return `${withCommas} ${symbol}`;
}

function formatEta(estimatedTimeMs: number, startedAt: number): string {
  const elapsedMs = Date.now() - startedAt;
  const remainingMs = Math.max(0, estimatedTimeMs - elapsedMs);
  const remainingSec = Math.ceil(remainingMs / 1000);
  if (remainingSec <= 0) return '< 1s';
  if (remainingSec < 60) return `~${remainingSec}s`;
  const mins = Math.ceil(remainingSec / 60);
  return `~${mins} min`;
}

interface EtaCountdownProps {
  estimatedTimeMs: number;
  startedAt: number;
}

function EtaCountdown({ estimatedTimeMs, startedAt }: EtaCountdownProps) {
  const [eta, setEta] = useState(() => formatEta(estimatedTimeMs, startedAt));

  useEffect(() => {
    // Skip interval during SSR or if already at 0
    const remaining = estimatedTimeMs - (Date.now() - startedAt);
    if (remaining <= 0) return;

    const interval = setInterval(() => {
      setEta(formatEta(estimatedTimeMs, startedAt));
    }, 1000);
    return () => clearInterval(interval);
  }, [estimatedTimeMs, startedAt]);

  return <span className="text-xs text-muted-foreground" data-testid="eta-countdown">{eta}</span>;
}

interface RecoveryActionsProps {
  transferId: string;
  canReverse: boolean;
}

function RecoveryActions({ transferId, canReverse }: RecoveryActionsProps) {
  const { send } = useWebSocket();
  const [loadingAction, setLoadingAction] = useState<string | null>(null);

  const handleAction = useCallback(
    async (command: string, actionKey: string) => {
      setLoadingAction(actionKey);
      send({ command, payload: { transferId } });
      // Reset loading after short delay — real state change comes via WS
      setTimeout(() => setLoadingAction(null), 3000);
    },
    [send, transferId]
  );

  return (
    <div className="flex items-center gap-2 pt-1">
      <Button
        size="sm"
        className="bg-violet-500 hover:bg-violet-600 text-white h-7 px-3 text-xs"
        disabled={loadingAction !== null}
        onClick={() => handleAction(WS_COMMANDS.TRANSFER_RETRY, 'retry')}
        data-testid="recovery-retry"
      >
        {loadingAction === 'retry' ? (
          <SpinnerIcon />
        ) : null}
        Retry
      </Button>
      <Button
        size="sm"
        className="bg-zinc-700 hover:bg-zinc-600 text-white h-7 px-3 text-xs"
        disabled={loadingAction !== null}
        onClick={() => handleAction(WS_COMMANDS.TRANSFER_HOLD, 'hold')}
        data-testid="recovery-hold"
      >
        {loadingAction === 'hold' ? (
          <SpinnerIcon />
        ) : null}
        Hold
      </Button>
      {canReverse && (
        <Button
          size="sm"
          className="bg-amber-500 hover:bg-amber-600 text-white h-7 px-3 text-xs"
          disabled={loadingAction !== null}
          onClick={() => handleAction(WS_COMMANDS.TRANSFER_REVERSE, 'reverse')}
          data-testid="recovery-reverse"
        >
          {loadingAction === 'reverse' ? (
            <SpinnerIcon />
          ) : null}
          Reverse
        </Button>
      )}
    </div>
  );
}

function SpinnerIcon() {
  return (
    <svg
      className="animate-spin h-3 w-3 mr-1"
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  );
}

interface TransferStatusCardProps {
  transfer: Transfer;
  onFadedOut?: (id: string) => void;
}

export function TransferStatusCard({ transfer, onFadedOut }: TransferStatusCardProps) {
  const [opacity, setOpacity] = useState(1);
  const fadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fadeAnimRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isCompleted =
    transfer.status === 'COMPLETED' ||
    transfer.status === 'PARTIAL' ||
    transfer.status === 'REFUNDED';
  const isFailed = transfer.status === 'FAILED';

  useEffect(() => {
    if (isCompleted) {
      fadeTimerRef.current = setTimeout(() => {
        setOpacity(0);
        fadeAnimRef.current = setTimeout(() => {
          onFadedOut?.(transfer.id);
        }, COMPLETED_FADE_DURATION_MS);
      }, COMPLETED_FADE_DELAY_MS);
    }

    return () => {
      if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current);
      if (fadeAnimRef.current) clearTimeout(fadeAnimRef.current);
    };
  }, [isCompleted, transfer.id, onFadedOut]);

  const segments = getSegmentsForStatus(transfer.status);

  const formattedFromAmount = (() => {
    try {
      return formatAmount(transfer.fromAmount, transfer.fromToken.decimals, transfer.fromToken.symbol);
    } catch {
      return `${transfer.fromAmount} ${transfer.fromToken.symbol}`;
    }
  })();

  const formattedToAmount = transfer.toAmount
    ? (() => {
        try {
          return formatAmount(transfer.toAmount, transfer.toToken.decimals, transfer.toToken.symbol);
        } catch {
          return `${transfer.toAmount} ${transfer.toToken.symbol}`;
        }
      })()
    : null;

  return (
    <Card
      className="animate-fade-in-down border-border py-4 gap-3"
      style={{
        opacity,
        transition: `opacity ${COMPLETED_FADE_DURATION_MS}ms ease-in-out`,
      }}
      data-testid={`transfer-card-${transfer.id}`}
      data-status={transfer.status}
    >
      <CardContent className="px-4 flex flex-col gap-3">
        {/* Header row: chains + status badge */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <ChainLogo chainId={transfer.fromChainId} size={32} showName />
            {/* Arrow */}
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              className="text-muted-foreground flex-shrink-0"
              aria-hidden="true"
            >
              <path
                d="M3 8h10M9 4l4 4-4 4"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <ChainLogo chainId={transfer.toChainId} size={32} showName />
          </div>
          <StatusBadge status={transfer.status} />
        </div>

        {/* Amount row */}
        <div className="flex items-baseline gap-1.5">
          <span className="text-sm font-medium text-foreground">{formattedFromAmount}</span>
          {formattedToAmount && (
            <>
              <span className="text-xs text-muted-foreground">→</span>
              <span className="text-sm font-medium text-foreground">{formattedToAmount}</span>
            </>
          )}
          {transfer.bridge && (
            <span className="text-[10px] text-muted-foreground ml-auto">
              via {transfer.bridge}
            </span>
          )}
        </div>

        {/* Center section: progress or completion state */}
        {isCompleted ? (
          <div className="flex flex-col items-center gap-2 py-2">
            <div
              className="flex h-10 w-10 items-center justify-center rounded-full bg-positive/20"
              data-testid="completion-icon"
            >
              <Tick02Svg size={20} color="#22C55E" />
            </div>
            {formattedToAmount && (
              <div className="text-center">
                <p className="text-[10px] text-muted-foreground">Received</p>
                <p className="text-sm font-semibold text-positive">{formattedToAmount}</p>
              </div>
            )}
            {transfer.completedAt && (
              <span className="text-[10px] text-muted-foreground">
                {new Date(transfer.completedAt).toLocaleTimeString()}
              </span>
            )}
          </div>
        ) : isFailed ? (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <div
                className="flex h-8 w-8 items-center justify-center rounded-full bg-negative/20 flex-shrink-0"
                data-testid="failure-icon"
              >
                <Cancel01Svg size={16} color="#EF4444" />
              </div>
              {transfer.error && (
                <p className="text-xs text-negative leading-snug">{transfer.error}</p>
              )}
            </div>
            <RecoveryActions
              transferId={transfer.id}
              canReverse={
                transfer.substatus === 'PARTIAL_REFUND' ||
                transfer.bridge === 'hop' ||
                transfer.bridge === 'across'
              }
            />
          </div>
        ) : (
          <TransferProgressBar segments={segments} />
        )}

        {/* ETA row for active transfers */}
        {!isCompleted && !isFailed && transfer.estimatedTimeMs && (
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-muted-foreground">
              {getChainName(transfer.fromChainId)} → {getChainName(transfer.toChainId)}
            </span>
            <EtaCountdown
              estimatedTimeMs={transfer.estimatedTimeMs}
              startedAt={transfer.startedAt}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
