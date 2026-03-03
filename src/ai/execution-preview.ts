import { randomUUID } from 'node:crypto';
import { createLogger } from '../utils/logger.js';
import type { Preview, PreviewStep, CostEstimate, NLExecutionPlan } from './types.js';
import type { LiFiConnectorInterface } from '../connectors/types.js';
import { chainId, tokenAddress } from '../core/types.js';

const logger = createLogger('execution-preview');

export interface ExecutionPreviewOptions {
  readonly connector?: LiFiConnectorInterface;
}

export class ExecutionPreview {
  private readonly connector: LiFiConnectorInterface | null;

  constructor(options: ExecutionPreviewOptions = {}) {
    this.connector = options.connector ?? null;
  }

  async generatePreview(plan: NLExecutionPlan): Promise<Preview> {
    const planId = randomUUID();
    const steps: PreviewStep[] = [];
    let totalGasUsd = 0;
    let totalBridgeFeeUsd = 0;
    let totalSlippage = 0;
    let totalSeconds = 0;

    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i];
      let cost: CostEstimate;
      let estimatedSeconds = 30; // default

      if (this.connector && step.chainId > 0) {
        try {
          // Try to get a quote for cost estimation
          const quote = await this.connector.getQuote({
            fromChain: chainId(step.chainId),
            toChain: chainId(step.chainId), // same chain for swaps
            fromToken: tokenAddress('0x0000000000000000000000000000000000000000'),
            toToken: tokenAddress('0x0000000000000000000000000000000000000000'),
            fromAmount: step.amount,
          });

          const gasCosts = (quote.estimate as any).gasCosts ?? [];
          const feeCosts = (quote.estimate as any).feeCosts ?? [];
          const gasUsd = gasCosts.reduce((sum: number, g: any) => sum + (parseFloat(g.amountUSD) || 0), 0);
          const bridgeFeeUsd = feeCosts.reduce((sum: number, f: any) => sum + (parseFloat(f.amountUSD) || 0), 0);
          const slippageEstimate = 0.005; // default 0.5%
          estimatedSeconds = (quote.estimate as any).executionDuration ?? 30;

          cost = {
            gasUsd,
            bridgeFeeUsd,
            slippageEstimate,
            totalUsd: gasUsd + bridgeFeeUsd,
          };
        } catch (error) {
          logger.debug({ step: i, error: (error as Error).message }, 'Could not get quote for preview step, using estimates');
          cost = { gasUsd: 0.5, bridgeFeeUsd: 0, slippageEstimate: 0.005, totalUsd: 0.5 };
        }
      } else {
        cost = { gasUsd: 0.5, bridgeFeeUsd: 0, slippageEstimate: 0.005, totalUsd: 0.5 };
      }

      totalGasUsd += cost.gasUsd;
      totalBridgeFeeUsd += cost.bridgeFeeUsd;
      totalSlippage += cost.slippageEstimate;
      totalSeconds += estimatedSeconds;

      steps.push({
        index: i,
        action: step.action,
        description: step.details,
        fromChain: step.chainId,
        toChain: step.chainId,
        token: step.token,
        amount: step.amount,
        cost,
        estimatedSeconds,
      });
    }

    const preview: Preview = {
      planId,
      steps,
      totalCost: {
        gasUsd: totalGasUsd,
        bridgeFeeUsd: totalBridgeFeeUsd,
        slippageEstimate: totalSlippage / Math.max(steps.length, 1),
        totalUsd: totalGasUsd + totalBridgeFeeUsd,
      },
      estimatedCompletionSeconds: totalSeconds,
      createdAt: Date.now(),
    };

    logger.info(
      { planId, stepCount: steps.length, totalCostUsd: preview.totalCost.totalUsd, estimatedSeconds: totalSeconds },
      'Execution preview generated',
    );

    return preview;
  }
}
