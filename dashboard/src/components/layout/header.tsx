'use client';

import { AgentStatusIndicator } from './agent-status-indicator';

export function Header() {
  return (
    <header className="flex h-14 items-center justify-between border-b border-border px-6">
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-semibold tracking-tight">CYRUS</h1>
      </div>
      <div className="flex items-center gap-4">
        <AgentStatusIndicator />
      </div>
    </header>
  );
}
