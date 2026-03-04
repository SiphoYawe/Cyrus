// StrategyGenerator — AI-driven strategy evolution engine
// Generates, validates, backtests, and promotes strategy variants using Claude API

import { randomUUID } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { RunnableBase } from '../../core/runnable-base.js';
import { Store } from '../../core/store.js';
import type { BacktestEngine } from '../../backtest/backtest-engine.js';
import type { PerformanceAnalyzer } from '../../backtest/performance-analyzer.js';
import { VariantValidator } from './variant-validator.js';
import { Tournament } from './tournament.js';
import { PaperTrader } from './paper-trader.js';
import type {
  GeneratedVariant,
  TournamentResult,
  PromotionCriteria,
  PaperTradeRecord,
  PromotionReport,
  GenerationConfig,
  EvolutionCycleRecord,
} from './types.js';
import {
  DEFAULT_GENERATION_CONFIG,
  DEFAULT_PROMOTION_CRITERIA,
  computePaperTradingMetrics,
} from './types.js';
import type { BacktestConfig, PerformanceMetrics } from '../../backtest/types.js';

const CLAUDE_MODEL = 'claude-sonnet-4-20250514';
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 1000;

/**
 * System prompt instructing Claude to generate valid strategy variants.
 */
const SYSTEM_PROMPT = `You are an expert TypeScript developer specializing in cross-chain DeFi trading strategies.

Your task: Generate strategy variant code that extends CrossChainStrategy.

STRICT REQUIREMENTS:
- The class MUST extend CrossChainStrategy
- Use TypeScript strict mode
- Use bigint for token amounts, number for USD prices
- Named exports ONLY (no default exports)
- No enums — use string literal unions
- Maintain the strategy interface contract: shouldExecute(ctx), buildExecution(signal, ctx), filters(), risk params
- Override risk parameters: stoploss (negative, absolute value >= 0.005), maxPositions (<= 10), minimalRoi (positive values), trailingStop (boolean)

FORBIDDEN (will be rejected):
- No eval(), new Function(), or dynamic code execution
- No walletClient, privateKey, or direct wallet access
- No fs, require, fetch, or network/filesystem access
- No process.env access
- No hardcoded 0x addresses longer than 10 hex characters
- No dynamic import()
- No child_process, execSync, spawn, execFile, or shell execution
- No __proto__ or constructor["prototype"] prototype pollution
- No setTimeout or setInterval

OUTPUT FORMAT:
For each variant, output a markdown code block with the TypeScript code, followed by a line starting with "MUTATION:" describing the change.

Example:
\`\`\`typescript
export class VariantA extends CrossChainStrategy {
  // ...implementation
}
\`\`\`
MUTATION: Increased stoploss threshold and added momentum filter

Generate meaningful variations: different indicator combinations, adjusted thresholds, modified risk parameters, new filter logic.`;

/**
 * StrategyGenerator extends RunnableBase with a weekly tick interval.
 * Each tick runs a full evolution cycle: generate -> validate -> backtest -> tournament -> paper-trade -> promote.
 */
export class StrategyGenerator extends RunnableBase {
  private readonly anthropic: Anthropic;
  private readonly config: GenerationConfig;
  private readonly validator: VariantValidator;
  private readonly tournament: Tournament;
  private readonly backtestEngine: BacktestEngine | null;
  private readonly performanceAnalyzer: PerformanceAnalyzer | null;

  private readonly activePaperTraders: Map<string, PaperTrader> = new Map();
  private readonly variants: Map<string, GeneratedVariant> = new Map();
  private readonly evolutionHistory: EvolutionCycleRecord[] = [];
  private generationCount = 0;

  constructor(
    anthropicApiKey: string,
    generationConfig: Partial<GenerationConfig> = {},
    backtestEngine: BacktestEngine | null = null,
    performanceAnalyzer: PerformanceAnalyzer | null = null,
  ) {
    const config = { ...DEFAULT_GENERATION_CONFIG, ...generationConfig };
    super(config.scheduleIntervalMs, 'strategy-generator');
    this.anthropic = new Anthropic({ apiKey: anthropicApiKey });
    this.config = config;
    this.validator = new VariantValidator();
    this.tournament = new Tournament();
    this.backtestEngine = backtestEngine;
    this.performanceAnalyzer = performanceAnalyzer;
  }

  /**
   * Weekly control task — runs the full evolution cycle.
   */
  async controlTask(): Promise<void> {
    await this.runEvolutionCycle();
  }

  async onStop(): Promise<void> {
    // Stop all active paper traders
    for (const [id, trader] of this.activePaperTraders) {
      trader.stop();
      this.logger.info({ variantId: id }, 'Stopped paper trader on generator shutdown');
    }
  }

