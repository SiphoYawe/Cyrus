'use client';

import { useState, useCallback } from 'react';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ChevronDownIcon, ChevronRightIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useWebSocket } from '@/providers/ws-provider';
import { useAgentStore } from '@/stores/agent-store';
import { WS_COMMANDS } from '@/types/ws';
import { toast } from 'sonner';

interface StrategyParam {
  readonly key: string;
  readonly label: string;
  readonly type: 'number' | 'text';
  readonly placeholder?: string;
}

interface StrategyDef {
  readonly name: string;
  readonly description: string;
  readonly params: readonly StrategyParam[];
}

const DEFAULT_STRATEGIES: readonly StrategyDef[] = [
  {
    name: 'YieldHunter',
    description: 'Automatically routes capital to highest-yield vaults across chains.',
    params: [
      { key: 'minYieldBps',       label: 'Min yield (bps)',      type: 'number', placeholder: '50' },
      { key: 'maxPositionUsd',    label: 'Max position (USD)',   type: 'number', placeholder: '10000' },
      { key: 'rebalanceInterval', label: 'Rebalance interval (s)', type: 'number', placeholder: '3600' },
    ],
  },
  {
    name: 'CrossChainArb',
    description: 'Exploits price differences for the same token across chains.',
    params: [
      { key: 'minProfitBps', label: 'Min profit (bps)',  type: 'number', placeholder: '20' },
      { key: 'maxSlippage',  label: 'Max slippage (bps)', type: 'number', placeholder: '30' },
      { key: 'maxGasUsd',    label: 'Max gas (USD)',      type: 'number', placeholder: '5' },
    ],
  },
  {
    name: 'StatArb',
    description: 'Mean-reversion pair trading based on cointegrated token pairs.',
    params: [
      { key: 'zScoreEntry',    label: 'Z-score entry threshold',  type: 'number', placeholder: '1.5' },
      { key: 'zScoreExit',     label: 'Z-score exit threshold',   type: 'number', placeholder: '0.5' },
      { key: 'maxPairPositions', label: 'Max pair positions',    type: 'number', placeholder: '10' },
    ],
  },
] as const;

interface StrategyRowProps {
  strategy: StrategyDef;
  enabled: boolean;
  onToggle: (name: string, enabled: boolean) => void;
  onSaveParams: (name: string, params: Record<string, string>) => void;
}

function StrategyRow({ strategy, enabled, onToggle, onSaveParams }: StrategyRowProps) {
  const [open, setOpen] = useState(false);
  const [params, setParams] = useState<Record<string, string>>(() =>
    Object.fromEntries(strategy.params.map((p) => [p.key, p.placeholder ?? ''])),
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
                <p className="text-xs text-muted-foreground">{strategy.description}</p>
              </div>
            </button>
          </CollapsibleTrigger>
          <Switch
            checked={enabled}
            onCheckedChange={(v) => onToggle(strategy.name, v)}
            aria-label={`Toggle ${strategy.name} strategy`}
          />
        </div>

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
                    {param.label}
                  </label>
                  <Input
                    id={`${strategy.name}-${param.key}`}
                    type={param.type}
                    value={params[param.key] ?? ''}
                    placeholder={param.placeholder}
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
      </div>
    </Collapsible>
  );
}

interface StrategiesSettingsProps {
  className?: string;
}

export function StrategiesSettings({ className }: StrategiesSettingsProps) {
  const { send } = useWebSocket();
  const activeStrategies = useAgentStore((s) => s.activeStrategies);

  const [enabledMap, setEnabledMap] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(
      DEFAULT_STRATEGIES.map((s) => [s.name, activeStrategies.includes(s.name)]),
    ),
  );

  const handleToggle = useCallback(
    (name: string, enabled: boolean) => {
      setEnabledMap((prev) => ({ ...prev, [name]: enabled }));
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

  return (
    <div className={cn('space-y-3', className)}>
      {DEFAULT_STRATEGIES.map((strategy) => (
        <StrategyRow
          key={strategy.name}
          strategy={strategy}
          enabled={enabledMap[strategy.name] ?? false}
          onToggle={handleToggle}
          onSaveParams={handleSaveParams}
        />
      ))}
    </div>
  );
}
