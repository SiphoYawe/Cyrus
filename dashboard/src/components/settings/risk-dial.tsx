'use client';

import { useState, useCallback, useRef } from 'react';
import { Slider } from '@/components/ui/slider';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { useWebSocket } from '@/providers/ws-provider';
import { useAgentStore } from '@/stores/agent-store';
import { WS_COMMANDS } from '@/types/ws';
import { toast } from 'sonner';
import { getRiskTierLabel } from './risk-allocations';
import { AllocationPreview } from './allocation-preview';

const TIER_BADGE_CLASSES: Record<'Conservative' | 'Balanced' | 'Aggressive', string> = {
  Conservative: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
  Balanced:     'bg-violet-500/10 text-violet-400 border-violet-500/20',
  Aggressive:   'bg-amber-500/10 text-amber-400 border-amber-500/20',
};

interface RiskDialProps {
  className?: string;
}

export function RiskDial({ className }: RiskDialProps) {
  const { send } = useWebSocket();
  const config = useAgentStore((s) => s.config);

  const savedLevel = config?.riskLevel ?? 5;

  const [currentSlider, setCurrentSlider] = useState<number>(savedLevel);
  const [pendingLevel, setPendingLevel] = useState<number | null>(null);
  const [isConfirming, setIsConfirming] = useState(false);
  const [isRebalancing, setIsRebalancing] = useState(false);

  // Track last committed level to support Cancel
  const committedLevel = useRef<number>(savedLevel);

  const isDirty = pendingLevel !== null && pendingLevel !== committedLevel.current;
  const displayLevel = pendingLevel ?? currentSlider;
  const tierLabel = getRiskTierLabel(displayLevel);

  const handleSliderChange = useCallback((values: number[]) => {
    const val = values[0];
    setCurrentSlider(val);
    setPendingLevel(val);
  }, []);

  const handleConfirm = useCallback(async () => {
    if (pendingLevel === null) return;
    setIsConfirming(true);
    try {
      send({
        command: WS_COMMANDS.RISK_DIAL_CHANGE,
        payload: { level: pendingLevel },
      });
      committedLevel.current = pendingLevel;
      setIsRebalancing(true);
      setPendingLevel(null);
      toast.success(`Risk level updated to ${pendingLevel}. Rebalancing in progress.`);
    } finally {
      setIsConfirming(false);
    }
  }, [pendingLevel, send]);

  const handleCancel = useCallback(() => {
    const prev = committedLevel.current;
    setCurrentSlider(prev);
    setPendingLevel(null);
  }, []);

  // Thumb position percentage for the value bubble (0-100%)
  const thumbPercent = ((displayLevel - 1) / 9) * 100;

  return (
    <div className={cn('space-y-6', className)}>
      {/* Header row */}
      <div className="flex items-center justify-between">
        <div className="space-y-0.5">
          <p className="text-sm font-medium text-foreground">Risk Level</p>
          <p className="text-xs text-muted-foreground">
            Adjust how aggressively CYRUS allocates capital across tiers.
          </p>
        </div>
        <Badge
          variant="outline"
          className={cn('text-xs font-medium', TIER_BADGE_CLASSES[tierLabel])}
        >
          {tierLabel}
        </Badge>
      </div>

      {/* Slider with value bubble */}
      <div className="space-y-3">
        <div className="relative">
          {/* Floating value display above thumb */}
          <div
            className="absolute -top-7 z-10 flex -translate-x-1/2 items-center justify-center"
            style={{ left: `${thumbPercent}%` }}
            aria-hidden="true"
          >
            <span className="rounded bg-violet-500 px-1.5 py-0.5 text-xs font-bold text-white shadow-lg">
              {displayLevel}
            </span>
          </div>

          {/* The actual slider — styled with gradient track */}
          <div className="relative">
            {/* Gradient track underlay — fills the full track width */}
            <div
              className="risk-dial-track pointer-events-none absolute inset-y-0 left-0 right-0 my-auto h-1.5 rounded-full"
              aria-hidden="true"
            />
            <Slider
              min={1}
              max={10}
              step={1}
              value={[displayLevel]}
              onValueChange={handleSliderChange}
              disabled={isRebalancing}
              aria-label="Risk level"
              aria-valuenow={displayLevel}
              aria-valuemin={1}
              aria-valuemax={10}
              className="[&_[data-slot=slider-track]]:bg-transparent [&_[data-slot=slider-range]]:bg-transparent"
            />
          </div>
        </div>

        {/* Tier range labels */}
        <div className="flex justify-between px-0.5">
          <span className="text-[11px] text-blue-400 font-medium">Conservative</span>
          <span className="text-[11px] text-violet-400 font-medium">Balanced</span>
          <span className="text-[11px] text-amber-400 font-medium">Aggressive</span>
        </div>

        {/* Scale ticks */}
        <div className="flex justify-between px-0.5">
          {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
            <span
              key={n}
              className={cn(
                'text-[10px] tabular-nums',
                n === displayLevel
                  ? 'font-bold text-foreground'
                  : 'text-muted-foreground/50',
              )}
            >
              {n}
            </span>
          ))}
        </div>
      </div>

      {/* Rebalancing status */}
      {isRebalancing && (
        <div
          className="flex items-center gap-2 rounded-lg border border-amber-500/20 bg-amber-500/5 px-4 py-2.5 text-sm text-amber-400"
          role="status"
          aria-live="polite"
        >
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-amber-400" />
          Rebalancing portfolio…
          <button
            type="button"
            className="ml-auto text-xs text-muted-foreground underline-offset-2 hover:underline"
            onClick={() => setIsRebalancing(false)}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Live allocation preview */}
      <AllocationPreview currentLevel={committedLevel.current} previewLevel={displayLevel} />

      {/* Confirm / Cancel actions */}
      {isDirty && !isRebalancing && (
        <div className="flex items-center gap-3 pt-2">
          <Button
            variant="default"
            className="bg-violet-500 text-white hover:bg-violet-600 focus-visible:ring-violet-500"
            onClick={handleConfirm}
            disabled={isConfirming}
            aria-label={`Confirm risk level change to ${pendingLevel}`}
          >
            {isConfirming ? (
              <span className="flex items-center gap-2">
                <span
                  className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-white border-t-transparent"
                  aria-hidden="true"
                />
                Confirming…
              </span>
            ) : (
              'Confirm Transformation'
            )}
          </Button>
          <Button
            variant="ghost"
            onClick={handleCancel}
            disabled={isConfirming}
          >
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}
