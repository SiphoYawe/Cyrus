'use client';

import { useState, useCallback, useRef } from 'react';
import { Input } from '@/components/ui/input';
import { Slider } from '@/components/ui/slider';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { useWebSocket } from '@/providers/ws-provider';
import { WS_COMMANDS } from '@/types/ws';
import { toast } from 'sonner';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

interface AgentSettingsProps {
  className?: string;
}

export function AgentSettings({ className }: AgentSettingsProps) {
  const { send } = useWebSocket();

  const [tickInterval, setTickInterval] = useState<string>('30');
  const [logLevel, setLogLevel] = useState<LogLevel>('info');
  const [confirmationThreshold, setConfirmationThreshold] = useState<number>(3);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const sendDebounced = useCallback(
    (payload: Record<string, unknown>) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        send({ command: WS_COMMANDS.CONFIG_UPDATE, payload });
        toast.success('Agent settings updated.');
      }, 600);
    },
    [send],
  );

  const handleTickIntervalChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = e.target.value;
      setTickInterval(val);
      const parsed = parseInt(val, 10);
      if (!isNaN(parsed) && parsed > 0) {
        sendDebounced({ tickIntervalMs: parsed * 1000 });
      }
    },
    [sendDebounced],
  );

  const handleLogLevelChange = useCallback(
    (val: string) => {
      const level = val as LogLevel;
      setLogLevel(level);
      send({ command: WS_COMMANDS.CONFIG_UPDATE, payload: { logLevel: level } });
      toast.success(`Log level set to ${level}.`);
    },
    [send],
  );

  const handleThresholdChange = useCallback(
    (values: number[]) => {
      const val = values[0];
      setConfirmationThreshold(val);
      sendDebounced({ confirmationThreshold: val });
    },
    [sendDebounced],
  );

  return (
    <div className={cn('space-y-6', className)}>
      {/* Tick interval */}
      <div className="space-y-2">
        <label htmlFor="tick-interval" className="text-sm font-medium text-foreground">
          Tick Interval (seconds)
        </label>
        <p className="text-xs text-muted-foreground">
          How often the agent evaluates market conditions and executes strategies.
        </p>
        <Input
          id="tick-interval"
          type="number"
          min={5}
          max={3600}
          value={tickInterval}
          onChange={handleTickIntervalChange}
          className="w-40"
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
        <Select value={logLevel} onValueChange={handleLogLevelChange}>
          <SelectTrigger id="log-level-trigger" className="w-40">
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
          aria-label="Confirmation threshold"
          aria-valuenow={confirmationThreshold}
          aria-valuemin={1}
          aria-valuemax={12}
          className="w-full max-w-xs"
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
