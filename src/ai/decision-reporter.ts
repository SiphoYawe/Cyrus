import { randomUUID } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { createLogger } from '../utils/logger.js';
import { Store } from '../core/store.js';
import type { DecisionReport, DecisionContext, OutcomeClassification, ReportFilter } from './types.js';
import { DECISION_REPORT_SYSTEM_PROMPT, formatDecisionContext } from './prompts/decision-report.js';

const logger = createLogger('decision-reporter');
const DEFAULT_MODEL = 'claude-sonnet-4-20250514';

export interface DecisionReporterOptions {
  readonly apiKey?: string;
  readonly model?: string;
  readonly client?: Anthropic;
}

export class DecisionReporter {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly store: Store;

  constructor(options: DecisionReporterOptions = {}) {
    this.client = options.client ?? new Anthropic({ apiKey: options.apiKey });
    this.model = options.model ?? DEFAULT_MODEL;
    this.store = Store.getInstance();
  }

  async generateReport(
    strategyName: string,
    context: DecisionContext,
    transferIds: string[] = [],
  ): Promise<DecisionReport> {
    let narrative: string;

    try {
      const userMessage = formatDecisionContext(context);
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 512,
        system: DECISION_REPORT_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMessage }],
      });

      narrative = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map(block => block.text)
        .join('');

      if (!narrative.trim()) {
        narrative = this.buildFallbackNarrative(context, strategyName);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn({ error: message, strategyName }, 'Failed to generate AI narrative, using fallback');
      narrative = this.buildFallbackNarrative(context, strategyName);
    }

    const report: DecisionReport = {
      id: randomUUID(),
      timestamp: Date.now(),
      strategyName,
      narrative,
      transferIds,
      outcome: 'pending',
      context,
    };

    this.store.addReport(report);

    logger.info(
      { reportId: report.id, strategyName, outcome: report.outcome },
      'Decision report generated',
    );

    return report;
  }

  updateOutcome(reportId: string, outcome: OutcomeClassification, reason?: string): void {
    this.store.updateReportOutcome(reportId, outcome, reason);
    logger.info({ reportId, outcome, reason }, 'Decision report outcome updated');
  }

  getReports(filter?: ReportFilter): DecisionReport[] {
    return this.store.getReports(filter);
  }

  private buildFallbackNarrative(context: DecisionContext, strategyName: string): string {
    const parts = [
      `I executed a ${context.actionType} action via ${strategyName} strategy.`,
      `Moved $${context.amountUsd.toFixed(2)} worth of ${context.tokenSymbol}`,
      `from chain ${context.fromChain} to chain ${context.toChain}.`,
      `Cost: $${context.gasCostUsd.toFixed(2)} gas + $${context.bridgeFeeUsd.toFixed(2)} bridge fee.`,
    ];
    if (context.estimatedApy !== undefined) {
      parts.push(`Expected APY: ${(context.estimatedApy * 100).toFixed(2)}%.`);
    }
    return parts.join(' ');
  }
}
