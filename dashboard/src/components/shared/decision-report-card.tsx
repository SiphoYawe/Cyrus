'use client';

import { useState } from 'react';
import { formatDistanceToNow, parseISO } from 'date-fns';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
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
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { DecisionReport, StrategyTier } from '@/hooks/use-recent-decisions';

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

interface DecisionReportCardProps {
  report: DecisionReport;
  className?: string;
}

export function DecisionReportCard({ report, className }: DecisionReportCardProps) {
  const [isOpen, setIsOpen] = useState(false);
  const tierStyle = TIER_STYLES[report.tier] ?? TIER_STYLES.Reserve;
  const truncatedSummary =
    report.summary.length > 120
      ? report.summary.slice(0, 120) + '…'
      : report.summary;

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
    <Card className={cn('gap-0 py-0 overflow-hidden', className)}>
      <Collapsible open={isOpen} onOpenChange={setIsOpen}>
        <CollapsibleTrigger asChild>
          <button
            className="w-full text-left px-4 py-3 hover:bg-muted/30 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            aria-label={`Toggle decision report from ${relativeTime}`}
          >
            <CardContent className="p-0">
              <div className="flex items-start gap-3">
                {/* Tier dot */}
                <span
                  className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', tierStyle.dot)}
                  aria-hidden="true"
                />
                <div className="flex-1 min-w-0 space-y-1">
                  {/* Top row: tier badge + timestamp */}
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge
                      variant="outline"
                      className={cn(
                        'h-5 px-1.5 text-[10px] font-semibold uppercase tracking-wider border',
                        tierStyle.badge
                      )}
                    >
                      {report.tier}
                    </Badge>
                    <span className="text-[10px] text-zinc-500 font-medium">
                      {report.strategyName}
                    </span>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="ml-auto text-xs text-muted-foreground tabular-nums shrink-0">
                          {relativeTime}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent side="left">
                        <span>{absoluteTime}</span>
                      </TooltipContent>
                    </Tooltip>
                  </div>
                  {/* Summary */}
                  <p className="text-sm text-foreground/90 leading-snug">{truncatedSummary}</p>
                </div>
                {/* Chevron */}
                <ChevronDown
                  className={cn(
                    'mt-1 h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200',
                    isOpen && 'rotate-180'
                  )}
                />
              </div>
            </CardContent>
          </button>
        </CollapsibleTrigger>

        <CollapsibleContent className="data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 overflow-hidden transition-all duration-200">
          <div className="border-t border-border mx-4" />
          <div className="px-4 py-3">
            <p className="text-sm text-muted-foreground leading-relaxed whitespace-pre-wrap">
              {report.narrative}
            </p>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}
