import { RunnableBase } from './runnable-base.js';
import type { ActionQueue } from './action-queue.js';
import type { CrossChainStrategy } from '../strategies/cross-chain-strategy.js';
import type { MarketDataService } from '../data/market-data-service.js';

export interface StrategyRunnerDeps {
  readonly strategies: CrossChainStrategy[];
  readonly marketDataService: MarketDataService;
  readonly actionQueue: ActionQueue;
  readonly tickIntervalMs: number;
}

export class StrategyRunner extends RunnableBase {
  private readonly strategies: CrossChainStrategy[];
  private readonly marketDataService: MarketDataService;
  private readonly actionQueue: ActionQueue;
  private actionsEnqueued = 0;
  private strategiesEvaluated = 0;

  constructor(deps: StrategyRunnerDeps) {
    super(deps.tickIntervalMs, 'strategy-runner');
    this.strategies = deps.strategies;
    this.marketDataService = deps.marketDataService;
    this.actionQueue = deps.actionQueue;
  }

  async controlTask(): Promise<void> {
    if (!this.marketDataService.ready) {
      this.logger.debug('Market data service not ready, skipping tick');
      return;
    }

    const context = await this.marketDataService.buildContext();

    for (const strategy of this.strategies) {
      try {
        await strategy.onLoopStart(context.timestamp);

        if (!strategy.evaluateFilters(context)) {
          this.logger.debug({ strategy: strategy.name }, 'Filters blocked execution');
          continue;
        }

        const signal = strategy.shouldExecute(context);
        if (!signal || signal.strength < 0.5) {
          continue;
        }

        const plan = strategy.buildExecution(signal, context);

        if (!strategy.confirmTradeEntry(plan)) {
          this.logger.info({ strategy: strategy.name }, 'Trade entry rejected by strategy');
          continue;
        }

        for (const action of plan.actions) {
          this.actionQueue.enqueue(action);
          this.actionsEnqueued++;
        }

        this.logger.info(
          {
            strategy: strategy.name,
            signal: signal.direction,
            strength: signal.strength,
            actions: plan.actions.length,
          },
          'Strategy produced actions'
        );
        this.strategiesEvaluated++;
      } catch (error) {
        this.logger.error(
          { strategy: strategy.name, error },
          'Strategy evaluation failed, continuing with next'
        );
      }
    }
  }

  async onStop(): Promise<void> {
    this.logger.info(
      {
        totalTicks: this.tickCount,
        actionsEnqueued: this.actionsEnqueued,
        strategiesEvaluated: this.strategiesEvaluated,
      },
      'Strategy runner stopped'
    );
  }
}
