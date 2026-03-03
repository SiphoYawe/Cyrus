'use client';

import { useState, useCallback } from 'react';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { useWebSocket } from '@/providers/ws-provider';
import { WS_COMMANDS } from '@/types/ws';
import { toast } from 'sonner';

interface ChainConfig {
  readonly id: number;
  readonly name: string;
  readonly color: string;
  readonly symbol: string;
}

const SUPPORTED_CHAINS: readonly ChainConfig[] = [
  { id: 1,      name: 'Ethereum', color: '#627EEA', symbol: 'ETH' },
  { id: 42161,  name: 'Arbitrum', color: '#28A0F0', symbol: 'ARB' },
  { id: 10,     name: 'Optimism', color: '#FF0420', symbol: 'OP'  },
  { id: 137,    name: 'Polygon',  color: '#8247E5', symbol: 'POL' },
  { id: 8453,   name: 'Base',     color: '#0052FF', symbol: 'ETH' },
  { id: 56,     name: 'BSC',      color: '#F0B90B', symbol: 'BNB' },
] as const;

function ChainLogo({ color, symbol }: { color: string; symbol: string }) {
  return (
    <div
      className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-xs font-bold text-white"
      style={{ backgroundColor: color }}
      aria-hidden="true"
    >
      {symbol.slice(0, 2)}
    </div>
  );
}

interface ChainsSettingsProps {
  className?: string;
}

export function ChainsSettings({ className }: ChainsSettingsProps) {
  const { send } = useWebSocket();

  const [enabled, setEnabled] = useState<Record<number, boolean>>(() =>
    Object.fromEntries(SUPPORTED_CHAINS.map((c) => [c.id, true])),
  );

  const handleToggle = useCallback(
    (chainId: number, value: boolean) => {
      // Optimistic update
      setEnabled((prev) => ({ ...prev, [chainId]: value }));

      send({
        command: WS_COMMANDS.CONFIG_UPDATE,
        payload: { chains: { [chainId]: value } },
      });

      const chain = SUPPORTED_CHAINS.find((c) => c.id === chainId);
      toast.success(`${chain?.name ?? 'Chain'} ${value ? 'enabled' : 'disabled'}.`);
    },
    [send],
  );

  return (
    <div className={cn('space-y-3', className)}>
      {SUPPORTED_CHAINS.map((chain) => (
        <div
          key={chain.id}
          className="flex items-center justify-between gap-4 rounded-lg border border-border bg-muted/20 px-4 py-3"
        >
          <div className="flex items-center gap-3">
            <ChainLogo color={chain.color} symbol={chain.symbol} />
            <div>
              <p className="text-sm font-medium text-foreground">{chain.name}</p>
              <p className="text-xs text-muted-foreground">Chain ID {chain.id}</p>
            </div>
          </div>
          <Switch
            checked={enabled[chain.id] ?? true}
            onCheckedChange={(v) => handleToggle(chain.id, v)}
            aria-label={`Toggle ${chain.name}`}
          />
        </div>
      ))}
    </div>
  );
}
