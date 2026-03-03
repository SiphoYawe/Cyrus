'use client';

import { useCallback, useEffect, useState } from 'react';
import { format } from 'date-fns';
import type { DateRange } from 'react-day-picker';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Calendar } from '@/components/ui/calendar';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { ChainLogo } from '@/components/transfers/chain-logo';
import type { ActivityFilters as Filters, StrategyTier } from '@/types/activity';

const SUPPORTED_CHAINS = [
  { id: 1, name: 'Ethereum' },
  { id: 42161, name: 'Arbitrum' },
  { id: 10, name: 'Optimism' },
  { id: 137, name: 'Polygon' },
  { id: 8453, name: 'Base' },
  { id: 56, name: 'BSC' },
];

const STRATEGY_TIERS: StrategyTier[] = ['Safe', 'Growth', 'Degen', 'Reserve'];

const TIER_BADGE: Record<StrategyTier, string> = {
  Safe: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
  Growth: 'bg-violet-500/10 text-violet-400 border-violet-500/20',
  Degen: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  Reserve: 'bg-zinc-500/10 text-zinc-400 border-zinc-500/20',
};

interface ActivityFiltersProps {
  onChange: (filters: Filters) => void;
  className?: string;
}

function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

function parseSearchParamFilters(params: URLSearchParams): Filters {
  const filters: Filters = {};
  const type = params.get('type');
  if (type === 'trade' || type === 'bridge' || type === 'deposit') {
    filters.type = type;
  }
  const chain = params.get('chain');
  if (chain) {
    filters.chains = chain.split(',').map(Number).filter(Boolean);
  }
  const strategy = params.get('strategy');
  if (strategy) {
    filters.strategies = strategy.split(',');
  }
  const dateFrom = params.get('dateFrom');
  if (dateFrom) filters.dateFrom = dateFrom;
  const dateTo = params.get('dateTo');
  if (dateTo) filters.dateTo = dateTo;
  return filters;
}

