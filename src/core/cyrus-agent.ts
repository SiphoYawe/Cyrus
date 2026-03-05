import { RunnableBase } from './runnable-base.js';
import type { ActionQueue } from './action-queue.js';
import type { ExecutorOrchestrator } from '../executors/executor-orchestrator.js';
import type { CyrusConfig } from './config.js';

export interface CyrusAgentDeps {
  readonly config: CyrusConfig;
  readonly actionQueue: ActionQueue;
  readonly executorOrchestrator: ExecutorOrchestrator;
  readonly tickIntervalMs?: number;
}

export class CyrusAgent extends RunnableBase {
  private readonly config: CyrusConfig;
  private readonly actionQueue: ActionQueue;
  private readonly executorOrchestrator: ExecutorOrchestrator;

  constructor(deps: CyrusAgentDeps) {
    super(deps.tickIntervalMs ?? deps.config.tickIntervalMs, 'cyrus-agent');
    this.config = deps.config;
    this.actionQueue = deps.actionQueue;
    this.executorOrchestrator = deps.executorOrchestrator;
  }

  async controlTask(): Promise<void> {
    if (!this.actionQueue.isEmpty()) {
      this.logger.info(
        { queueSize: this.actionQueue.size(), tick: this.tickCount },
        'Processing action queue'
      );
      const results = await this.executorOrchestrator.processQueue(this.actionQueue);
      this.logger.info(
        {
          processed: results.length,
          successes: results.filter((r) => r.success).length,
          failures: results.filter((r) => !r.success).length,
        },
        'Action queue processed'
      );
    } else {
      this.logger.debug({ tick: this.tickCount }, 'No actions in queue');
    }
  }

  async onStop(): Promise<void> {
    this.logger.info(
      { tickCount: this.tickCount, remainingActions: this.actionQueue.size() },
      'Cyrus agent shutting down'
    );
  }

  getConfig(): CyrusConfig {
    return this.config;
  }
}
