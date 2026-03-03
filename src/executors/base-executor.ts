import type { ExecutorAction } from '../core/action-types.js';
import type { ExecutionResult, TransferId } from '../core/types.js';
import type { Executor } from './executor-orchestrator.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('base-executor');

export const EXECUTOR_STAGES = {
  TRIGGER: 'trigger',
  OPEN: 'open',
  MANAGE: 'manage',
  CLOSE: 'close',
  FAILED: 'failed',
} as const;

export type ExecutorStage = (typeof EXECUTOR_STAGES)[keyof typeof EXECUTOR_STAGES];

export interface StageResult {
  readonly success: boolean;
  readonly error?: string;
  readonly data?: Record<string, unknown>;
}

export abstract class BaseExecutor implements Executor {
  private _currentStage: ExecutorStage = EXECUTOR_STAGES.TRIGGER;

  get currentStage(): ExecutorStage {
    return this._currentStage;
  }

  abstract canHandle(action: ExecutorAction): boolean;

  protected abstract trigger(action: ExecutorAction): Promise<StageResult>;
  protected abstract open(action: ExecutorAction): Promise<StageResult>;
  protected abstract manage(action: ExecutorAction): Promise<StageResult>;
  protected abstract close(action: ExecutorAction): Promise<StageResult>;

  async execute(action: ExecutorAction): Promise<ExecutionResult> {
    return this.run(action);
  }

  protected async run(action: ExecutorAction): Promise<ExecutionResult> {
    const startTime = Date.now();
    const executorId = `${action.type}-${action.id}`;

    try {
      // Trigger stage
      this._currentStage = EXECUTOR_STAGES.TRIGGER;
      logger.debug({ executorId, stage: 'trigger' }, 'Entering trigger stage');
      const triggerResult = await this.trigger(action);
      if (!triggerResult.success) {
        this._currentStage = EXECUTOR_STAGES.FAILED;
        return this.failureResult(action, triggerResult.error ?? 'Trigger stage failed', startTime);
      }

      // Open stage
      this._currentStage = EXECUTOR_STAGES.OPEN;
      logger.debug({ executorId, stage: 'open' }, 'Entering open stage');
      const openResult = await this.open(action);
      if (!openResult.success) {
        this._currentStage = EXECUTOR_STAGES.FAILED;
        return this.failureResult(action, openResult.error ?? 'Open stage failed', startTime);
      }

      // Manage stage
      this._currentStage = EXECUTOR_STAGES.MANAGE;
      logger.debug({ executorId, stage: 'manage' }, 'Entering manage stage');
      const manageResult = await this.manage(action);
      if (!manageResult.success) {
        this._currentStage = EXECUTOR_STAGES.FAILED;
        return this.failureResult(action, manageResult.error ?? 'Manage stage failed', startTime);
      }

      // Close stage
      this._currentStage = EXECUTOR_STAGES.CLOSE;
      logger.debug({ executorId, stage: 'close' }, 'Entering close stage');
      const closeResult = await this.close(action);
      if (!closeResult.success) {
        this._currentStage = EXECUTOR_STAGES.FAILED;
        return this.failureResult(action, closeResult.error ?? 'Close stage failed', startTime);
      }

      const durationMs = Date.now() - startTime;
      logger.info({ executorId, durationMs }, 'Executor completed successfully');

      return {
        success: true,
        transferId: (closeResult.data?.transferId as TransferId) ?? null,
        txHash: (closeResult.data?.txHash as string) ?? null,
        error: null,
        metadata: {
          actionId: action.id,
          durationMs,
          ...closeResult.data,
        },
      };
    } catch (err) {
      this._currentStage = EXECUTOR_STAGES.FAILED;
      const message = err instanceof Error ? err.message : 'Unknown executor error';
      logger.error({ executorId, error: message, stage: this._currentStage }, 'Executor failed');
      return this.failureResult(action, message, startTime);
    }
  }

  private failureResult(
    action: ExecutorAction,
    error: string,
    startTime: number,
  ): ExecutionResult {
    return {
      success: false,
      transferId: null,
      txHash: null,
      error,
      metadata: {
        actionId: action.id,
        durationMs: Date.now() - startTime,
        failedStage: this._currentStage,
      },
    };
  }
}