  /**
   * Generate strategy variants using Claude API.
   *
   * @param baseStrategySource - Source code of the base strategy to mutate
   * @param baseStrategyName - Name of the base strategy
   * @param marketPatterns - Summary of recent market patterns
   * @param backtestPerformance - Summary of base strategy's backtest performance
   * @param count - Number of variants to generate
   * @returns Array of GeneratedVariant objects
   */
  async generateVariants(
    baseStrategySource: string,
    baseStrategyName: string,
    marketPatterns: string,
    backtestPerformance: string,
    count: number,
  ): Promise<GeneratedVariant[]> {
    const userMessage = `Generate ${count} strategy variants based on this base strategy:

BASE STRATEGY NAME: ${baseStrategyName}

BASE STRATEGY SOURCE:
\`\`\`typescript
${baseStrategySource}
\`\`\`

RECENT MARKET PATTERNS:
${marketPatterns}

BASE STRATEGY BACKTEST PERFORMANCE:
${backtestPerformance}

Generate ${count} meaningfully different variants. Each should have a distinct approach.`;

    let responseText: string | null = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const response = await this.anthropic.messages.create({
          model: CLAUDE_MODEL,
          max_tokens: 4096,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: userMessage }],
        });

        // Extract text from response content blocks
        responseText = response.content
          .filter((block): block is Anthropic.TextBlock => block.type === 'text')
          .map((block) => block.text)
          .join('\n');

        break;
      } catch (error: unknown) {
        const statusCode = (error as { status?: number }).status;
        if (statusCode === 429 || statusCode === 500 || statusCode === 529) {
          const backoff = BASE_BACKOFF_MS * Math.pow(2, attempt);
          this.logger.warn(
            { attempt: attempt + 1, backoffMs: backoff, statusCode },
            'Claude API error, retrying',
          );
          await new Promise((resolve) => setTimeout(resolve, backoff));
          continue;
        }
        throw error;
      }
    }

    if (responseText === null) {
      this.logger.error('All Claude API retries exhausted');
      return [];
    }

    return this.parseVariantsFromResponse(responseText, baseStrategyName);
  }

  /**
   * Parse Claude response to extract variant code blocks and mutation descriptions.
   */
  private parseVariantsFromResponse(
    responseText: string,
    parentStrategy: string,
  ): GeneratedVariant[] {
    const variants: GeneratedVariant[] = [];

    // Match code blocks followed by MUTATION descriptions
    const codeBlockRegex = /```(?:typescript|ts)?\s*\n([\s\S]*?)```/g;
    const mutationRegex = /MUTATION:\s*(.+)/g;

    const codeBlocks: string[] = [];
    let match: RegExpExecArray | null;

    while ((match = codeBlockRegex.exec(responseText)) !== null) {
      codeBlocks.push(match[1].trim());
    }

    const mutations: string[] = [];
    while ((match = mutationRegex.exec(responseText)) !== null) {
      mutations.push(match[1].trim());
    }

    for (let i = 0; i < codeBlocks.length; i++) {
      const variant: GeneratedVariant = {
        id: randomUUID(),
        parentStrategy,
        sourceCode: codeBlocks[i],
        mutationDescription: mutations[i] ?? `Variant ${i + 1}`,
        generatedAt: Date.now(),
        status: 'generated',
      };
      variants.push(variant);
    }

    this.logger.info(
      { count: variants.length, parentStrategy },
      'Parsed variants from Claude response',
    );

    return variants;
  }

  /**
   * Run backtest pipeline for validated variants.
   * Returns a map of variantId -> TournamentResult with metrics.
   */
  async runBacktestPipeline(
    variants: GeneratedVariant[],
  ): Promise<Map<string, TournamentResult>> {
    const results = new Map<string, TournamentResult>();

    for (const variant of variants) {
      variant.status = 'backtesting';

      try {
        // Reset store between backtests for isolation
        Store.getInstance().reset();

        // Run backtest if engine is available
        let metrics: PerformanceMetrics | null = null;

        if (this.backtestEngine && this.performanceAnalyzer) {
          const backtestResult = await this.backtestEngine.run();
          metrics = this.performanceAnalyzer.analyze(backtestResult);
        }

        const tournamentResult: TournamentResult = {
          variantId: variant.id,
          rank: 0,
          sharpeRatio: metrics?.sharpeRatio ?? 0,
          maxDrawdown: metrics?.maxDrawdown ?? 0,
          totalReturn: metrics?.totalReturn ?? 0,
          winRate: metrics?.winRate ?? 0,
          profitFactor: metrics?.profitFactor ?? 0,
          eliminated: false,
          eliminationReason: null,
          promotedToPaperTrading: false,
        };

        results.set(variant.id, tournamentResult);
        variant.status = 'backtest-complete';

        this.logger.info(
          {
            variantId: variant.id,
            sharpe: tournamentResult.sharpeRatio.toFixed(2),
            maxDrawdown: (tournamentResult.maxDrawdown * 100).toFixed(1) + '%',
          },
          'Variant backtest complete',
        );
      } catch (error) {
        this.logger.error(
          { error, variantId: variant.id },
          'Variant backtest failed — marking as eliminated',
        );

        const failedResult: TournamentResult = {
          variantId: variant.id,
          rank: 0,
          sharpeRatio: 0,
          maxDrawdown: 1,
          totalReturn: -1,
          winRate: 0,
          profitFactor: 0,
          eliminated: true,
          eliminationReason: 'backtest-runtime-error',
          promotedToPaperTrading: false,
        };

        results.set(variant.id, failedResult);
        variant.status = 'eliminated';
      }
    }

    return results;
  }

  /**
   * Evaluate a variant for promotion from paper-trading to live.
   */
  evaluatePromotion(
    variantId: string,
    paperMetrics: PaperTradeRecord[],
    criteria: PromotionCriteria = DEFAULT_PROMOTION_CRITERIA,
  ): PromotionReport {
    const variant = this.variants.get(variantId);
    const parentStrategy = variant?.parentStrategy ?? 'unknown';

    const metrics = computePaperTradingMetrics(paperMetrics);

    // Check promotion criteria
    const sharpePasses = metrics.sharpe > criteria.minSharpe;
    const pnlPasses = !criteria.requirePositivePnl || metrics.totalPnl > 0;
    const shouldPromote = sharpePasses && pnlPasses;

    // Build rejection reasons if applicable
    const reasons: string[] = [];
    if (!sharpePasses) {
      reasons.push(`Paper-trading Sharpe ${metrics.sharpe.toFixed(2)} <= minimum ${criteria.minSharpe}`);
    }
    if (!pnlPasses) {
      reasons.push(`Cumulative P&L ${metrics.totalPnl.toFixed(4)} is not positive`);
    }

    const promotionDecision = shouldPromote ? 'promoted' : 'rejected';
    const reason = shouldPromote
      ? `Variant passed all promotion criteria: Sharpe ${metrics.sharpe.toFixed(2)} > ${criteria.minSharpe}, positive P&L ${metrics.totalPnl.toFixed(4)}`
      : `Promotion rejected: ${reasons.join('; ')}`;

    if (variant) {
      variant.status = shouldPromote ? 'promoted' : 'eliminated';
    }

    const allocatedPercent = shouldPromote ? criteria.initialAllocationPercent : 0;

    // Build a placeholder backtestMetrics for the report
    const backtestMetrics: TournamentResult = {
      variantId,
      rank: 0,
      sharpeRatio: 0,
      maxDrawdown: 0,
      totalReturn: 0,
      winRate: 0,
      profitFactor: 0,
      eliminated: false,
      eliminationReason: null,
      promotedToPaperTrading: true,
    };

    const report: PromotionReport = {
      variantId,
      parentStrategy,
      backtestMetrics,
      paperTradingMetrics: metrics,
      promotionDecision,
      reason,
      allocatedPercent,
    };

    this.logger.info(
      {
        variantId,
        decision: promotionDecision,
        sharpe: metrics.sharpe.toFixed(2),
        totalPnl: metrics.totalPnl.toFixed(4),
        allocatedPercent,
      },
      `Promotion decision: ${promotionDecision}`,
    );

    return report;
  }

  /**
   * Orchestrate the full evolution cycle:
   * generate -> validate -> backtest -> tournament -> paper-trade queue -> promotion check
   */
  async runEvolutionCycle(): Promise<void> {
    this.generationCount++;
    this.logger.info(
      { generation: this.generationCount },
      'Starting evolution cycle',
    );

    // Step 1: Check existing paper traders for promotion readiness
    await this.checkPaperTradersForPromotion();

    // Step 2: Generate new variants
    // Use a placeholder base strategy for now
    const baseSource = this.getTopPerformingStrategySource();
    const baseStrategyName = 'base-strategy';
    const marketPatterns = 'Market conditions: moderate volatility, upward trend';
    const backtestPerformance = 'Base strategy Sharpe: 1.2, Max DD: 8%';

    const variants = await this.generateVariants(
      baseSource,
      baseStrategyName,
      marketPatterns,
      backtestPerformance,
      this.config.variantsPerRun,
    );

    // Store variants
    for (const variant of variants) {
      this.variants.set(variant.id, variant);
    }

    // Step 3: Validate variants
    const validVariants: GeneratedVariant[] = [];
    for (const variant of variants) {
      variant.status = 'validating';
      const result = await this.validator.validate(variant);
      if (result.valid) {
        variant.status = 'valid';
        validVariants.push(variant);
      } else {
        variant.status = 'invalid';
      }
    }

    if (validVariants.length === 0) {
      this.logger.warn('No valid variants after validation — skipping cycle');
      this.recordEvolutionCycle(variants.length, 0, 0, 0);
      return;
    }

    // Step 4: Backtest valid variants
    const backtestResults = await this.runBacktestPipeline(validVariants);

    // Step 5: Tournament selection
    const tournamentResults = this.tournament.select(backtestResults, this.config);

    // Step 6: Queue promoted variants for paper-trading
    const promoted = tournamentResults.filter((r) => r.promotedToPaperTrading);
    for (const result of promoted) {
      const variant = this.variants.get(result.variantId);
      if (variant) {
        variant.status = 'paper-trading';
        // In a full implementation, we would create a PaperTrader instance here
        // and start it with the compiled strategy variant
      }
    }

    const eliminated = tournamentResults.filter((r) => r.eliminated).length;
    this.recordEvolutionCycle(
      variants.length,
      promoted.length,
      0, // live promotions happen during paper-trading checks
      eliminated,
    );

    this.logger.info(
      {
        generation: this.generationCount,
        generated: variants.length,
        valid: validVariants.length,
        promotedToPaperTrading: promoted.length,
        eliminated,
      },
      'Evolution cycle complete',
    );
  }

  /**
   * Check existing paper traders for promotion readiness.
   */
  private async checkPaperTradersForPromotion(): Promise<void> {
    for (const [variantId, trader] of this.activePaperTraders) {
      if (trader.isComplete()) {
        const paperTrades = trader.getPaperTrades();
        const report = this.evaluatePromotion(
          variantId,
          paperTrades,
          this.config.promotionCriteria,
        );

        this.activePaperTraders.delete(variantId);

        this.logger.info(
          { variantId, decision: report.promotionDecision },
          'Paper trader promotion evaluated',
        );
      }
    }
  }

  /**
   * Get source code of the top performing strategy.
   * Returns a placeholder when no strategies are available.
   */
  private getTopPerformingStrategySource(): string {
    // In a full implementation, this would query the strategy loader
    // for the best-performing live strategy's source code
    return `import type { StrategySignal, ExecutionPlan, StrategyContext } from '../core/types.js';
import { CrossChainStrategy } from './cross-chain-strategy.js';

export class BaseStrategy extends CrossChainStrategy {
  readonly name = 'base-strategy';
  readonly timeframe = '5m';
  override readonly stoploss = -0.05;
  override readonly maxPositions = 3;
  override readonly minimalRoi = { 0: 0.03, 60: 0.01 };

  shouldExecute(context: StrategyContext): StrategySignal | null {
    return null;
  }

  buildExecution(signal: StrategySignal, context: StrategyContext): ExecutionPlan {
    return {
      id: 'plan-1',
      strategyName: this.name,
      actions: [],
      estimatedCostUsd: 0,
      estimatedDurationMs: 0,
      metadata: {},
    };
  }
}`;
  }

  /**
   * Record evolution cycle metrics for tracking.
   */
  private recordEvolutionCycle(
    generated: number,
    promotedToPaperTrading: number,
    promotedToLive: number,
    eliminated: number,
  ): void {
    const record: EvolutionCycleRecord = {
      generation: this.generationCount,
      timestamp: Date.now(),
      variantsGenerated: generated,
      variantsPromotedToPaperTrading: promotedToPaperTrading,
      variantsPromotedToLive: promotedToLive,
      variantsEliminated: eliminated,
      currentlyPaperTrading: this.activePaperTraders.size,
    };
    this.evolutionHistory.push(record);
  }

  // --- Public accessors ---

  getConfig(): GenerationConfig {
    return this.config;
  }

  getVariants(): Map<string, GeneratedVariant> {
    return new Map(this.variants);
  }

  getEvolutionHistory(): EvolutionCycleRecord[] {
    return [...this.evolutionHistory];
  }

  getActivePaperTraders(): Map<string, PaperTrader> {
    return new Map(this.activePaperTraders);
  }

  getGenerationCount(): number {
    return this.generationCount;
  }

  /** Expose validator for testing */
  getValidator(): VariantValidator {
    return this.validator;
  }

  /** Expose tournament for testing */
  getTournament(): Tournament {
    return this.tournament;
  }
}
