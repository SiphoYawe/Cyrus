'use client';

import { useState } from 'react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { ChainLogo, getChainName } from '@/components/transfers/chain-logo';
import { getExplorerTxUrl, truncateTxHash } from '@/lib/block-explorers';
import type { ActivityTransfer, TransferStatus, TransferStep } from '@/types/activity';

interface TransferDetailSheetProps {
  transfer: ActivityTransfer | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const STATUS_STYLES: Record<TransferStatus, { label: string; className: string }> = {
  PENDING: { label: 'Pending', className: 'bg-warning/10 text-warning border-warning/20' },
  IN_PROGRESS: { label: 'In Progress', className: 'bg-warning/10 text-warning border-warning/20' },
  COMPLETED: { label: 'Completed', className: 'bg-positive/10 text-positive border-positive/20' },
  PARTIAL: { label: 'Partial', className: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20' },
  REFUNDED: { label: 'Refunded', className: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20' },
  FAILED: { label: 'Failed', className: 'bg-negative/10 text-negative border-negative/20' },
  NOT_FOUND: { label: 'Not Found', className: 'bg-muted text-muted-foreground border-border' },
};

const STEP_STATUS_STYLES: Record<TransferStep['status'], { dot: string; label: string }> = {
  pending: { dot: 'bg-muted-foreground', label: 'Pending' },
  in_progress: { dot: 'bg-warning animate-pulse', label: 'In Progress' },
  done: { dot: 'bg-positive', label: 'Done' },
  failed: { dot: 'bg-negative', label: 'Failed' },
};

function formatTokenAmount(raw: string, decimals: number): string {
  const n = Number(raw) / Math.pow(10, decimals);
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (n >= 1) return n.toLocaleString('en-US', { maximumFractionDigits: 4 });
  return n.toLocaleString('en-US', { maximumFractionDigits: 6 });
}

function ExchangeRate({
  fromAmount,
  fromToken,
  toAmount,
  toToken,
}: {
  fromAmount: string;
  fromToken: { symbol: string; decimals: number };
  toAmount?: string;
  toToken: { symbol: string; decimals: number };
}) {
  if (!toAmount) return null;
  const from = Number(fromAmount) / Math.pow(10, fromToken.decimals);
  const to = Number(toAmount) / Math.pow(10, toToken.decimals);
  if (from === 0) return null;
  const rate = to / from;
  return (
    <p className="text-xs text-muted-foreground">
      1 {fromToken.symbol} ≈ {rate.toFixed(6)} {toToken.symbol}
    </p>
  );
}

function StepTimeline({ steps }: { steps: TransferStep[] }) {
  return (
    <div className="space-y-3" data-testid="transfer-timeline">
      {steps.map((step, idx) => {
        const style = STEP_STATUS_STYLES[step.status];
        return (
          <div key={step.id} className="flex gap-3">
            {/* Timeline line + dot */}
            <div className="flex flex-col items-center">
              <span
                className={cn('h-2.5 w-2.5 shrink-0 rounded-full', style.dot)}
                aria-label={style.label}
              />
              {idx < steps.length - 1 && (
                <div className="mt-1 w-px flex-1 bg-border" />
              )}
            </div>

            <div className="min-w-0 flex-1 pb-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium">{step.action}</p>
                <span className="shrink-0 text-xs text-muted-foreground">{style.label}</span>
              </div>
              <p className="text-xs text-muted-foreground">{step.description}</p>

              {step.txHash && step.chainId && (
                <a
                  href={getExplorerTxUrl(step.chainId, step.txHash)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-0.5 font-mono text-xs text-primary underline-offset-2 hover:underline"
                  data-testid="step-tx-link"
                >
                  {truncateTxHash(step.txHash)}
                </a>
              )}

              {step.timestamp && (
                <p className="mt-0.5 text-[10px] text-muted-foreground">
                  {new Date(step.timestamp).toLocaleTimeString('en-US', {
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                    hour12: false,
                  })}
                </p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function TransferDetailSheet({
  transfer,
  open,
  onOpenChange,
}: TransferDetailSheetProps) {
  const [showRaw, setShowRaw] = useState(false);

  if (!transfer) return null;

  const statusStyle = STATUS_STYLES[transfer.status] ?? STATUS_STYLES.NOT_FOUND;
  const duration =
    transfer.completedAt && transfer.startedAt
      ? Math.round((transfer.completedAt - transfer.startedAt) / 1000)
      : null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex w-[480px] max-w-[480px] flex-col p-0"
        data-testid="transfer-detail-sheet"
      >
        <SheetHeader className="border-b border-border px-6 py-4">
          <div className="flex items-center justify-between pr-6">
            <SheetTitle className="text-base font-semibold">Transfer Details</SheetTitle>
            <Badge
              variant="outline"
              className={cn('border text-xs', statusStyle.className)}
              data-testid="transfer-status-badge"
            >
              {statusStyle.label}
            </Badge>
          </div>
          <SheetDescription className="text-xs text-muted-foreground">
            {transfer.bridge && `via ${transfer.bridge}`}
            {duration !== null && ` · ${duration}s`}
          </SheetDescription>
        </SheetHeader>

        <ScrollArea className="flex-1">
          <div className="space-y-6 px-6 py-4">
            {/* From / To chains */}
            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Route
              </p>
              <div className="flex items-center gap-4 rounded-lg border border-border bg-secondary/30 p-4">
                {/* From chain */}
                <div className="flex flex-1 flex-col items-center gap-1.5">
                  <ChainLogo chainId={transfer.fromChainId} size={36} />
                  <span className="text-xs font-medium">
                    {getChainName(transfer.fromChainId)}
                  </span>
                  <div className="text-center">
                    <p className="text-sm font-semibold">
                      {formatTokenAmount(transfer.fromAmount, transfer.fromToken.decimals)}{' '}
                      {transfer.fromToken.symbol}
                    </p>
                    {transfer.fromAmountUsd !== undefined && (
                      <p className="text-xs text-muted-foreground">
                        ${transfer.fromAmountUsd.toFixed(2)}
                      </p>
                    )}
                  </div>
                </div>

                {/* Arrow */}
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="shrink-0 text-muted-foreground"
                  aria-hidden="true"
                >
                  <line x1="5" y1="12" x2="19" y2="12" />
                  <polyline points="12 5 19 12 12 19" />
                </svg>

                {/* To chain */}
                <div className="flex flex-1 flex-col items-center gap-1.5">
                  <ChainLogo chainId={transfer.toChainId} size={36} />
                  <span className="text-xs font-medium">
                    {getChainName(transfer.toChainId)}
                  </span>
                  <div className="text-center">
                    <p className="text-sm font-semibold">
                      {transfer.toAmount
                        ? `${formatTokenAmount(
                            transfer.toAmount,
                            transfer.toToken.decimals
                          )} ${transfer.toToken.symbol}`
                        : `~ ${transfer.toToken.symbol}`}
                    </p>
                    {transfer.toAmountUsd !== undefined && (
                      <p className="text-xs text-muted-foreground">
                        ${transfer.toAmountUsd.toFixed(2)}
                      </p>
                    )}
                  </div>
                </div>
              </div>

              {/* Exchange rate */}
              <div className="mt-1.5 text-center">
                <ExchangeRate
                  fromAmount={transfer.fromAmount}
                  fromToken={transfer.fromToken}
                  toAmount={transfer.toAmount}
                  toToken={transfer.toToken}
                />
              </div>
            </div>

            <Separator />

            {/* Tx hashes */}
            {transfer.txHash && (
              <div>
                <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Transaction
                </p>
                <div className="flex items-center gap-2">
                  <a
                    href={getExplorerTxUrl(transfer.fromChainId, transfer.txHash)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-mono text-xs text-primary underline-offset-2 hover:underline"
                    data-testid="main-tx-link"
                  >
                    {truncateTxHash(transfer.txHash, 8)}
                  </a>
                  <span className="text-xs text-muted-foreground">
                    ({getChainName(transfer.fromChainId)})
                  </span>
                </div>
              </div>
            )}

            {/* Timeline */}
            {transfer.steps && transfer.steps.length > 0 && (
              <div>
                <p className="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Timeline
                </p>
                <StepTimeline steps={transfer.steps} />
              </div>
            )}

            {/* Error */}
            {transfer.error && (
              <div className="rounded-lg border border-negative/20 bg-negative/5 p-3">
                <p className="text-xs font-medium text-negative">Error</p>
                <p className="mt-1 text-xs text-muted-foreground">{transfer.error}</p>
              </div>
            )}

            <Separator />

            {/* Debug toggle */}
            <div>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs text-muted-foreground"
                onClick={() => setShowRaw((p) => !p)}
                data-testid="raw-json-toggle"
              >
                {showRaw ? 'Hide' : 'Show'} raw JSON
              </Button>
              {showRaw && (
                <pre
                  className="mt-2 overflow-auto rounded-lg border border-border bg-secondary/30 p-3 font-mono text-[10px] text-muted-foreground"
                  data-testid="raw-json"
                >
                  {JSON.stringify(transfer, null, 2)}
                </pre>
              )}
            </div>
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
