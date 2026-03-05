'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { useConfig } from '@/hooks/use-config';
import { useAgentStore } from '@/stores/agent-store';
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
  const { config, isLoading, updateConfig } = useConfig();
  const agentStatus = useAgentStore((s) => s.status);
  const isOffline = agentStatus === 'unknown' || agentStatus === 'stopped';

  const [enabled, setEnabled] = useState<Record<number, boolean>>(() =>
    Object.fromEntries(SUPPORTED_CHAINS.map((c) => [c.id, true])),
  );

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Hydrate from backend config
  useEffect(() => {
    if (config?.chains?.enabled) {
      const enabledSet = new Set(config.chains.enabled);
      setEnabled(
        Object.fromEntries(SUPPORTED_CHAINS.map((c) => [c.id, enabledSet.has(c.id)])),
      );
    }
  }, [config]);

  const envOverrides = config?.envOverrides ?? [];
  const isChainsOverridden = envOverrides.includes('chains.enabled');

  const handleToggle = useCallback(
    (chainId: number, value: boolean) => {
      const prevEnabled = { ...enabled };

      // Optimistic update
      const newEnabled = { ...enabled, [chainId]: value };
      setEnabled(newEnabled);

      const newEnabledList = SUPPORTED_CHAINS
        .filter((c) => newEnabled[c.id])
        .map((c) => c.id);

      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        updateConfig({ chains: { enabled: newEnabledList } })
          .then(() => {
            const chain = SUPPORTED_CHAINS.find((c) => c.id === chainId);
            toast.success(`${chain?.name ?? 'Chain'} ${value ? 'enabled' : 'disabled'}.`, { duration: 4000 });
          })
          .catch((err) => {
            // Rollback
            setEnabled(prevEnabled);
            const message = err instanceof Error ? err.message : 'Update failed';
            toast.error(message, {
              duration: Infinity,
              action: {
                label: 'Retry',
                onClick: () => handleToggle(chainId, value),
              },
            });
          });
      }, 600);
    },
    [enabled, updateConfig],
  );

  if (isLoading && !config) {
    return (
      <div className={cn('space-y-3', className)}>
        {[1, 2, 3, 4, 5, 6].map((i) => (
          <Skeleton key={i} className="h-16 w-full rounded-lg" />
        ))}
      </div>
    );
  }

  return (
    <div
      className={cn('space-y-3', className)}
      title={isOffline ? 'Agent offline — settings are read-only' : undefined}
    >
      {isChainsOverridden && (
        <p className="text-xs text-amber-400 mb-2">
          Chain selection is set by environment variable
        </p>
      )}
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
            disabled={isOffline || isChainsOverridden}
            aria-label={`Toggle ${chain.name}`}
            className={cn((isOffline || isChainsOverridden) && 'opacity-50')}
          />
        </div>
      ))}
    </div>
  );
}
