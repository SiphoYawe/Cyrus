'use client';

import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { ActivityType } from '@/types/activity';

export type ActivityTab = 'all' | ActivityType;

interface TabCount {
  all: number;
  trade: number;
  bridge: number;
  deposit: number;
}

interface ActivityTabsProps {
  activeTab: ActivityTab;
  onTabChange: (tab: ActivityTab) => void;
  counts: TabCount;
  className?: string;
}

const TAB_DEFS: { value: ActivityTab; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'trade', label: 'Trades' },
  { value: 'bridge', label: 'Bridges' },
  { value: 'deposit', label: 'Deposits' },
];

export function ActivityTabs({
  activeTab,
  onTabChange,
  counts,
  className,
}: ActivityTabsProps) {
  return (
    <Tabs
      value={activeTab}
      onValueChange={(v) => onTabChange(v as ActivityTab)}
      className={className}
      data-testid="activity-tabs"
    >
      <TabsList className="h-9">
        {TAB_DEFS.map(({ value, label }) => {
          const count = counts[value];
          return (
            <TabsTrigger
              key={value}
              value={value}
              className="gap-1.5"
              data-testid={`tab-${value}`}
            >
              {label}
              {count > 0 && (
                <Badge
                  variant="secondary"
                  className={cn(
                    'h-4 min-w-4 px-1 text-[10px] tabular-nums',
                    activeTab === value
                      ? 'bg-primary/20 text-primary'
                      : 'bg-muted text-muted-foreground'
                  )}
                  data-testid={`tab-count-${value}`}
                >
                  {count > 999 ? '999+' : count}
                </Badge>
              )}
            </TabsTrigger>
          );
        })}
      </TabsList>
    </Tabs>
  );
}
