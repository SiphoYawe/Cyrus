'use client';

import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { useConfig } from '@/hooks/use-config';

interface ApiKeyEntry {
  readonly id: string;
  readonly label: string;
  readonly envVar: string;
  readonly description: string;
  readonly configKey: 'lifiApiKey' | 'anthropicApiKey' | 'privateKey';
}

const API_KEYS: readonly ApiKeyEntry[] = [
  {
    id:           'lifi',
    label:        'LI.FI API Key',
    envVar:       'LIFI_API_KEY',
    description:  'Required for higher rate limits on LI.FI quote and route APIs.',
    configKey:    'lifiApiKey',
  },
  {
    id:           'anthropic',
    label:        'Anthropic API Key',
    envVar:       'ANTHROPIC_API_KEY',
    description:  'Required for the Claude AI orchestrator and market regime analysis.',
    configKey:    'anthropicApiKey',
  },
  {
    id:           'wallet',
    label:        'Wallet Private Key',
    envVar:       'CYRUS_PRIVATE_KEY',
    description:  'EVM private key used for signing transactions. Stored securely in env vars only.',
    configKey:    'privateKey',
  },
] as const;

interface StatusDotProps {
  configured: boolean;
}

function StatusDot({ configured }: StatusDotProps) {
  return (
    <span
      className={cn(
        'inline-block h-2.5 w-2.5 rounded-full flex-shrink-0',
        configured ? 'bg-green-500' : 'bg-red-500',
      )}
      aria-hidden="true"
    />
  );
}

interface ApiKeysSettingsProps {
  className?: string;
}

export function ApiKeysSettings({ className }: ApiKeysSettingsProps) {
  const { config, isLoading } = useConfig();
  const secretsConfigured = config?.secretsConfigured;

  if (isLoading && !config) {
    return (
      <div className={cn('space-y-3', className)}>
        <Skeleton className="h-4 w-3/4 rounded" />
        {[1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-20 w-full rounded-lg" />
        ))}
      </div>
    );
  }

  return (
    <div className={cn('space-y-3', className)}>
      <p className="text-xs text-muted-foreground">
        API keys are configured via environment variables on the server and are never displayed or editable from this UI.
      </p>

      {API_KEYS.map((entry) => {
        const configured = secretsConfigured
          ? secretsConfigured[entry.configKey]
          : false;

        return (
          <div
            key={entry.id}
            className="flex items-center justify-between gap-4 rounded-lg border border-border bg-muted/20 px-4 py-3"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <StatusDot configured={configured} />
                <p className="text-sm font-medium text-foreground">{entry.label}</p>
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">{entry.description}</p>
              <p className="mt-1 font-mono text-[10px] text-muted-foreground/50">
                {entry.envVar}
              </p>
            </div>

            <Badge
              variant="outline"
              className={cn(
                'flex-shrink-0 text-xs',
                configured
                  ? 'border-green-500/20 bg-green-500/10 text-green-400'
                  : 'border-red-500/20 bg-red-500/10 text-red-400',
              )}
            >
              {configured ? 'Configured' : 'Missing'}
            </Badge>
          </div>
        );
      })}

      <p className="text-xs text-muted-foreground/60">
        To update a key, restart the agent process with the updated environment variable. Never commit key values to version control.
      </p>
    </div>
  );
}
