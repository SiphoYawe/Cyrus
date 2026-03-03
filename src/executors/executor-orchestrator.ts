import type { ExecutorAction, ActionType } from '../core/action-types.js';
import type { ActionQueue } from '../core/action-queue.js';
import type { ExecutionResult } from '../core/types.js';
import { createLogger } from '../utils/logger.js';

export interface Executor {
  canHandle(action: ExecutorAction): boolean;
  execute(action: ExecutorAction): Promise<ExecutionResult>;
}

const logger = createLogger('executor-orchestrator');

export class ExecutorOrchestrator {
  private readonly registry = new Map<string, Executor>();

  registerExecutor(type: ActionType, executor: Executor): void {
    this.registry.set(type, executor);
    logger.info({ type }, 'Executor registered');
  }

  async processAction(action: ExecutorAction): Promise<ExecutionResult> {
    const executor = this.registry.get(action.type);

    if (!executor) {
      logger.error(
        { actionId: action.id, actionType: action.type },
        'No executor registered for action type, skipping'
      );
      return {
        success: false,
        transferId: null,
        txHash: null,
        error: `No executor registered for action type: ${action.type}`,
        metadata: { actionId: action.id, actionType: action.type },
      };
    }

    if (!executor.canHandle(action)) {
      logger.warn(
        { actionId: action.id, actionType: action.type },
        'Executor cannot handle action, skipping'
      );
      return {
        success: false,
        transferId: null,
        txHash: null,
        error: `Executor cannot handle action: ${action.id}`,
        metadata: { actionId: action.id, actionType: action.type },
      };
    }

    logger.info(
      { actionId: action.id, actionType: action.type, priority: action.priority },
      'Executing action'
    );

    return executor.execute(action);
  }

  async processQueue(queue: ActionQueue): Promise<ExecutionResult[]> {
    const results: ExecutionResult[] = [];

    while (!queue.isEmpty()) {
      const action = queue.dequeue();
      if (action) {
        const result = await this.processAction(action);
        results.push(result);
      }
    }

    return results;
  }
}
