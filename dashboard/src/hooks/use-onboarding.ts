'use client';

import { useState, useCallback, useEffect } from 'react';

const STORAGE_KEY_STEP = 'cyrus-onboarding-step';
const STORAGE_KEY_COMPLETED = 'cyrus-onboarding-completed';

export const ONBOARDING_STEPS = [
  'connect-wallet',
  'risk-profile',
  'select-chains',
  'review-strategy',
  'fund-wallet',
  'launch-agent',
] as const;

export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export const STEP_LABELS: Record<OnboardingStep, string> = {
  'connect-wallet': 'Connect Wallet',
  'risk-profile': 'Risk Profile',
  'select-chains': 'Select Chains',
  'review-strategy': 'Review Strategy',
  'fund-wallet': 'Fund Wallet',
  'launch-agent': 'Launch Agent',
};

export interface OnboardingData {
  riskLevel: number;
  selectedChains: number[];
}

export interface UseOnboardingReturn {
  /** Whether onboarding has been completed (skip rendering wizard) */
  isCompleted: boolean;
  /** Current step index (0-based) */
  currentStepIndex: number;
  /** Current step key */
  currentStep: OnboardingStep;
  /** Total number of steps */
  totalSteps: number;
  /** Progress percentage (0-100) */
  progress: number;
  /** Onboarding data accumulated across steps */
  data: OnboardingData;
  /** Update partial onboarding data */
  updateData: (partial: Partial<OnboardingData>) => void;
  /** Go to next step */
  nextStep: () => void;
  /** Go to previous step */
  prevStep: () => void;
  /** Go to a specific step by index */
  goToStep: (index: number) => void;
  /** Whether we can go back */
  canGoBack: boolean;
  /** Whether we are on the last step */
  isLastStep: boolean;
  /** Mark onboarding as complete */
  completeOnboarding: () => void;
  /** Whether the initial load from localStorage is done */
  isHydrated: boolean;
}

function readStorageStep(): number {
  if (typeof window === 'undefined') return 0;
  try {
    const raw = localStorage.getItem(STORAGE_KEY_STEP);
    if (raw === null) return 0;
    const parsed = parseInt(raw, 10);
    if (Number.isNaN(parsed) || parsed < 0 || parsed >= ONBOARDING_STEPS.length) return 0;
    return parsed;
  } catch {
    return 0;
  }
}

function readStorageCompleted(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return localStorage.getItem(STORAGE_KEY_COMPLETED) === 'true';
  } catch {
    return false;
  }
}

export function useOnboarding(): UseOnboardingReturn {
  // Initialize state lazily from localStorage to avoid synchronous setState in effects.
  // The initializer functions only run once on mount and are safe for SSR
  // (readStorage* guards against window being undefined).
  const [isCompleted, setIsCompleted] = useState<boolean>(readStorageCompleted);
  const [currentStepIndex, setCurrentStepIndex] = useState<number>(readStorageStep);
  const [data, setData] = useState<OnboardingData>({
    riskLevel: 5,
    selectedChains: [1, 42161, 10, 8453],
  });

  // isHydrated is true on the client (window is defined) and false during SSR.
  // Using a lazy initializer avoids any effect-based setState.
  const [isHydrated] = useState<boolean>(() => typeof window !== 'undefined');

  // Persist step index to localStorage
  useEffect(() => {
    if (!isHydrated) return;
    try {
      localStorage.setItem(STORAGE_KEY_STEP, String(currentStepIndex));
    } catch {
      // Storage full or blocked — ignore
    }
  }, [currentStepIndex, isHydrated]);

  const totalSteps = ONBOARDING_STEPS.length;
  const currentStep = ONBOARDING_STEPS[currentStepIndex];
  const progress = ((currentStepIndex + 1) / totalSteps) * 100;
  const canGoBack = currentStepIndex > 0;
  const isLastStep = currentStepIndex === totalSteps - 1;

  const nextStep = useCallback(() => {
    setCurrentStepIndex((prev) => Math.min(prev + 1, totalSteps - 1));
  }, [totalSteps]);

  const prevStep = useCallback(() => {
    setCurrentStepIndex((prev) => Math.max(prev - 1, 0));
  }, []);

  const goToStep = useCallback(
    (index: number) => {
      if (index >= 0 && index < totalSteps) {
        setCurrentStepIndex(index);
      }
    },
    [totalSteps],
  );

  const updateData = useCallback((partial: Partial<OnboardingData>) => {
    setData((prev) => ({ ...prev, ...partial }));
  }, []);

  const completeOnboarding = useCallback(() => {
    setIsCompleted(true);
    try {
      localStorage.setItem(STORAGE_KEY_COMPLETED, 'true');
      localStorage.removeItem(STORAGE_KEY_STEP);
    } catch {
      // Storage full or blocked — ignore
    }
  }, []);

  return {
    isCompleted,
    currentStepIndex,
    currentStep,
    totalSteps,
    progress,
    data,
    updateData,
    nextStep,
    prevStep,
    goToStep,
    canGoBack,
    isLastStep,
    completeOnboarding,
    isHydrated,
  };
}
