'use client';

import { cn } from '@/lib/utils';

const CHAIN_CONFIG: Record<number, { name: string; color: string; initial: string }> = {
  1: { name: 'Ethereum', color: '#627EEA', initial: 'E' },
  42161: { name: 'Arbitrum', color: '#28A0F0', initial: 'A' },
  10: { name: 'Optimism', color: '#FF0420', initial: 'O' },
  137: { name: 'Polygon', color: '#8247E5', initial: 'P' },
  8453: { name: 'Base', color: '#0052FF', initial: 'B' },
  56: { name: 'BSC', color: '#F0B90B', initial: 'B' },
};

interface ChainLogoProps {
  chainId: number;
  size?: number;
  showName?: boolean;
  className?: string;
}

export function ChainLogo({ chainId, size = 32, showName = false, className }: ChainLogoProps) {
  const chain = CHAIN_CONFIG[chainId] ?? { name: `Chain ${chainId}`, color: '#71717A', initial: '?' };

  return (
    <div className={cn('flex flex-col items-center gap-1', className)}>
      <svg
        width={size}
        height={size}
        viewBox="0 0 32 32"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        role="img"
        aria-label={chain.name}
        data-testid={`chain-logo-${chainId}`}
      >
        <circle cx="16" cy="16" r="16" fill={chain.color} />
        <text
          x="16"
          y="16"
          dominantBaseline="central"
          textAnchor="middle"
          fill="white"
          fontSize="13"
          fontWeight="700"
          fontFamily="system-ui, sans-serif"
        >
          {chain.initial}
        </text>
      </svg>
      {showName && (
        <span className="text-[10px] text-muted-foreground leading-none">{chain.name}</span>
      )}
    </div>
  );
}

export function getChainName(chainId: number): string {
  return CHAIN_CONFIG[chainId]?.name ?? `Chain ${chainId}`;
}

export function getChainColor(chainId: number): string {
  return CHAIN_CONFIG[chainId]?.color ?? '#71717A';
}