export function ActivityFilters({ onChange, className }: ActivityFiltersProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Initialise from URL
  const [selectedChains, setSelectedChains] = useState<number[]>(
    () => parseSearchParamFilters(searchParams).chains ?? []
  );
  const [selectedStrategies, setSelectedStrategies] = useState<string[]>(
    () => parseSearchParamFilters(searchParams).strategies ?? []
  );
  const [dateRange, setDateRange] = useState<DateRange | undefined>(() => {
    const f = parseSearchParamFilters(searchParams);
    if (f.dateFrom || f.dateTo) {
      return {
        from: f.dateFrom ? new Date(f.dateFrom) : undefined,
        to: f.dateTo ? new Date(f.dateTo) : undefined,
      };
    }
    return undefined;
  });

  const [dateOpen, setDateOpen] = useState(false);
  const [chainOpen, setChainOpen] = useState(false);
  const [strategyOpen, setStrategyOpen] = useState(false);

  // Build the filters object
  const filters: Filters = {
    chains: selectedChains.length > 0 ? selectedChains : undefined,
    strategies: selectedStrategies.length > 0 ? selectedStrategies : undefined,
    dateFrom: dateRange?.from ? dateRange.from.toISOString().split('T')[0] : undefined,
    dateTo: dateRange?.to ? dateRange.to.toISOString().split('T')[0] : undefined,
  };

  // Debounce before emitting + syncing URL
  const debouncedFilters = useDebounce(filters, 300);

  const serializeToUrl = useCallback(
    (f: Filters) => {
      const params = new URLSearchParams(searchParams.toString());
      if (f.chains?.length) {
        params.set('chain', f.chains.join(','));
      } else {
        params.delete('chain');
      }
      if (f.strategies?.length) {
        params.set('strategy', f.strategies.join(','));
      } else {
        params.delete('strategy');
      }
      if (f.dateFrom) {
        params.set('dateFrom', f.dateFrom);
      } else {
        params.delete('dateFrom');
      }
      if (f.dateTo) {
        params.set('dateTo', f.dateTo);
      } else {
        params.delete('dateTo');
      }
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [router, pathname, searchParams]
  );

  const chainsKey = debouncedFilters.chains?.join(',') ?? '';
  const strategiesKey = debouncedFilters.strategies?.join(',') ?? '';

  useEffect(() => {
    onChange(debouncedFilters);
    serializeToUrl(debouncedFilters);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chainsKey, strategiesKey, debouncedFilters.dateFrom, debouncedFilters.dateTo]);

  const clearAll = () => {
    setSelectedChains([]);
    setSelectedStrategies([]);
    setDateRange(undefined);
  };

  const hasActiveFilters =
    selectedChains.length > 0 || selectedStrategies.length > 0 || !!dateRange;

  const toggleChain = (id: number) => {
    setSelectedChains((prev) =>
      prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id]
    );
  };

  const toggleStrategy = (name: string) => {
    setSelectedStrategies((prev) =>
      prev.includes(name) ? prev.filter((s) => s !== name) : [...prev, name]
    );
  };

  return (
    <div
      className={cn('flex flex-wrap items-center gap-2', className)}
      data-testid="activity-filters"
    >
      {/* Date range */}
      <Popover open={dateOpen} onOpenChange={setDateOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className={cn(
              'h-8 gap-1.5 text-xs',
              dateRange && 'border-primary text-primary'
            )}
            data-testid="date-filter-trigger"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
              <line x1="16" y1="2" x2="16" y2="6" />
              <line x1="8" y1="2" x2="8" y2="6" />
              <line x1="3" y1="10" x2="21" y2="10" />
            </svg>
            {dateRange?.from
              ? dateRange.to
                ? `${format(dateRange.from, 'MMM d')} – ${format(dateRange.to, 'MMM d')}`
                : format(dateRange.from, 'MMM d')
              : 'Date range'}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            mode="range"
            selected={dateRange}
            onSelect={setDateRange}
            numberOfMonths={1}
            disabled={{ after: new Date() }}
          />
        </PopoverContent>
      </Popover>

      {/* Chain filter */}
      <Popover open={chainOpen} onOpenChange={setChainOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className={cn(
              'h-8 gap-1.5 text-xs',
              selectedChains.length > 0 && 'border-primary text-primary'
            )}
            data-testid="chain-filter-trigger"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
            </svg>
            Chains
            {selectedChains.length > 0 && (
              <span className="ml-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-primary text-[10px] text-primary-foreground">
                {selectedChains.length}
              </span>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-52 p-2" align="start">
          <div className="space-y-0.5">
            {SUPPORTED_CHAINS.map((chain) => {
              const selected = selectedChains.includes(chain.id);
              return (
                <button
                  key={chain.id}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-muted',
                    selected && 'bg-muted'
                  )}
                  onClick={() => toggleChain(chain.id)}
                  data-testid={`chain-option-${chain.id}`}
                >
                  <ChainLogo chainId={chain.id} size={18} />
                  <span className="flex-1 text-left">{chain.name}</span>
                  {selected && (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-primary" aria-hidden="true">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  )}
                </button>
              );
            })}
          </div>
        </PopoverContent>
      </Popover>

      {/* Strategy filter */}
      <Popover open={strategyOpen} onOpenChange={setStrategyOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className={cn(
              'h-8 gap-1.5 text-xs',
              selectedStrategies.length > 0 && 'border-primary text-primary'
            )}
            data-testid="strategy-filter-trigger"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="18" y1="20" x2="18" y2="10" />
              <line x1="12" y1="20" x2="12" y2="4" />
              <line x1="6" y1="20" x2="6" y2="14" />
            </svg>
            Strategy
            {selectedStrategies.length > 0 && (
              <span className="ml-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-primary text-[10px] text-primary-foreground">
                {selectedStrategies.length}
              </span>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-44 p-2" align="start">
          <div className="space-y-0.5">
            {STRATEGY_TIERS.map((tier) => {
              const selected = selectedStrategies.includes(tier);
              return (
                <button
                  key={tier}
                  className={cn(
                    'flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-muted',
                    selected && 'bg-muted'
                  )}
                  onClick={() => toggleStrategy(tier)}
                  data-testid={`strategy-option-${tier.toLowerCase()}`}
                >
                  <Badge
                    variant="outline"
                    className={cn(
                      'border text-[10px] uppercase tracking-wide',
                      TIER_BADGE[tier]
                    )}
                  >
                    {tier}
                  </Badge>
                  {selected && (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-primary" aria-hidden="true">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  )}
                </button>
              );
            })}
          </div>
        </PopoverContent>
      </Popover>

      {/* Clear filters */}
      {hasActiveFilters && (
        <Button
          variant="ghost"
          size="sm"
          className="h-8 text-xs text-muted-foreground hover:text-foreground"
          onClick={clearAll}
          data-testid="clear-filters-btn"
        >
          Clear filters
        </Button>
      )}
    </div>
  );
}
