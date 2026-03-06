import { RunnableBase } from './runnable-base.js';
import type { ActionQueue } from './action-queue.js';
import type { CrossChainStrategy } from '../strategies/cross-chain-strategy.js';
import type { MarketDataService } from '../data/market-data-service.js';
import type { BalanceReconciler } from '../controllers/balance-reconciler.js';
import type { SignalAggregator } from '../data/signal-aggregator.js';
import type { AIOrchestrator } from '../ai/ai-orchestrator.js';
import type { StrategySelector, StrategyMetadata } from '../ai/strategy-selector.js';
import type { DecisionReporter } from '../ai/decision-reporter.js';
import type { DrawdownCircuitBreaker } from '../risk/circuit-breaker.js';
import type { PortfolioTierEngine } from '../risk/portfolio-tier-engine.js';
import type { MarketRegime, StrategyTier } from '../ai/types.js';
import { toTierConfigs } from '../risk/risk-dial.js';
import type { RiskDialTierAllocation, PortfolioTier } from '../risk/types.js';
import type { OnChainIndexer } from '../data/on-chain-indexer.js';
import type { CandleAggregator } from '../data/candle-aggregator.js';
import { StrategyDataBridge } from './strategy-data-bridge.js';
import { YieldHunter } from '../strategies/builtin/yield-hunter.js';
import { LiquidStakingStrategy } from '../strategies/builtin/liquid-staking.js';

const YIELD_REFRESH_INTERVAL_MS = 5 * 60_000; // 5 minutes
const REGIME_CLASSIFICATION_INTERVAL = 10; // classify every N ticks

// Default strategy-to-tier mapping for known built-in strategies
const DEFAULT_STRATEGY_TIERS: Record<string, StrategyTier> = {
  YieldHunter: 'yield',
  LiquidStakingStrategy: 'yield',
  CrossChainArbStrategy: 'growth',
  HyperliquidPerpsStrategy: 'degen',
  StatArbStrategy: 'growth',
  MemeTraderStrategy: 'degen',
  PearPairTrader: 'growth',
  MarketMakerStrategy: 'safe',
  BollingerBounce: 'growth',
  MacdCrossover: 'growth',
  RsiMeanReversion: 'safe',
};

export interface StrategyRunnerDeps {
  readonly strategies: CrossChainStrategy[];
  readonly marketDataService: MarketDataService;
  readonly actionQueue: ActionQueue;
  readonly tickIntervalMs: number;
  readonly balanceReconciler?: BalanceReconciler;
  readonly signalAggregator?: SignalAggregator;
  readonly aiOrchestrator?: AIOrchestrator;
  readonly strategySelector?: StrategySelector;
  readonly decisionReporter?: DecisionReporter;
  readonly circuitBreaker?: DrawdownCircuitBreaker;
  readonly portfolioTierEngine?: PortfolioTierEngine;
  readonly onChainIndexer?: OnChainIndexer;
  readonly candleAggregator?: CandleAggregator;
}

export class StrategyRunner extends RunnableBase {
  private readonly strategies: CrossChainStrategy[];
  private readonly marketDataService: MarketDataService;
  private readonly actionQueue: ActionQueue;
  private readonly balanceReconciler: BalanceReconciler | null;
  private readonly signalAggregator: SignalAggregator | null;
  private readonly aiOrchestrator: AIOrchestrator | null;
  private readonly strategySelector: StrategySelector | null;
  private readonly decisionReporter: DecisionReporter | null;
  private readonly circuitBreaker: DrawdownCircuitBreaker | null;
  private readonly portfolioTierEngine: PortfolioTierEngine | null;
  private readonly dataBridge: StrategyDataBridge;
  private actionsEnqueued = 0;
  private strategiesEvaluated = 0;
  private lastYieldRefresh = 0;
  private currentRegime: MarketRegime = 'crab';
  private deactivatedStrategies: Set<string> = new Set();

