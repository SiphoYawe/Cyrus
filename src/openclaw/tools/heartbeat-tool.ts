// OpenClaw Heartbeat Tool — Returns agent health and operational status

import type { OpenClawPlugin } from '../plugin.js';
import type { OpenClawToolDefinition, OpenClawToolResult } from '../types.js';

function formatUptime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (hours > 0) return `${hours}h ${minutes}m ${secs}s`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

export function createHeartbeatTool(plugin: OpenClawPlugin): OpenClawToolDefinition {
  return {
    name: 'heartbeat',
    description: 'Check agent health status, uptime, active transfers, and portfolio value',
    parameters: [],
    handler: async (): Promise<OpenClawToolResult> => {
      const status = plugin.getHeartbeatStatus();

      const statusEmoji = status.agentRunning ? 'running' : 'stopped';
      const uptimeStr = formatUptime(status.uptime);

      return {
        success: true,
        message: `Agent: ${statusEmoji} | Uptime: ${uptimeStr} | Ticks: ${status.tickCount} | Portfolio: $${status.totalPortfolioUsd.toFixed(2)} | Transfers: ${status.activeTransfers} | Positions: ${status.openPositions}`,
        data: status,
      };
    },
  };
}
