import { createLogger } from '../utils/logger.js';
import type { Position } from '../core/types.js';
import type {
  CircuitBreakerConfig,
  CircuitBreakerState,
  CircuitBreakerEvent,
  PortfolioTier,
} from './types.js';

const logger = createLogger('circuit-breaker');

/**
 * Simplified close action emitted by the circuit breaker.
 */
export interface CircuitBreakerCloseAction {
  readonly positionId: string;
  readonly tier: PortfolioTier;
  readonly reason: string;
}

/**
 * Callback for emitting store events.
 */
export type CircuitBreakerEventEmitter = (event: CircuitBreakerEvent) => void;

/**
 * Callback for resolving a position's tier.
 */
export type PositionTierResolver = (position: Position) => PortfolioTier;

/**
 * Drawdown Circuit Breaker.
 *
 * Automatically halts new positions and optionally closes existing ones
 * when portfolio drawdown exceeds a threshold. Activates within 1 tick cycle.
 *
 * - Peak tracking: stores highest portfolio value ever seen
 * - Hysteresis: activation threshold more negative than reset threshold
 * - Aggressive mode: closes Growth and Degen positions, preserves Safe
 */
export class DrawdownCircuitBreaker {
  private state: CircuitBreakerState;
  private readonly config: CircuitBreakerConfig;
  private readonly eventEmitter?: CircuitBreakerEventEmitter;
  private readonly tierResolver?: PositionTierResolver;

  constructor(
    config: CircuitBreakerConfig,
    eventEmitter?: CircuitBreakerEventEmitter,
    tierResolver?: PositionTierResolver,
  ) {
    this.config = config;
    this.eventEmitter = eventEmitter;
    this.tierResolver = tierResolver;
    this.state = {
      active: false,
      peakPortfolioValueUsd: 0,
      currentDrawdown: 0,
      activatedAt: null,
      lastEvaluatedAt: 0,
    };
  }

  /**
   * Evaluate the circuit breaker against current portfolio value.
   * Activates within 1 tick cycle when threshold is breached.
   */
  evaluate(currentPortfolioValueUsd: number): CircuitBreakerState {
    if (!this.config.enabled) {
      this.state.lastEvaluatedAt = Date.now();
      return { ...this.state };
    }

    // Update peak value (only ratchets upward)
    if (currentPortfolioValueUsd > this.state.peakPortfolioValueUsd) {
      this.state.peakPortfolioValueUsd = currentPortfolioValueUsd;
    }

    // Initialize peak on first call
    if (this.state.peakPortfolioValueUsd === 0) {
      this.state.peakPortfolioValueUsd = currentPortfolioValueUsd;
    }

    // Calculate drawdown
    const drawdown = this.state.peakPortfolioValueUsd > 0
      ? (currentPortfolioValueUsd - this.state.peakPortfolioValueUsd) / this.state.peakPortfolioValueUsd
      : 0;
    this.state.currentDrawdown = drawdown;
    this.state.lastEvaluatedAt = Date.now();

    if (!this.state.active) {
      // Check for activation
      if (drawdown <= this.config.activationThreshold) {
        this.state.active = true;
        this.state.activatedAt = Date.now();
        logger.error(
          {
            drawdown: `${(drawdown * 100).toFixed(2)}%`,
            threshold: `${(this.config.activationThreshold * 100).toFixed(2)}%`,
            peakValue: this.state.peakPortfolioValueUsd,
            currentValue: currentPortfolioValueUsd,
          },
          'Circuit breaker ACTIVATED — halting all new entries',
        );

        this.emitEvent('circuit_breaker_activated', drawdown, currentPortfolioValueUsd);
      }
    } else {
      // Check for deactivation (recovery)
      if (drawdown > this.config.resetThreshold) {
        this.state.active = false;
        this.state.activatedAt = null;
        logger.info(
          {
            drawdown: `${(drawdown * 100).toFixed(2)}%`,
            resetThreshold: `${(this.config.resetThreshold * 100).toFixed(2)}%`,
            peakValue: this.state.peakPortfolioValueUsd,
            currentValue: currentPortfolioValueUsd,
          },
          'Circuit breaker DEACTIVATED — portfolio recovered',
        );

        this.emitEvent('circuit_breaker_deactivated', drawdown, currentPortfolioValueUsd);
      }
    }

    return { ...this.state };
  }

  /**
   * Check if new entries should be rejected.
   */
  shouldRejectEntry(): boolean {
    return this.state.active;
  }

  /**
   * Get the rejection reason with actual drawdown details.
   */
  getRejectionReason(): string {
    return `Circuit breaker active: portfolio drawdown ${(this.state.currentDrawdown * 100).toFixed(2)}% from peak`;
  }

  /**
   * Get close actions for aggressive mode — closes Growth and Degen positions.
   * Safe tier positions are preserved.
   */
  getAggressiveCloseActions(positions: readonly Position[]): CircuitBreakerCloseAction[] {
    if (!this.config.aggressiveMode || !this.state.active) {
      return [];
    }

    const actions: CircuitBreakerCloseAction[] = [];

    for (const position of positions) {
      const tier = this.tierResolver?.(position) ?? 'growth';

      if (tier === 'growth' || tier === 'degen') {
        logger.error(
          {
            positionId: position.id,
            tier,
            pnlUsd: position.pnlUsd,
          },
          'Circuit breaker aggressive deleveraging — closing position',
        );

        actions.push({
          positionId: position.id,
          tier,
          reason: 'Circuit breaker aggressive deleveraging',
        });
      }
    }

    return actions;
  }

  /**
   * Get current state (readonly copy).
   */
  getState(): Readonly<CircuitBreakerState> {
    return { ...this.state };
  }

  /**
   * Reset for test isolation.
   */
  reset(): void {
    this.state = {
      active: false,
      peakPortfolioValueUsd: 0,
      currentDrawdown: 0,
      activatedAt: null,
      lastEvaluatedAt: 0,
    };
  }

  private emitEvent(
    type: CircuitBreakerEvent['type'],
    drawdown: number,
    currentValue: number,
  ): void {
    if (this.eventEmitter) {
      this.eventEmitter({
        type,
        drawdown,
        peakValue: this.state.peakPortfolioValueUsd,
        currentValue,
        timestamp: Date.now(),
      });
    }
  }
}
