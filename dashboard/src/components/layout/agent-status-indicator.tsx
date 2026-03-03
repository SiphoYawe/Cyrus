'use client';

import { useAgentStore } from '@/stores/agent-store';
import type { AgentStatus } from '@/stores/agent-store';

const STATUS_CONFIG: Record<AgentStatus, { label: string; color: string; pulse: boolean }> = {
  running: { label: 'Monitoring', color: 'bg-positive', pulse: true },
  stopped: { label: 'Paused', color: 'bg-muted-foreground', pulse: false },
  error: { label: 'Error', color: 'bg-negative', pulse: false },
  unknown: { label: 'Offline', color: 'bg-negative', pulse: false },
};

export function AgentStatusIndicator() {
  const status = useAgentStore((s) => s.status);
  const config = STATUS_CONFIG[status];

  return (
    <div className="flex items-center gap-2">
      <span className="relative flex h-2.5 w-2.5">
        {config.pulse && (
          <span
            className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-75 ${config.color}`}
          />
        )}
        <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${config.color}`} />
      </span>
      <span className="text-xs text-muted-foreground">{config.label}</span>
    </div>
  );
}
