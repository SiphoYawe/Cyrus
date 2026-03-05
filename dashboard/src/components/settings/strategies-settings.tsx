'use client';

import { useState, useCallback } from 'react';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ChevronDownIcon, ChevronRightIcon } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { useWebSocket } from '@/providers/ws-provider';
import { useStrategies } from '@/hooks/use-strategies';
import { WS_COMMANDS } from '@/types/ws';
import { toast } from 'sonner';
import type { Strategy } from '@/stores/strategies-store';

interface StrategyRowProps {
  strategy: Strategy;
  onToggle: (name: string, enabled: boolean) => void;
  onSaveParams: (name: string, params: Record<string, string>) => void;
}

function StrategyRow({ strategy, onToggle, onSaveParams }: StrategyRowProps) {
  const [open, setOpen] = useState(false);
  const [params, setParams] = useState<Record<string, string>>(() =>
    Object.fromEntries(strategy.params.map((p) => [p.key, String(p.value)])),
  );
  const [dirty, setDirty] = useState(false);

  const handleParamChange = useCallback((key: string, value: string) => {
    setParams((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
  }, []);

  const handleSave = useCallback(() => {
    onSaveParams(strategy.name, params);
    setDirty(false);
  }, [onSaveParams, strategy.name, params]);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="rounded-lg border border-border bg-muted/20">
        <div className="flex items-center justify-between gap-4 px-4 py-3">
          <CollapsibleTrigger
            asChild
            aria-expanded={open}
            aria-controls={`strategy-params-${strategy.name}`}
          >
            <button
              type="button"
              className="flex flex-1 items-center gap-2 text-left focus-visible:outline-none"
            >
              {open ? (
                <ChevronDownIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
              ) : (
                <ChevronRightIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
              )}
              <div>
                <p className="text-sm font-medium text-foreground">{strategy.name}</p>
                <p className="text-xs text-muted-foreground">
                  {strategy.tier} tier &middot; {strategy.metrics.totalTrades} trades
                </p>
              </div>
            </button>
          </CollapsibleTrigger>
          <Switch
            checked={strategy.enabled}
            onCheckedChange={(v) => onToggle(strategy.name, v)}
            aria-label={`Toggle ${strategy.name} strategy`}
          />
        </div>

        {strategy.params.length > 0 && (
          <CollapsibleContent id={`strategy-params-${strategy.name}`}>
            <div className="border-t border-border px-4 pb-4 pt-3 space-y-3">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Parameters
              </p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {strategy.params.map((param) => (
                  <div key={param.key} className="space-y-1">
                    <label
                      htmlFor={`${strategy.name}-${param.key}`}
                      className="text-xs text-muted-foreground"
                    >
                      {param.description ?? param.key}
                    </label>
                    <Input
                      id={`${strategy.name}-${param.key}`}
                      type={typeof param.value === 'number' ? 'number' : 'text'}
                      value={params[param.key] ?? ''}
                      onChange={(e) => handleParamChange(param.key, e.target.value)}
                      className="h-8 text-sm"
                    />
                  </div>
                ))}
              </div>
              {dirty && (
                <Button
                  size="sm"
                  variant="default"
                  className="mt-1 bg-violet-500 text-white hover:bg-violet-600"
                  onClick={handleSave}
                >
                  Save Parameters
                </Button>
              )}
            </div>
          </CollapsibleContent>
        )}
      </div>
    </Collapsible>
  );
}

interface StrategiesSettingsProps {
  className?: string;
}

export function StrategiesSettings({ className }: StrategiesSettingsProps) {
  const { send } = useWebSocket();
  const { strategies, isLoading } = useStrategies();

  const handleToggle = useCallback(
    (name: string, enabled: boolean) => {
      send({
        command: WS_COMMANDS.STRATEGY_TOGGLE,
        payload: { strategy: name, enabled },
      });
      toast.success(`${name} ${enabled ? 'enabled' : 'disabled'}.`);
    },
    [send],
  );

  const handleSaveParams = useCallback(
    (name: string, params: Record<string, string>) => {
      send({
        command: WS_COMMANDS.CONFIG_UPDATE,
        payload: { strategy: name, params },
      });
      toast.success(`${name} parameters saved.`);
    },
    [send],
  );

  if (isLoading) {
    return (
      <div className={cn('space-y-3', className)}>
        {[1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-16 w-full rounded-lg" />
        ))}
      </div>
    );
  }

  if (strategies.length === 0) {
    return (
      <div className={cn('space-y-3', className)}>
        <p className="text-sm text-muted-foreground">
          No strategies loaded. Add strategy classes to the strategies directory to get started.
        </p>
      </div>
    );
  }

  return (
    <div className={cn('space-y-3', className)}>
      {strategies.map((strategy) => (
        <StrategyRow
          key={strategy.name}
          strategy={strategy}
          onToggle={handleToggle}
          onSaveParams={handleSaveParams}
        />
      ))}
    </div>
  );
}