  constructor(deps: StrategyRunnerDeps) {
    super(deps.tickIntervalMs, 'strategy-runner');
    this.strategies = deps.strategies;
    this.marketDataService = deps.marketDataService;
    this.actionQueue = deps.actionQueue;
    this.balanceReconciler = deps.balanceReconciler ?? null;
    this.signalAggregator = deps.signalAggregator ?? null;
    this.aiOrchestrator = deps.aiOrchestrator ?? null;
    this.strategySelector = deps.strategySelector ?? null;
    this.decisionReporter = deps.decisionReporter ?? null;
    this.circuitBreaker = deps.circuitBreaker ?? null;
    this.portfolioTierEngine = deps.portfolioTierEngine ?? null;
    this.dataBridge = new StrategyDataBridge({
      strategies: deps.strategies,
      marketDataService: deps.marketDataService,
      onChainIndexer: deps.onChainIndexer,
      signalAggregator: deps.signalAggregator,
      candleAggregator: deps.candleAggregator,
    });
  }

  async controlTask(): Promise<void> {
    if (!this.marketDataService.ready) {
      this.logger.debug('Market data service not ready, skipping tick');
      return;
    }

    // Balance reconciliation (runs at its own interval within the tick)
    if (this.balanceReconciler) {
      try {
        const report = await this.balanceReconciler.reconcile();
        if (report && report.discrepancies.length > 0) {
          this.logger.info(
            { discrepancies: report.discrepancies.length, largest: report.largestDiscrepancyPct },
            'Balance discrepancies detected and corrected',
          );
        }
      } catch (err) {
        this.logger.warn({ error: err }, 'Balance reconciliation failed (non-fatal)');
      }
    }

    // Regime classification (throttled to every N ticks to avoid excessive API calls)
    await this.classifyRegimeIfNeeded();

    // Circuit breaker check — block ALL new entries on drawdown breach
    if (this.circuitBreaker && this.portfolioTierEngine) {
      const { totalValueUsd } = this.portfolioTierEngine.calculateTotalPortfolioValue();
      this.circuitBreaker.evaluate(totalValueUsd);
      if (this.circuitBreaker.shouldRejectEntry()) {
        this.logger.warn(
          { reason: this.circuitBreaker.getRejectionReason() },
          'Circuit breaker ACTIVE — blocking all new entries',
        );
        return;
      }
    }

    // Feed strategy-specific data from data pipeline (yield, funding rates, signals, order books)
    await this.dataBridge.feedStrategies();
    this.logger.debug({ dataStatus: this.dataBridge.getDataStatus() }, 'Data bridge feed complete');

    // Periodic yield data refresh for yield-dependent strategies
    await this.refreshYieldDataIfNeeded();

    const baseContext = await this.marketDataService.buildContext();

    // Enrich context with composite signal from SignalAggregator (if available)
    let context = baseContext;
    if (this.signalAggregator) {
      // Use a generic "portfolio" token key for the composite signal snapshot
      const compositeSignal = this.signalAggregator.getScoreWithTrend('portfolio') ?? undefined;
      if (compositeSignal) {
        context = Object.freeze({ ...baseContext, compositeSignal });
      }
    }

    for (const strategy of this.strategies) {
      // Skip strategies deactivated by regime-based selection
      if (this.deactivatedStrategies.has(strategy.name)) {
        this.logger.debug(
          { strategy: strategy.name, regime: this.currentRegime },
          'Strategy deactivated for current regime, skipping',
        );
        continue;
      }

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

        // Tier capacity check — block new entries if strategy's tier is overweight
        if (this.portfolioTierEngine && signal.direction !== 'exit') {
          const tier = (DEFAULT_STRATEGY_TIERS[strategy.name] ?? 'growth') as PortfolioTier;
          const tierConfigs = toTierConfigs({ safe: 0.5, growth: 0.3, degen: 0.15, reserve: 0.05 });
          const snapshot = this.portfolioTierEngine.evaluate(tierConfigs);
          const tierAlloc = snapshot.tiers.find((t) => t.tier === tier);
          if (tierAlloc && tierAlloc.status === 'overweight') {
            this.logger.info(
              { strategy: strategy.name, tier, deviation: tierAlloc.deviation },
              'Strategy blocked: tier overweight',
            );
            continue;
          }
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

        // Generate decision report (fire-and-forget, don't delay the loop)
        if (this.decisionReporter) {
          this.generateDecisionReport(strategy.name, signal, plan).catch((err) => {
            this.logger.debug({ error: err }, 'Decision report generation failed (non-fatal)');
          });
        }
      } catch (error) {
        this.logger.error(
          { strategy: strategy.name, error },
          'Strategy evaluation failed, continuing with next'
        );
      }
    }
  }

