'use client';

import { useState, useCallback } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import type { UseOnboardingReturn } from '@/hooks/use-onboarding';

interface FundWalletStepProps {
  onboarding: UseOnboardingReturn;
}

const AGENT_WALLET = '0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18';

export function FundWalletStep({ onboarding }: FundWalletStepProps) {
  const [copied, setCopied] = useState(false);

  // Simulated balance — in production this would come from portfolio store
  const balance = '$0.00';

  const copyAddress = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(AGENT_WALLET);
      setCopied(true);
      // Use queueMicrotask-safe timeout for state reset
      const id = setTimeout(() => setCopied(false), 2000);
      return () => clearTimeout(id);
    } catch {
      // Clipboard API not available — silent fail
    }
  }, []);

  return (
    <div className="flex flex-col items-center gap-8">
      <div className="flex flex-col items-center gap-3 text-center">
        <h2 className="text-2xl font-bold text-foreground">Fund Agent Wallet</h2>
        <p className="max-w-md text-sm text-muted-foreground">
          Send funds to the agent wallet below. CYRUS needs a starting balance to
          execute cross-chain strategies. You can fund it with ETH, USDC, or any
          supported token.
        </p>
      </div>

      {/* QR + Address card */}
      <div className="flex w-full max-w-sm flex-col items-center gap-6 rounded-xl border border-border bg-zinc-900 p-6">
        {/* QR Code */}
        <div className="rounded-xl bg-white p-3">
          <QRCodeSVG
            value={AGENT_WALLET}
            size={160}
            level="M"
            bgColor="#FFFFFF"
            fgColor="#09090B"
            data-testid="qr-code"
          />
        </div>

        {/* Address with copy */}
        <div className="flex w-full items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2.5">
          <span
            className="flex-1 truncate font-mono text-xs text-muted-foreground"
            data-testid="agent-wallet-address"
          >
            {AGENT_WALLET}
          </span>
          <button
            type="button"
            onClick={copyAddress}
            className="shrink-0 text-xs font-medium text-violet-400 transition-colors hover:text-violet-300"
            data-testid="copy-address"
          >
            {copied ? 'Copied!' : 'Copy'}
          </button>
        </div>

        {/* Balance monitor */}
        <div className="flex w-full items-center justify-between rounded-lg bg-zinc-800/50 px-4 py-3">
          <span className="text-xs text-muted-foreground">Agent Balance</span>
          <span className="font-mono text-sm font-semibold text-foreground" data-testid="agent-balance">
            {balance}
          </span>
        </div>
      </div>

      {/* Note */}
      <p className="max-w-sm text-center text-xs text-muted-foreground">
        You can skip this step and fund your agent wallet later from the
        dashboard. Minimum recommended: $100 USDC.
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
