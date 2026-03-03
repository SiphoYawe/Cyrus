'use client';

import { useState } from 'react';
import { formatDistanceToNow, parseISO } from 'date-fns';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { ChainLogo, getChainName } from '@/components/transfers/chain-logo';
import { getExplorerTxUrl, truncateTxHash } from '@/lib/block-explorers';
import type { ActivityReport, StrategyTier } from '@/types/activity';

const TIER_STYLES: Record<StrategyTier, { badge: string; dot: string }> = {
  Safe: {
    badge: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
    dot: 'bg-blue-500',
  },
  Growth: {
    badge: 'bg-violet-500/15 text-violet-400 border-violet-500/30',
    dot: 'bg-violet-500',
  },
  Degen: {
    badge: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
    dot: 'bg-amber-500',
  },
  Reserve: {
    badge: 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30',
    dot: 'bg-zinc-500',
  },
};

const TYPE_STYLES: Record<ActivityReport['type'], { badge: string; label: string }> = {
  trade: { badge: 'bg-blue-500/10 text-blue-400 border-blue-500/20', label: 'Trade' },
  bridge: { badge: 'bg-violet-500/10 text-violet-400 border-violet-500/20', label: 'Bridge' },
  deposit: { badge: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20', label: 'Deposit' },
};

interface ActivityDecisionCardProps {
  report: ActivityReport;
  isNew?: boolean;
  onViewTransfer?: (report: ActivityReport) => void;
  className?: string;
}

function formatTokenAmount(raw: string, decimals: number): string {
  const n = Number(raw) / Math.pow(10, decimals);
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (n >= 1) return n.toLocaleString('en-US', { maximumFractionDigits: 4 });
  return n.toLocaleString('en-US', { maximumFractionDigits: 6 });
}

export function ActivityDecisionCard({
  report,
  isNew = false,
  onViewTransfer,
  className,
}: ActivityDecisionCardProps) {
  const [isOpen, setIsOpen] = useState(false);

  const tierStyle = TIER_STYLES[report.tier] ?? TIER_STYLES.Reserve;
  const typeStyle = TYPE_STYLES[report.type] ?? TYPE_STYLES.trade;

  let relativeTime = '';
  let absoluteTime = '';
  try {
    const date = parseISO(report.timestamp);
    relativeTime = formatDistanceToNow(date, { addSuffix: true });
    absoluteTime = date.toLocaleString();
  } catch {
    relativeTime = report.timestamp;
    absoluteTime = report.timestamp;
  }

  return (
    <div
      className={cn(
        'overflow-hidden rounded-xl border border-border bg-card transition-shadow hover:shadow-md',
        isNew && 'animate-fade-in-down',
        className
      )}
      data-testid="activity-decision-card"
    >
      <Collapsible open={isOpen} onOpenChange={setIsOpen}>
        <CollapsibleTrigger asChild>
          <button
            className="w-full px-4 py-3 text-left transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            aria-expanded={isOpen}
            data-testid="decision-card-trigger"
          >
            <div className="flex items-start gap-3">
              {/* Status dot */}
              <span
                className={cn(
                  'mt-1.5 h-2 w-2 shrink-0 rounded-full',
                  report.success ? 'bg-positive' : 'bg-negative'
                )}
                aria-hidden="true"
              />

              <div className="min-w-0 flex-1 space-y-1">
                {/* Badges row */}
                <div className="flex flex-wrap items-center gap-2">
                  <Badge
                    variant="outline"
                    className={cn(
                      'h-5 border px-1.5 text-[10px] font-semibold uppercase tracking-wider',
                      typeStyle.badge
                    )}
                  >
                    {typeStyle.label}
                  </Badge>
                  <Badge
                    variant="outline"
                    className={cn(
                      'h-5 border px-1.5 text-[10px] font-semibold uppercase tracking-wider',
                      tierStyle.badge
                    )}
                  >
                    {report.tier}
                  </Badge>
                  <span className="text-[10px] font-medium text-zinc-500">
                    {report.strategyName}
                  </span>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="ml-auto shrink-0 tabular-nums text-xs text-muted-foreground">
                        {relativeTime}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="left">
                      <span>{absoluteTime}</span>
                    </TooltipContent>
                  </Tooltip>
                </div>

                {/* Summary */}
                <p className="text-sm leading-snug text-foreground/90">{report.summary}</p>
              </div>

              {/* Chevron */}
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className={cn(
                  'mt-1 shrink-0 text-muted-foreground transition-transform duration-200',
                  isOpen && 'rotate-180'
                )}
                aria-hidden="true"
              >
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </div>
          </button>
        </CollapsibleTrigger>

        <CollapsibleContent className="overflow-hidden transition-all duration-200 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0">
          <div className="mx-4 border-t border-border" />
          <div className="px-4 py-3 space-y-3">
            {/* Full narrative */}
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
              {report.narrative}
            </p>

            {/* Transfer details */}
            {report.transfer && (
              <div
                className="rounded-lg border border-border bg-secondary/30 p-3 space-y-2"
                data-testid="transfer-details"
              >
                <div className="flex items-center justify-between gap-4">
                  {/* From */}
                  <div className="flex items-center gap-2">
                    <ChainLogo chainId={report.transfer.fromChainId} size={22} />
                    <div>
                      <p className="text-[10px] text-muted-foreground">
                        {getChainName(report.transfer.fromChainId)}
                      </p>
                      <p className="text-sm font-medium">
                        {formatTokenAmount(
                          report.transfer.fromAmount,
                          report.transfer.fromToken.decimals
                        )}{' '}
                        <span className="font-semibold">{report.transfer.fromToken.symbol}</span>
                      </p>
                    </div>
                  </div>

                  {/* Arrow */}
                  <svg
                    width="16"
                    height="16"
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

                  {/* To */}
                  <div className="flex items-center gap-2">
                    <ChainLogo chainId={report.transfer.toChainId} size={22} />
                    <div>
                      <p className="text-[10px] text-muted-foreground">
                        {getChainName(report.transfer.toChainId)}
                      </p>
                      <p className="text-sm font-medium">
                        {report.transfer.toAmount
                          ? `${formatTokenAmount(
                              report.transfer.toAmount,
                              report.transfer.toToken.decimals
                            )} `
                          : '~ '}
                        <span className="font-semibold">{report.transfer.toToken.symbol}</span>
                      </p>
                    </div>
                  </div>
                </div>

                {/* Tx hash */}
                {report.transfer.txHash && (
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-muted-foreground">Tx:</span>
                    <a
                      href={getExplorerTxUrl(
                        report.transfer.fromChainId,
                        report.transfer.txHash
                      )}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-mono text-xs text-primary underline-offset-2 hover:underline"
                      data-testid="tx-hash-link"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {truncateTxHash(report.transfer.txHash)}
                    </a>
                  </div>
                )}
              </div>
            )}

            {/* P&L and gas */}
            {(report.pnlUsd !== undefined || report.gasCostUsd !== undefined) && (
              <div className="flex items-center gap-4 text-xs">
                {report.pnlUsd !== undefined && (
                  <span>
                    <span className="text-muted-foreground">P&L: </span>
                    <span
                      className={cn(
                        'font-medium',
                        report.pnlUsd >= 0 ? 'text-positive' : 'text-negative'
                      )}
                    >
                      {report.pnlUsd >= 0 ? '+' : ''}${report.pnlUsd.toFixed(2)}
                    </span>
                  </span>
                )}
                {report.gasCostUsd !== undefined && (
                  <span>
                    <span className="text-muted-foreground">Gas: </span>
                    <span className="font-medium">${report.gasCostUsd.toFixed(4)}</span>
                  </span>
                )}
              </div>
            )}

            {/* View Transfer button */}
            {report.transfer && onViewTransfer && (
              <div className="flex justify-end">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={(e) => {
                    e.stopPropagation();
                    onViewTransfer(report);
                  }}
                  data-testid="view-transfer-btn"
                >
                  View Transfer
                </Button>
              </div>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
