'use client';

import { useState, useCallback, useRef } from 'react';
import confetti from 'canvas-confetti';
import { getRiskTierLabel } from '@/components/settings/risk-allocations';
import type { UseOnboardingReturn } from '@/hooks/use-onboarding';

interface LaunchAgentStepProps {
  onboarding: UseOnboardingReturn;
  onDismiss: () => void;
}

export function LaunchAgentStep({ onboarding, onDismiss }: LaunchAgentStepProps) {
  const [isLaunching, setIsLaunching] = useState(false);
  const [isLaunched, setIsLaunched] = useState(false);
  const launchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  const fireConfetti = useCallback(() => {
    try {
      // Center burst
      confetti({
        particleCount: 100,
        spread: 70,
        origin: { y: 0.6 },
        colors: ['#8B5CF6', '#A78BFA', '#C4B5FD', '#DDD6FE', '#10B981', '#34D399'],
      });
      // Side bursts
      confetti({
        particleCount: 50,
        angle: 60,
        spread: 55,
        origin: { x: 0, y: 0.6 },
        colors: ['#8B5CF6', '#A78BFA', '#C4B5FD'],
      });
      confetti({
        particleCount: 50,
        angle: 120,
        spread: 55,
        origin: { x: 1, y: 0.6 },
        colors: ['#8B5CF6', '#A78BFA', '#C4B5FD'],
      });
    } catch {
      // canvas-confetti not available — silently fail
    }
  }, []);

  const handleLaunch = useCallback(() => {
    setIsLaunching(true);

    // Simulate a brief launch delay, then celebrate
    launchTimerRef.current = setTimeout(() => {
      setIsLaunching(false);
      setIsLaunched(true);
      fireConfetti();
      onboarding.completeOnboarding();
    }, 1500);
  }, [fireConfetti, onboarding]);

  return (
    <div className="flex flex-col items-center gap-8">
      {!isLaunched ? (
        <>
          <div className="flex flex-col items-center gap-3 text-center">
            <h2 className="text-2xl font-bold text-foreground">Launch CYRUS</h2>
            <p className="max-w-md text-sm text-muted-foreground">
              Everything is configured. Review your setup and launch the agent when
              ready.
            </p>
          </div>

          {/* Summary card */}
          <div className="w-full max-w-md rounded-xl border border-border bg-zinc-900 p-6">
            <h3 className="mb-4 text-sm font-semibold text-foreground">Launch Summary</h3>
            <div className="space-y-3">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Strategy</span>
                <span className="font-medium text-foreground">YieldHunter</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Risk Profile</span>
                <span className="font-medium text-foreground">
                  {tierLabel} (Level {riskLevel})
                </span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Chains</span>
                <span className="font-medium text-foreground">
                  {selectedChains.length} active
                </span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Active Chains</span>
                <span className="text-right text-xs text-muted-foreground">
                  {selectedChains
                    .map((id) => chainNames[id] ?? `Chain ${id}`)
                    .join(', ')}
                </span>
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
              onClick={handleLaunch}
              disabled={isLaunching}
              className="flex items-center gap-2 rounded-lg bg-violet-500 px-8 py-3 text-sm font-semibold text-white transition-colors hover:bg-violet-600 disabled:cursor-not-allowed disabled:opacity-70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950"
              data-testid="launch-agent-button"
            >
              {isLaunching ? (
                <>
                  <span
                    className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent"
                    aria-hidden="true"
                  />
                  Launching...
                </>
              ) : (
                <>
                  {/* Rocket icon */}
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    aria-hidden="true"
                  >
                    <path
                      d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 00-2.91-.09zM12 15l-3-3M22 2l-7.5 10.5M10.5 13.5L2 22M16.5 12l4-4M12 7.5l4-4"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  Launch Agent
                </>
              )}
            </button>
          </div>
        </>
      ) : (
        /* Success state */
        <div className="flex flex-col items-center gap-6 text-center" data-testid="launch-success">
          <div className="flex h-20 w-20 items-center justify-center rounded-full bg-emerald-500/10">
            <svg
              width="40"
              height="40"
              viewBox="0 0 24 24"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M5 13l4 4L19 7"
                stroke="#10B981"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <div>
            <h2 className="text-2xl font-bold text-foreground">CYRUS is Live!</h2>
            <p className="mt-2 max-w-md text-sm text-muted-foreground">
              Your autonomous agent is now running across{' '}
              {selectedChains.length} chains. Monitor performance and chat with
              CYRUS from the dashboard.
            </p>
          </div>
          <button
            type="button"
            onClick={onDismiss}
            className="rounded-lg bg-violet-500 px-8 py-3 text-sm font-semibold text-white transition-colors hover:bg-violet-600"
            data-testid="go-to-dashboard"
          >
            Go to Dashboard
          </button>
        </div>
      )}
    </div>
  );
}
