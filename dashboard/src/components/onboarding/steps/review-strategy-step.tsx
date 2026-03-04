'use client';

import { cn } from '@/lib/utils';
import { getRiskTierLabel } from '@/components/settings/risk-allocations';
import type { UseOnboardingReturn } from '@/hooks/use-onboarding';

interface ReviewStrategyStepProps {
  onboarding: UseOnboardingReturn;
}

interface SettingRowProps {
  label: string;
  value: string;
  valueClassName?: string;
}

function SettingRow({ label, value, valueClassName }: SettingRowProps) {
  return (
    <div className="flex items-center justify-between py-3">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className={cn('text-sm font-medium text-foreground', valueClassName)}>
        {value}
      </span>
    </div>
  );
}

export function ReviewStrategyStep({ onboarding }: ReviewStrategyStepProps) {
  const { riskLevel, selectedChains } = onboarding.data;
  const tierLabel = getRiskTierLabel(riskLevel);

  const chainNames: Record<number, string> = {
    1: 'Ethereum',
    42161: 'Arbitrum',
    10: 'Optimism',
    8453: 'Base',
    137: 'Polygon',
    56: 'BSC',
  };

  return (
    <div className="flex flex-col items-center gap-8">
      <div className="flex flex-col items-center gap-3 text-center">
        <h2 className="text-2xl font-bold text-foreground">Review Strategy Defaults</h2>
        <p className="max-w-md text-sm text-muted-foreground">
          CYRUS will start with the YieldHunter strategy using conservative
          defaults. You can customize everything after launch.
        </p>
      </div>

      {/* Strategy card */}
      <div className="w-full max-w-md rounded-xl border border-border bg-zinc-900 p-6">
        {/* Strategy header */}
        <div className="mb-4 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-violet-500/10">
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M12 2L3 7v10l9 5 9-5V7l-9-5Z"
                stroke="#8B5CF6"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d="M12 22V12"
                stroke="#8B5CF6"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
              <path
                d="M12 12L3 7"
                stroke="#8B5CF6"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
              <path
                d="M12 12l9-5"
                stroke="#8B5CF6"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </div>
          <div>
            <h3 className="text-base font-semibold text-foreground">YieldHunter</h3>
            <p className="text-xs text-muted-foreground">
              Cross-chain yield optimization strategy
            </p>
          </div>
        </div>

        {/* Settings list */}
        <div className="divide-y divide-zinc-800">
          <SettingRow label="Risk Profile" value={`${tierLabel} (Level ${riskLevel})`} />
          <SettingRow label="Slippage Tolerance" value="0.5%" />
          <SettingRow label="Max Gas Budget" value="$25/day" />
          <SettingRow label="Min Yield Threshold" value="3.0% APY" />
          <SettingRow label="Rebalance Frequency" value="Every 4 hours" />
          <SettingRow
            label="Active Chains"
            value={selectedChains
              .map((id) => chainNames[id] ?? `Chain ${id}`)
              .join(', ')}
          />
        </div>
      </div>

      {/* Info callout */}
      <div className="flex w-full max-w-md items-start gap-3 rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          className="mt-0.5 shrink-0 text-muted-foreground"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.5" />
          <path
            d="M12 8v4M12 16h.01"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
        <p className="text-xs text-muted-foreground leading-relaxed">
          These are conservative defaults suitable for most users. Once launched,
          CYRUS will autonomously optimize within these bounds and you can adjust
          settings from the dashboard.
        </p>
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
          onClick={onboarding.nextStep}
          className="rounded-lg bg-violet-500 px-8 py-3 text-sm font-semibold text-white transition-colors hover:bg-violet-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950"
          data-testid="onboarding-next"
        >
          Continue
        </button>
      </div>
    </div>
  );
}
