'use client';

import type { UseOnboardingReturn } from '@/hooks/use-onboarding';

interface ConnectWalletStepProps {
  onboarding: UseOnboardingReturn;
}

/** Truncate wallet address to 0x1234...abcd format */
function truncateAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function ConnectWalletStep({ onboarding }: ConnectWalletStepProps) {
  // In the real app this comes from wagmi/SIWE. For the onboarding wizard
  // we show a mock connected state since the wallet is already connected.
  const walletAddress = '0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18';
  const chainName = 'Ethereum Mainnet';

  return (
    <div className="flex flex-col items-center gap-8">
      <div className="flex flex-col items-center gap-3 text-center">
        <h2 className="text-2xl font-bold text-foreground">Wallet Connected</h2>
        <p className="max-w-md text-sm text-muted-foreground">
          Your wallet is connected and ready. CYRUS will use this wallet as the
          controller for all cross-chain operations.
        </p>
      </div>

      {/* Connected wallet card */}
      <div className="w-full max-w-sm rounded-xl border border-border bg-zinc-900 p-6">
        <div className="flex items-center gap-4">
          {/* Green checkmark circle */}
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-emerald-500/10">
            <svg
              width="24"
              height="24"
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

          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium uppercase tracking-wider text-emerald-400">
              Connected
            </span>
            <span
              className="font-mono text-sm font-semibold text-foreground"
              data-testid="wallet-address"
            >
              {truncateAddress(walletAddress)}
            </span>
            <span className="text-xs text-muted-foreground">{chainName}</span>
          </div>
        </div>
      </div>

      {/* Continue button */}
      <button
        type="button"
        onClick={onboarding.nextStep}
        className="rounded-lg bg-violet-500 px-8 py-3 text-sm font-semibold text-white transition-colors hover:bg-violet-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950"
        data-testid="onboarding-next"
      >
        Continue
      </button>
    </div>
  );
}
