'use client';

import { useState, useCallback } from 'react';
import { cn } from '@/lib/utils';
import {
  useOnboarding,
  ONBOARDING_STEPS,
  STEP_LABELS,
  type OnboardingStep,
} from '@/hooks/use-onboarding';
import { ConnectWalletStep } from './steps/connect-wallet-step';
import { RiskProfileStep } from './steps/risk-profile-step';
import { SelectChainsStep } from './steps/select-chains-step';
import { ReviewStrategyStep } from './steps/review-strategy-step';
import { FundWalletStep } from './steps/fund-wallet-step';
import { LaunchAgentStep } from './steps/launch-agent-step';

/**
 * Full-page onboarding wizard overlay.
 * Renders on top of the dashboard when onboarding is not yet completed.
 * Progress and step state are persisted to localStorage.
 *
 * Visibility logic:
 * - On mount, if localStorage says completed -> don't render (prior session).
 * - During the session, when the user completes onboarding (launches agent),
 *   the wizard stays visible showing the success screen until the user
 *   clicks "Go to Dashboard", which sets `dismissed=true`.
 */
export function OnboardingWizard() {
  const onboarding = useOnboarding();

  // Track whether user has explicitly dismissed the post-launch success screen.
  const [dismissed, setDismissed] = useState(false);

  // Dismiss handler passed to the launch step's "Go to Dashboard" button.
  const handleDismiss = useCallback(() => {
    setDismissed(true);
  }, []);

  // Don't render until hydration completes (avoids flash of wizard on completed sessions)
  if (!onboarding.isHydrated) return null;

  // If user dismissed the success screen this session, hide wizard
  if (dismissed) return null;

  // If onboarding was already completed in a prior session, hide wizard.
  // We detect "prior session" vs "just completed" by: on prior-session load the
  // step index resets to 0 (localStorage key was removed on completion). If
  // isCompleted is true and step is 0, it's a prior-session completion.
  // If isCompleted is true and step is 5 (launch), the user just launched.
  if (onboarding.isCompleted && onboarding.currentStepIndex !== ONBOARDING_STEPS.length - 1) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-zinc-950"
      data-testid="onboarding-wizard"
      role="dialog"
      aria-modal="true"
      aria-label="CYRUS Onboarding"
    >
      {/* Top bar with logo + progress */}
      <header className="flex items-center justify-between border-b border-zinc-800 px-6 py-4">
        <div className="flex items-center gap-3">
          {/* Logo mark */}
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-violet-500">
            <span className="text-sm font-bold text-white">C</span>
          </div>
          <span className="text-sm font-semibold text-foreground tracking-wide">
            CYRUS Setup
          </span>
        </div>

        {/* Step counter */}
        <span className="text-xs text-muted-foreground">
          Step {onboarding.currentStepIndex + 1} of {onboarding.totalSteps}
        </span>
      </header>

      {/* Progress bar */}
      <div className="h-1 w-full bg-zinc-800">
        <div
          className="h-full bg-violet-500 transition-all duration-300 ease-out"
          style={{ width: `${onboarding.progress}%` }}
          role="progressbar"
          aria-valuenow={onboarding.progress}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Onboarding progress"
          data-testid="onboarding-progress"
        />
      </div>

      {/* Step indicator dots */}
      <nav className="flex justify-center gap-3 px-6 py-6" aria-label="Onboarding steps">
        {ONBOARDING_STEPS.map((step, index) => {
          const isStepCompleted = index < onboarding.currentStepIndex;
          const isCurrent = index === onboarding.currentStepIndex;
          return (
            <button
              key={step}
              type="button"
              onClick={() => {
                // Only allow going to completed steps
                if (index <= onboarding.currentStepIndex) {
                  onboarding.goToStep(index);
                }
              }}
              disabled={index > onboarding.currentStepIndex}
              className={cn(
                'flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium transition-all',
                isCurrent && 'bg-violet-500/10 text-violet-400',
                isStepCompleted && 'text-violet-400/70 hover:text-violet-400',
                !isCurrent && !isStepCompleted && 'text-zinc-600 cursor-not-allowed',
              )}
              aria-current={isCurrent ? 'step' : undefined}
              aria-label={`${STEP_LABELS[step]}${isStepCompleted ? ' (completed)' : ''}${isCurrent ? ' (current)' : ''}`}
              data-testid={`step-indicator-${step}`}
            >
              {/* Step dot */}
              <span
                className={cn(
                  'inline-block h-2 w-2 rounded-full transition-colors',
                  isCurrent && 'bg-violet-500',
                  isStepCompleted && 'bg-violet-500/60',
                  !isCurrent && !isStepCompleted && 'bg-zinc-700',
                )}
              />
              {/* Show label on md+ screens */}
              <span className="hidden sm:inline">{STEP_LABELS[step]}</span>
            </button>
          );
        })}
      </nav>

      {/* Step content */}
      <div className="flex flex-1 items-center justify-center overflow-y-auto px-6 pb-12">
        <StepRenderer
          step={onboarding.currentStep}
          onboarding={onboarding}
          onDismiss={handleDismiss}
        />
      </div>
    </div>
  );
}

/** Renders the correct step component */
function StepRenderer({
  step,
  onboarding,
  onDismiss,
}: {
  step: OnboardingStep;
  onboarding: ReturnType<typeof useOnboarding>;
  onDismiss: () => void;
}) {
  switch (step) {
    case 'connect-wallet':
      return <ConnectWalletStep onboarding={onboarding} />;
    case 'risk-profile':
      return <RiskProfileStep onboarding={onboarding} />;
    case 'select-chains':
      return <SelectChainsStep onboarding={onboarding} />;
    case 'review-strategy':
      return <ReviewStrategyStep onboarding={onboarding} />;
    case 'fund-wallet':
      return <FundWalletStep onboarding={onboarding} />;
    case 'launch-agent':
      return <LaunchAgentStep onboarding={onboarding} onDismiss={onDismiss} />;
    default:
      return null;
  }
}
