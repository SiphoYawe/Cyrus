'use client';

import { useState, useCallback } from 'react';
import { ChainLogo } from '@/components/transfers/chain-logo';
import { cn } from '@/lib/utils';
import type { UseOnboardingReturn } from '@/hooks/use-onboarding';

interface SelectChainsStepProps {
  onboarding: UseOnboardingReturn;
}

const AVAILABLE_CHAINS = [
  { id: 1, name: 'Ethereum' },
  { id: 42161, name: 'Arbitrum' },
  { id: 10, name: 'Optimism' },
  { id: 8453, name: 'Base' },
  { id: 137, name: 'Polygon' },
  { id: 56, name: 'BSC' },
] as const;

export function SelectChainsStep({ onboarding }: SelectChainsStepProps) {
  const [selectedChains, setSelectedChains] = useState<number[]>(
    () => onboarding.data.selectedChains,
  );

  const toggleChain = useCallback((chainId: number) => {
    setSelectedChains((prev) =>
      prev.includes(chainId)
        ? prev.filter((id) => id !== chainId)
        : [...prev, chainId],
    );
  }, []);

  const handleContinue = useCallback(() => {
    onboarding.updateData({ selectedChains });
    onboarding.nextStep();
  }, [onboarding, selectedChains]);

  return (
    <div className="flex flex-col items-center gap-8">
      <div className="flex flex-col items-center gap-3 text-center">
        <h2 className="text-2xl font-bold text-foreground">Select Chains</h2>
        <p className="max-w-md text-sm text-muted-foreground">
          Choose which chains CYRUS should operate on. More chains means more
          yield opportunities but also higher gas costs.
        </p>
      </div>

      {/* Chain grid */}
      <div className="grid w-full max-w-lg grid-cols-2 gap-3 sm:grid-cols-3">
        {AVAILABLE_CHAINS.map((chain) => {
          const isSelected = selectedChains.includes(chain.id);
          return (
            <button
              key={chain.id}
              type="button"
              onClick={() => toggleChain(chain.id)}
              data-testid={`chain-card-${chain.id}`}
              className={cn(
                'group relative flex flex-col items-center gap-3 rounded-xl border p-5 transition-all duration-200',
                isSelected
                  ? 'border-violet-500/50 bg-violet-500/5 shadow-[0_0_16px_rgba(139,92,246,0.1)]'
                  : 'border-zinc-800 bg-zinc-900 hover:border-zinc-700',
              )}
            >
              {/* Checkmark badge */}
              {isSelected && (
                <div className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-violet-500">
                  <svg
                    width="10"
                    height="10"
                    viewBox="0 0 10 10"
                    fill="none"
                    aria-hidden="true"
                  >
                    <path
                      d="M2 5.5L4 7.5L8 3"
                      stroke="white"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </div>
              )}

              <ChainLogo chainId={chain.id} size={40} />
              <span
                className={cn(
                  'text-sm font-medium',
                  isSelected ? 'text-foreground' : 'text-muted-foreground',
                )}
              >
                {chain.name}
              </span>
            </button>
          );
        })}
      </div>

      <p className="text-xs text-muted-foreground">
        {selectedChains.length} chain{selectedChains.length !== 1 ? 's' : ''} selected
      </p>

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
          disabled={selectedChains.length === 0}
          className="rounded-lg bg-violet-500 px-8 py-3 text-sm font-semibold text-white transition-colors hover:bg-violet-600 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950"
          data-testid="onboarding-next"
        >
          Continue
        </button>
      </div>
    </div>
  );
}
