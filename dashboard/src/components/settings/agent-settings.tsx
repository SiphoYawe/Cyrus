'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { Input } from '@/components/ui/input';
import { Slider } from '@/components/ui/slider';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { useConfig } from '@/hooks/use-config';
import { useAgentStore } from '@/stores/agent-store';
import { toast } from 'sonner';

type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

const LOG_LEVELS: readonly LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];

interface AgentSettingsProps {
  className?: string;
}

export function AgentSettings({ className }: AgentSettingsProps) {
  const { config, isLoading, updateConfig } = useConfig();
  const agentStatus = useAgentStore((s) => s.status);
  const isOffline = agentStatus === 'unknown' || agentStatus === 'stopped';

  const [tickInterval, setTickInterval] = useState<string>('30');
  const [logLevel, setLogLevel] = useState<LogLevel>('info');
  const [confirmationThreshold, setConfirmationThreshold] = useState<number>(3);

  const prevTickRef = useRef<string>('30');
  const prevLogRef = useRef<LogLevel>('info');
  const prevThresholdRef = useRef<number>(3);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Hydrate from backend config
  useEffect(() => {
    if (config) {
      const secs = String(Math.round(config.tickIntervalMs / 1000));
      setTickInterval(secs);
      prevTickRef.current = secs;

      const level = config.logLevel as LogLevel;
      setLogLevel(level);
      prevLogRef.current = level;
    }
  }, [config]);

  const envOverrides = config?.envOverrides ?? [];
  const isTickOverridden = envOverrides.includes('tickIntervalMs');
  const isLogLevelOverridden = envOverrides.includes('logLevel');

  const patchConfig = useCallback(
    async (patch: Record<string, unknown>, prevValues: () => void) => {
      try {
        await updateConfig(patch);
        toast.success('Settings updated', { duration: 4000 });
      } catch (err) {
        prevValues();
        const message = err instanceof Error ? err.message : 'Update failed';
        toast.error(message, {
          duration: Infinity,
          action: {
            label: 'Retry',
            onClick: () => void patchConfig(patch, prevValues),
          },
        });
      }
    },
    [updateConfig],
  );

  const handleTickIntervalChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = e.target.value;
      setTickInterval(val);
      const parsed = parseInt(val, 10);
      if (!isNaN(parsed) && parsed > 0) {
        if (debounceRef.current) clearTimeout(debounceRef.current);
        const prevVal = prevTickRef.current;
        prevTickRef.current = val;
        debounceRef.current = setTimeout(() => {
          void patchConfig(
            { tickIntervalMs: parsed * 1000 },
            () => { setTickInterval(prevVal); prevTickRef.current = prevVal; },
          );
        }, 600);
      }
    },
    [patchConfig],
  );

  const handleLogLevelChange = useCallback(
    (val: string) => {
      const level = val as LogLevel;
      const prevLevel = prevLogRef.current;
      setLogLevel(level);
      prevLogRef.current = level;
      void patchConfig(
        { logLevel: level },
        () => { setLogLevel(prevLevel); prevLogRef.current = prevLevel; },
      );
    },
    [patchConfig],
  );

  const handleThresholdChange = useCallback(
    (values: number[]) => {
      const val = values[0];
      const prevVal = prevThresholdRef.current;
      setConfirmationThreshold(val);
      prevThresholdRef.current = val;
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        void patchConfig(
          { confirmationThreshold: val },
          () => { setConfirmationThreshold(prevVal); prevThresholdRef.current = prevVal; },
        );
      }, 600);
    },
    [patchConfig],
  );

  if (isLoading && !config) {
    return (
      <div className={cn('space-y-6', className)}>
        <Skeleton className="h-20 w-full rounded-lg" />
        <Skeleton className="h-20 w-full rounded-lg" />
        <Skeleton className="h-24 w-full rounded-lg" />
      </div>
    );
  }

  return (
    <div className={cn('space-y-6', className)} title={isOffline ? 'Agent offline — settings are read-only' : undefined}>
      {/* Tick interval */}
      <div className="space-y-2">
        <label htmlFor="tick-interval" className="text-sm font-medium text-foreground">
          Tick Interval (seconds)
        </label>
        <p className="text-xs text-muted-foreground">
          How often the agent evaluates market conditions and executes strategies.
        </p>
        {isTickOverridden && (
          <p className="text-xs text-amber-400">Set by environment variable</p>
        )}
        <Input
          id="tick-interval"
          type="number"
          min={5}
          max={3600}
          value={tickInterval}
          onChange={handleTickIntervalChange}
          className={cn('w-40', (isOffline || isTickOverridden) && 'opacity-50')}
          disabled={isOffline || isTickOverridden}
          aria-describedby="tick-interval-desc"
        />
        <p id="tick-interval-desc" className="sr-only">
          Minimum 5 seconds, maximum 3600 seconds
        </p>
      </div>

      {/* Log level */}
      <div className="space-y-2">
        <label htmlFor="log-level-trigger" className="text-sm font-medium text-foreground">
          Log Level
        </label>
        <p className="text-xs text-muted-foreground">
          Controls verbosity of agent output logs.
        </p>
        {isLogLevelOverridden && (
          <p className="text-xs text-amber-400">Set by environment variable</p>
        )}
        <Select
          value={logLevel}
          onValueChange={handleLogLevelChange}
          disabled={isOffline || isLogLevelOverridden}
        >
          <SelectTrigger
            id="log-level-trigger"
            className={cn('w-40', (isOffline || isLogLevelOverridden) && 'opacity-50')}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LOG_LEVELS.map((level) => (
              <SelectItem key={level} value={level}>
                {level.charAt(0).toUpperCase() + level.slice(1)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Confirmation threshold */}
      <div className="space-y-3">
        <div>
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium text-foreground">
              Confirmation Threshold
            </label>
            <span className="text-sm font-medium tabular-nums text-foreground">
              {confirmationThreshold} block{confirmationThreshold !== 1 ? 's' : ''}
            </span>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Number of block confirmations required before marking a transaction as confirmed.
          </p>
        </div>
        <Slider
          min={1}
          max={12}
          step={1}
          value={[confirmationThreshold]}
          onValueChange={handleThresholdChange}
          disabled={isOffline}
          aria-label="Confirmation threshold"
          aria-valuenow={confirmationThreshold}
          aria-valuemin={1}
          aria-valuemax={12}
          className={cn('w-full max-w-xs', isOffline && 'opacity-50')}
        />
        <div className="flex justify-between max-w-xs text-[10px] text-muted-foreground/60 px-0.5">
          <span>1</span>
          <span>6</span>
          <span>12</span>
        </div>
      </div>
    </div>
  );
}