  /**
   * Classify market regime via AIOrchestrator (throttled).
   * Updates regime-based strategy activation/deactivation.
   */
  private async classifyRegimeIfNeeded(): Promise<void> {
    if (!this.aiOrchestrator || !this.strategySelector) return;
    if (this.tickCount % REGIME_CLASSIFICATION_INTERVAL !== 0) return;

    try {
      const snapshot = await this.marketDataService.getMarketSnapshot();
      const classification = await this.aiOrchestrator.classifyMarketRegime(snapshot);
      this.currentRegime = classification.regime;

      // Build strategy metadata for selector
      const metadata: StrategyMetadata[] = this.strategies.map((s) => ({
        name: s.name,
        tier: DEFAULT_STRATEGY_TIERS[s.name] ?? 'growth',
        isActive: !this.deactivatedStrategies.has(s.name),
      }));

      const selection = this.strategySelector.selectStrategies(classification.regime, metadata);

      // Apply activation/deactivation
      for (const name of selection.deactivate) {
        this.deactivatedStrategies.add(name);
      }
      for (const name of selection.activate) {
        this.deactivatedStrategies.delete(name);
      }

      if (selection.activate.length > 0 || selection.deactivate.length > 0) {
        this.logger.info(
          {
            regime: classification.regime,
            confidence: classification.confidence,
            activated: selection.activate,
            deactivated: selection.deactivate,
          },
          'Regime-based strategy selection updated',
        );
      }
    } catch (err) {
      this.logger.warn({ error: err }, 'Regime classification failed (non-fatal), using last known regime');
    }
  }

  /**
   * Generate a decision report for a strategy action (fire-and-forget).
   */
  private async generateDecisionReport(
    strategyName: string,
    signal: { direction: string; strength: number },
    plan: { actions: readonly unknown[] },
  ): Promise<void> {
    if (!this.decisionReporter) return;

    const context = {
      regime: this.currentRegime,
      actionType: signal.direction,
      fromChain: 0,
      toChain: 0,
      tokenSymbol: 'UNKNOWN',
      amountUsd: 0,
      gasCostUsd: 0,
      bridgeFeeUsd: 0,
      slippage: 0.005,
    };

    await this.decisionReporter.generateReport(strategyName, context);
  }

  private async refreshYieldDataIfNeeded(): Promise<void> {
    const now = Date.now();
    if (now - this.lastYieldRefresh < YIELD_REFRESH_INTERVAL_MS) return;

    const hasYieldStrategies = this.strategies.some(
      (s) => s instanceof YieldHunter || s instanceof LiquidStakingStrategy,
    );
    if (!hasYieldStrategies) return;

    try {
      const [yields, stakingRates] = await Promise.all([
        this.marketDataService.fetchYieldOpportunities(),
        this.marketDataService.fetchStakingRates(),
      ]);

      for (const strategy of this.strategies) {
        if (strategy instanceof YieldHunter) {
          strategy.setYieldData(yields);
        }
        if (strategy instanceof LiquidStakingStrategy) {
          strategy.setStakingRates(stakingRates);
        }
      }

      this.lastYieldRefresh = now;
      this.logger.debug({ yields: yields.length, stakingRates: stakingRates.length }, 'Yield data refreshed');
    } catch (err) {
      this.logger.warn({ error: err }, 'Yield data refresh failed (non-fatal)');
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
