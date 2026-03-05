// OpenClaw gateway integration types

/**
 * OpenClaw tool definition — describes a tool that OpenClaw can invoke.
 */
export interface OpenClawToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: ReadonlyArray<OpenClawToolParameter>;
  readonly handler: (params: Record<string, unknown>) => Promise<OpenClawToolResult>;
}

/**
 * OpenClaw tool parameter schema.
 */
export interface OpenClawToolParameter {
  readonly name: string;
  readonly type: 'string' | 'number' | 'boolean';
  readonly description: string;
  readonly required: boolean;
  readonly default?: string | number | boolean;
}

/**
 * Result from an OpenClaw tool invocation.
 */
export interface OpenClawToolResult {
  readonly success: boolean;
  readonly message: string;
  readonly data?: unknown;
}

/**
 * OpenClaw plugin configuration — channels, heartbeat, cron settings.
 */
export interface OpenClawPluginConfig {
  readonly name: string;
  readonly version: string;
  readonly channels: readonly string[];
  readonly heartbeat: {
    readonly enabled: boolean;
    readonly intervalMs: number;
  };
  readonly cron: ReadonlyArray<{
    readonly schedule: string;
    readonly tool: string;
    readonly params: Record<string, unknown>;
  }>;
}

/**
 * Pending action awaiting user approval.
 */
export interface PendingAction {
  readonly id: string;
  readonly tool: string;
  readonly params: Record<string, unknown>;
  readonly preview: ActionPreview;
  readonly createdAt: number;
  readonly expiresAt: number;
}

/**
 * Preview of a trade action for user confirmation.
 */
export interface ActionPreview {
  readonly action: string;
  readonly fromChain: number;
  readonly toChain: number;
  readonly fromToken: string;
  readonly toToken: string;
  readonly fromAmount: string;
  readonly estimatedOutput: string;
  readonly estimatedGasUsd: number;
  readonly estimatedBridgeFeeUsd: number;
  readonly estimatedSlippage: number;
  readonly route: string;
}

/**
 * Heartbeat status payload.
 */
export interface HeartbeatStatus {
  readonly agentRunning: boolean;
  readonly uptime: number;
  readonly tickCount: number;
  readonly activeTransfers: number;
  readonly openPositions: number;
  readonly totalPortfolioUsd: number;
  readonly lastDecisionAt: number | null;
  readonly timestamp: number;
}
