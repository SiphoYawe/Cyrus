'use client';

import { useState, useCallback } from 'react';
import { Slider } from '@/components/ui/slider';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { getRiskTierLabel, getAllocation, TIER_COLORS, TIER_LABELS, type TierKey } from '@/components/settings/risk-allocations';
import type { UseOnboardingReturn } from '@/hooks/use-onboarding';

interface RiskProfileStepProps {
  onboarding: UseOnboardingReturn;
}

const TIER_BADGE_CLASSES: Record<'Conservative' | 'Balanced' | 'Aggressive', string> = {
  Conservative: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
  Balanced:     'bg-violet-500/10 text-violet-400 border-violet-500/20',
  Aggressive:   'bg-amber-500/10 text-amber-400 border-amber-500/20',
};

export function RiskProfileStep({ onboarding }: RiskProfileStepProps) {
  const [riskLevel, setRiskLevel] = useState(onboarding.data.riskLevel);
  const tierLabel = getRiskTierLabel(riskLevel);
  const alloc = getAllocation(riskLevel);
  const thumbPercent = ((riskLevel - 1) / 9) * 100;

  const handleSliderChange = useCallback((values: number[]) => {
    setRiskLevel(values[0]);
  }, []);

  const handleContinue = useCallback(() => {
    onboarding.updateData({ riskLevel });
    onboarding.nextStep();
  }, [onboarding, riskLevel]);

  return (
    <div className="flex flex-col items-center gap-8">
      <div className="flex flex-col items-center gap-3 text-center">
        <h2 className="text-2xl font-bold text-foreground">Set Your Risk Profile</h2>
        <p className="max-w-md text-sm text-muted-foreground">
          Choose how aggressively CYRUS allocates capital across tiers. You can
          always change this later in settings.
        </p>
      </div>

      {/* Risk slider section */}
      <div className="w-full max-w-md space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium text-foreground">Risk Level</p>
          <Badge
            variant="outline"
            className={cn('text-xs font-medium', TIER_BADGE_CLASSES[tierLabel])}
          >
            {tierLabel}
          </Badge>
        </div>

        {/* Slider */}
        <div className="space-y-3">
          <div className="relative">
            <div
              className="absolute -top-7 z-10 flex -translate-x-1/2 items-center justify-center"
              style={{ left: `${thumbPercent}%` }}
              aria-hidden="true"
            >
              <span className="rounded bg-violet-500 px-1.5 py-0.5 text-xs font-bold text-white shadow-lg">
                {riskLevel}
              </span>
            </div>
            <div className="relative">
              <div
                className="risk-dial-track pointer-events-none absolute inset-y-0 left-0 right-0 my-auto h-1.5 rounded-full"
                aria-hidden="true"
              />
              <Slider
                min={1}
                max={10}
                step={1}
                value={[riskLevel]}
                onValueChange={handleSliderChange}
                aria-label="Risk level"
                aria-valuenow={riskLevel}
                aria-valuemin={1}
                aria-valuemax={10}
                className="[&_[data-slot=slider-track]]:bg-transparent [&_[data-slot=slider-range]]:bg-transparent"
              />
            </div>
          </div>
          <div className="flex justify-between px-0.5">
            <span className="text-[11px] font-medium text-blue-400">Conservative</span>
            <span className="text-[11px] font-medium text-violet-400">Balanced</span>
            <span className="text-[11px] font-medium text-amber-400">Aggressive</span>
          </div>
        </div>

        {/* Donut chart preview */}
        <div className="rounded-xl border border-border bg-zinc-900 p-6">
          <p className="mb-4 text-center text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Allocation Preview
          </p>
          <div className="flex items-center justify-center gap-8">
            {/* Simple allocation bars instead of recharts (avoids SVG issues in onboarding) */}
            <div className="w-full space-y-3">
              {(Object.keys(TIER_LABELS) as TierKey[]).map((tier) => (
                <div key={tier} className="flex items-center gap-3">
                  <div className="flex w-20 items-center gap-1.5">
                    <span
                      className="inline-block h-2.5 w-2.5 rounded-full"
                      style={{ backgroundColor: TIER_COLORS[tier] }}
                    />
                    <span className="text-xs text-muted-foreground">{TIER_LABELS[tier]}</span>
                  </div>
                  <div className="flex-1">
                    <div className="h-2 w-full rounded-full bg-zinc-800">
                      <div
                        className="h-2 rounded-full transition-all duration-300"
                        style={{
                          width: `${alloc[tier]}%`,
                          backgroundColor: TIER_COLORS[tier],
                        }}
                      />
                    </div>
                  </div>
                  <span className="w-10 text-right font-mono text-xs font-medium text-foreground">
                    {alloc[tier]}%
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-3">
        {onboarding.canGoBack && (
          <button
            type="button"
            onClick={onboarding.prevStep}
            className="rounded-lg border border-zinc-700 px-6 py-3 text-sm font-medium text-muted-foreground transition-colors hover:border-zinc-600 hover:text-foreground"
            data-testid="onboarding-back"
          >
            Back
          </button>
        )}
        <button
          type="button"
          onClick={handleContinue}
          className="rounded-lg bg-violet-500 px-8 py-3 text-sm font-semibold text-white transition-colors hover:bg-violet-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950"
          data-testid="onboarding-next"
        >
          Continue
        </button>
      </div>
    </div>
  );
}
