// OpenClaw Plugin — Main entry point that registers all Cyrus tools with the OpenClaw gateway

import { createLogger } from '../utils/logger.js';
import type { Store } from '../core/store.js';
import type { CyrusConfig } from '../core/config.js';
import type { PersistenceService } from '../core/persistence.js';
import type {
  OpenClawToolDefinition,
  OpenClawToolResult,
  PendingAction,
  HeartbeatStatus,
} from './types.js';

const logger = createLogger('openclaw-plugin');

const PENDING_ACTION_TTL_MS = 5 * 60 * 1000; // 5 minutes

export interface OpenClawPluginDeps {
  readonly store: Store;
  readonly config: CyrusConfig;
  readonly persistence: PersistenceService;
  readonly agent?: { getTickCount: () => number; isRunning: () => boolean };
}

export class OpenClawPlugin {
  private readonly store: Store;
  private readonly config: CyrusConfig;
  private readonly persistence: PersistenceService;
  private readonly agent?: { getTickCount: () => number; isRunning: () => boolean };
  private readonly tools: Map<string, OpenClawToolDefinition> = new Map();
  private readonly pendingActions: Map<string, PendingAction> = new Map();
  private startedAt: number = Date.now();

  constructor(deps: OpenClawPluginDeps) {
    this.store = deps.store;
    this.config = deps.config;
    this.persistence = deps.persistence;
    this.agent = deps.agent;
  }

  /**
   * Register a tool with the plugin.
   */
  registerTool(tool: OpenClawToolDefinition): void {
    if (this.tools.has(tool.name)) {
      logger.warn({ tool: tool.name }, 'Overwriting existing tool registration');
    }
    this.tools.set(tool.name, tool);
    logger.debug({ tool: tool.name }, 'Tool registered');
  }

  /**
   * Get all registered tool definitions.
   */
  getTools(): OpenClawToolDefinition[] {
    return Array.from(this.tools.values());
  }

  /**
   * Get a tool by name.
   */
  getTool(name: string): OpenClawToolDefinition | undefined {
    return this.tools.get(name);
  }

  /**
   * Invoke a tool by name with parameters.
   */
  async invokeTool(name: string, params: Record<string, unknown>): Promise<OpenClawToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { success: false, message: `Unknown tool: ${name}` };
    }

    // Validate required parameters
    for (const param of tool.parameters) {
      if (param.required && !(param.name in params)) {
        return {
          success: false,
          message: `Missing required parameter: ${param.name}`,
        };
      }
    }

    try {
      const result = await tool.handler(params);
      logger.info({ tool: name, success: result.success }, 'Tool invoked');
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      logger.error({ tool: name, err }, 'Tool invocation failed');
      return { success: false, message };
    }
  }

  /**
   * Store a pending action awaiting user approval.
   */
  addPendingAction(action: PendingAction): void {
    this.pendingActions.set(action.id, action);
    this.pruneExpiredActions();
  }

  /**
   * Get a pending action by ID.
   */
  getPendingAction(id: string): PendingAction | undefined {
    const action = this.pendingActions.get(id);
    if (action && Date.now() > action.expiresAt) {
      this.pendingActions.delete(id);
      return undefined;
    }
    return action;
  }

  /**
   * Remove a pending action (approved or denied).
   */
  removePendingAction(id: string): boolean {
    return this.pendingActions.delete(id);
  }

  /**
   * Get all pending (non-expired) actions.
   */
  getAllPendingActions(): PendingAction[] {
    this.pruneExpiredActions();
    return Array.from(this.pendingActions.values());
  }

  /**
   * Build heartbeat status payload.
   */
  getHeartbeatStatus(): HeartbeatStatus {
    const balances = this.store.getAllBalances();
    const totalPortfolioUsd = balances.reduce((sum, b) => sum + b.usdValue, 0);
    const reports = this.store.getReports({ limit: 1 });
    const lastDecisionAt = reports.length > 0 ? reports[0].timestamp : null;

    return {
      agentRunning: this.agent?.isRunning() ?? false,
      uptime: process.uptime(),
      tickCount: this.agent?.getTickCount() ?? 0,
      activeTransfers: this.store.getActiveTransfers().length,
      openPositions: this.store.getAllPositions().length,
      totalPortfolioUsd,
      lastDecisionAt,
      timestamp: Date.now(),
    };
  }

  /**
   * Get the store reference (for tools).
   */
  getStore(): Store {
    return this.store;
  }

  /**
   * Get the config reference (for tools).
   */
  getConfig(): CyrusConfig {
    return this.config;
  }

  /**
   * Get the persistence reference (for tools).
   */
  getPersistence(): PersistenceService {
    return this.persistence;
  }

  /**
   * Prune expired pending actions.
   */
  private pruneExpiredActions(): void {
    const now = Date.now();
    for (const [id, action] of this.pendingActions) {
      if (now > action.expiresAt) {
        this.pendingActions.delete(id);
      }
    }
  }

  /**
   * Reset for testing.
   */
  reset(): void {
    this.tools.clear();
    this.pendingActions.clear();
    this.startedAt = Date.now();
  }
}
