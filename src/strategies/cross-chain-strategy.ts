import type {
  StrategySignal,
  ExecutionPlan,
  StrategyContext,
  StrategyFilter,
  Position,
} from '../core/types.js';
import { StrategyConfigError } from '../utils/errors.js';

/**
 * Abstract base class for all cross-chain strategies.
 *
 * Subclasses must implement:
 * - `name` — unique strategy identifier
 * - `timeframe` — evaluation interval (e.g. '5m', '1h')
 * - `shouldExecute(ctx)` — return a signal or null
 * - `buildExecution(signal, ctx)` — translate signal into an execution plan
 *
 * Provides default implementations for lifecycle hooks and filter chains.
 * Follows Freqtrade pattern: strategies extend a base class with declarative risk params.
 */
export abstract class CrossChainStrategy {
  // --- Abstract properties (subclass MUST override) ---
  abstract readonly name: string;
  abstract readonly timeframe: string;

  // --- Declarative risk parameters (subclass overrides in class body) ---
  readonly stoploss: number = -0.10;
  readonly minimalRoi: Readonly<Record<number, number>> = { 0: 0.05 };
  readonly trailingStop: boolean = false;
  readonly trailingStopPositive: number | undefined = undefined;
  readonly maxPositions: number = 3;

  // --- Abstract methods (subclass MUST implement) ---

  abstract shouldExecute(context: StrategyContext): StrategySignal | null;

  abstract buildExecution(
    signal: StrategySignal,
    context: StrategyContext,
  ): ExecutionPlan;

  // --- Composable filter chain ---

  /** Override to return filter predicates. All must pass for execution to proceed. */
  filters(): StrategyFilter[] {
    return [];
  }

  /** Evaluate all filters sequentially. Short-circuits on first false. */
  evaluateFilters(context: StrategyContext): boolean {
    const filterList = this.filters();
    for (const filter of filterList) {
      if (!filter(context)) {
        return false;
      }
    }
    return true;
  }

  // --- Lifecycle hooks (default pass-through implementations) ---

  /** Called once when the agent starts. Override for init logic. */
  async onBotStart(): Promise<void> {
    // no-op default
  }

  /** Called at the start of each tick loop. Override for per-tick setup. */
  async onLoopStart(_timestamp: number): Promise<void> {
    // no-op default
  }

  /** Called before submitting a trade. Return false to abort. */
  confirmTradeEntry(_plan: ExecutionPlan): boolean {
    return true;
  }

  /** Called before closing a position. Return false to keep position open. */
  confirmTradeExit(_position: Position, _reason: string): boolean {
    return true;
  }

  /** Override to implement dynamic stoploss. Returns this.stoploss by default. */
  customStoploss(_position: Position, _currentProfit: number): number {
    return this.stoploss;
  }

  // --- Config validation ---
  // Called by StrategyLoader after construction, NOT in the constructor.
  // TypeScript class field initializers run after the parent constructor,
  // so subclass overrides (e.g. `override readonly stoploss = -0.05`)
  // aren't visible during base constructor execution.

  validateConfig(): void {
    if (this.stoploss >= 0 || this.stoploss <= -1.0) {
      throw new StrategyConfigError({
        field: 'stoploss',
        value: this.stoploss,
        message: `stoploss must be between -1.0 (exclusive) and 0 (exclusive), got ${this.stoploss}`,
      });
    }

    if (!Number.isInteger(this.maxPositions) || this.maxPositions < 1) {
      throw new StrategyConfigError({
        field: 'maxPositions',
        value: this.maxPositions,
        message: `maxPositions must be a positive integer, got ${this.maxPositions}`,
      });
    }

    const roiEntries = Object.entries(this.minimalRoi);
    for (const [key, value] of roiEntries) {
      const numKey = Number(key);
      if (isNaN(numKey) || numKey < 0) {
        throw new StrategyConfigError({
          field: 'minimalRoi',
          value: `key=${key}`,
          message: `minimalRoi keys must be non-negative numbers, got ${key}`,
        });
      }
      if (typeof value !== 'number' || value <= 0) {
        throw new StrategyConfigError({
          field: 'minimalRoi',
          value: `${key}=${value}`,
          message: `minimalRoi values must be positive numbers, got ${value} for key ${key}`,
        });
      }
    }
  }
}
