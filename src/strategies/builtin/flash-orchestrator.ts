// FlashOrchestrator — detects cross-chain arbitrage opportunities and executes
// flash-loan-funded arbitrage loops: borrow → bridge → swap → bridge back → repay.
// Extends RunnableBase for async tick loop with configurable interval.

import { RunnableBase } from '../../core/runnable-base.js';
import type { ChainId, TokenAddress } from '../../core/types.js';
import { CyrusError } from '../../utils/errors.js';
import { FlashExecutor } from '../../executors/flash-executor.js';
import type {
  FlashOrchestratorConfig,
  FlashLoanConfig,
  ArbitrageLoop,
  ArbitrageLoopLeg,
  LoopExecutionState,
  ProfitabilityResult,
  FlashLoopReport,
  FlashPriceFetcher,
  FlashBridgeQuoter,
  FlashSwapExecutor,
  FlashBridgeExecutor,
} from './flash-types.js';
import { FLASH_DEFAULTS } from './flash-types.js';

// --- Error class ---

export class FlashOrchestratorError extends CyrusError {
  constructor(message: string, context: Record<string, unknown> = {}) {
    super(message, context);
  }
}

// --- Action ID generator ---

let actionCounter = 0;
function nextLoopId(): string {
  actionCounter += 1;
  return `flash-loop-${Date.now()}-${actionCounter}`;
}

// --- FlashOrchestrator ---

export class FlashOrchestrator extends RunnableBase {
  private readonly config: FlashOrchestratorConfig;
  private readonly priceFetcher: FlashPriceFetcher;
  private readonly bridgeQuoter: FlashBridgeQuoter;
  private readonly swapExecutor: FlashSwapExecutor;
  private readonly bridgeExecutor: FlashBridgeExecutor;
  private readonly flashExecutor: FlashExecutor;

  private readonly activeLoops: Map<string, LoopExecutionState> = new Map();
  private readonly completedReports: FlashLoopReport[] = [];

  // Circuit breaker state
  private consecutiveLosses = 0;
  private pausedUntil = 0;

  constructor(
    config: Partial<FlashOrchestratorConfig> & {
      flashLoanProviders: FlashLoanConfig[];
      monitoredTokens: TokenAddress[];
      monitoredChainPairs: [ChainId, ChainId][];
    },
    deps: {
      priceFetcher: FlashPriceFetcher;
      bridgeQuoter: FlashBridgeQuoter;
      swapExecutor: FlashSwapExecutor;
      bridgeExecutor: FlashBridgeExecutor;
      flashExecutor: FlashExecutor;
    },
    tickIntervalMs: number = 30_000,
  ) {
    super(tickIntervalMs, 'flash-orchestrator');

    this.config = {
      minProfitUsd: config.minProfitUsd ?? FLASH_DEFAULTS.MIN_PROFIT_USD,
      maxLoanUsd: config.maxLoanUsd ?? FLASH_DEFAULTS.MAX_LOAN_USD,
      maxConcurrentLoops: config.maxConcurrentLoops ?? FLASH_DEFAULTS.MAX_CONCURRENT_LOOPS,
      timeLimitMs: config.timeLimitMs ?? FLASH_DEFAULTS.TIME_LIMIT_MS,
      flashLoanProviders: config.flashLoanProviders,
      monitoredTokens: config.monitoredTokens,
      monitoredChainPairs: config.monitoredChainPairs,
    };

    this.priceFetcher = deps.priceFetcher;
    this.bridgeQuoter = deps.bridgeQuoter;
    this.swapExecutor = deps.swapExecutor;
    this.bridgeExecutor = deps.bridgeExecutor;
    this.flashExecutor = deps.flashExecutor;
  }

  // --- RunnableBase implementation ---

  async controlTask(): Promise<void> {
    // Check circuit breaker
    if (Date.now() < this.pausedUntil) {
      this.logger.debug(
        { pausedUntil: this.pausedUntil, remaining: this.pausedUntil - Date.now() },
        'Flash strategies paused by circuit breaker',
      );
      return;
    }

    // Check active loops for time barriers (collect IDs first to avoid mutating map during iteration)
    const expiredLoopIds: string[] = [];
    for (const [loopId] of this.activeLoops) {
      if (this.isTimeBarrierTriggered(loopId)) {
        expiredLoopIds.push(loopId);
      }
    }
    for (const loopId of expiredLoopIds) {
      const state = this.activeLoops.get(loopId);
      if (!state) continue;
      this.logger.warn({ loopId, status: state.status }, 'Time barrier triggered');
      const report = await this.emergencyRepay(state);
      this.finalizeLoop(loopId, report);
    }

    // Only scan if capacity available
    if (this.activeLoops.size >= this.config.maxConcurrentLoops) {
      this.logger.debug({ activeLoops: this.activeLoops.size }, 'At max concurrent loops');
      return;
    }

    // Scan for opportunities
    const opportunities = await this.scanOpportunities();
    this.logger.debug({ found: opportunities.length }, 'Opportunity scan complete');

    if (opportunities.length === 0) return;

    // Evaluate best opportunity
    const best = opportunities[0]; // Already sorted by expected net profit
    const profitability = await this.calculateProfitability(best);

    if (!profitability.profitable) {
      this.logger.debug(
        { loopId: best.id, netProfit: profitability.netProfitUsd },
        'Best opportunity not profitable after full cost analysis',
      );
      return;
    }

    // Safety checks
    const canExec = this.canExecute(best);
    if (!canExec.allowed) {
      this.logger.info({ loopId: best.id, reason: canExec.reason }, 'Safety check rejected loop');
      return;
    }

    // Execute the loop
    const report = await this.executeLoop(best);
    this.finalizeLoop(best.id, report);
  }

  async onStop(): Promise<void> {
    this.logger.info(
      { activeLoops: this.activeLoops.size, completedReports: this.completedReports.length },
      'FlashOrchestrator stopping',
    );
  }

  // --- Opportunity scanning (AC #1) ---

  async scanOpportunities(): Promise<ArbitrageLoop[]> {
    const opportunities: ArbitrageLoop[] = [];

    for (const [chainA, chainB] of this.config.monitoredChainPairs) {
      for (const token of this.config.monitoredTokens) {
        const priceA = this.priceFetcher.getPrice(chainA, token);
        const priceB = this.priceFetcher.getPrice(chainB, token);

        if (priceA === undefined || priceB === undefined) continue;

        // Calculate differential in both directions
        const diffAtoB = (priceB - priceA) / priceA;
        const diffBtoA = (priceA - priceB) / priceB;

        // Check A→B direction (buy cheap on A, sell expensive on B)
        if (diffAtoB > FLASH_DEFAULTS.MIN_DIFFERENTIAL_PERCENT) {
          const loop = await this.buildArbitrageLoop(chainA, chainB, token, priceA, priceB, diffAtoB);
          if (loop) opportunities.push(loop);
        }

        // Check B→A direction (buy cheap on B, sell expensive on A)
        if (diffBtoA > FLASH_DEFAULTS.MIN_DIFFERENTIAL_PERCENT) {
          const loop = await this.buildArbitrageLoop(chainB, chainA, token, priceB, priceA, diffBtoA);
          if (loop) opportunities.push(loop);
        }
      }
    }

    // Sort by expected net profit descending
    opportunities.sort((a, b) => b.expectedNetProfit - a.expectedNetProfit);
    return opportunities;
  }

  private async buildArbitrageLoop(
    sourceChain: ChainId,
    destChain: ChainId,
    token: TokenAddress,
    buyPrice: number,
    sellPrice: number,
    differential: number,
  ): Promise<ArbitrageLoop | null> {
    // Select flash loan provider for source chain
    const provider = this.config.flashLoanProviders.find(
      (p) => (p.chainId as number) === (sourceChain as number),
    );
    if (!provider) return null;

    // Calculate optimal borrow amount (capped by maxLoanUsd)
    const maxBorrowUsd = Math.min(provider.maxLoanUsd, this.config.maxLoanUsd);
    const borrowAmountTokens = maxBorrowUsd / buyPrice;
    const borrowAmount = BigInt(Math.floor(borrowAmountTokens * 1e18));

    // Fetch bridge quotes for cost estimation
    let bridgeOutQuote: { estimatedFeeUsd: number; estimatedSlippageUsd: number; estimatedGasUsd: number };
    let bridgeBackQuote: { estimatedFeeUsd: number; estimatedSlippageUsd: number; estimatedGasUsd: number };

    try {
      [bridgeOutQuote, bridgeBackQuote] = await Promise.all([
        this.bridgeQuoter.getBridgeQuote(sourceChain, destChain, token, borrowAmount),
        this.bridgeQuoter.getBridgeQuote(destChain, sourceChain, token, borrowAmount),
      ]);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.debug(
        { sourceChain: sourceChain as number, destChain: destChain as number, token: token as string, error: reason },
        'Failed to get bridge quotes for opportunity',
      );
      return null;
    }

    const grossProfitUsd = differential * maxBorrowUsd;
    const flashFeeUsd = maxBorrowUsd * provider.feePercent;
    const totalCosts =
      flashFeeUsd +
      bridgeOutQuote.estimatedFeeUsd +
      bridgeOutQuote.estimatedGasUsd +
      bridgeOutQuote.estimatedSlippageUsd +
      bridgeBackQuote.estimatedFeeUsd +
      bridgeBackQuote.estimatedGasUsd +
      bridgeBackQuote.estimatedSlippageUsd +
      maxBorrowUsd * 0.005; // swap slippage estimate

    const netProfitUsd = grossProfitUsd - totalCosts;

    const legs: ArbitrageLoopLeg[] = [
      {
        type: 'borrow',
        chainId: sourceChain,
        token,
        amount: borrowAmount,
        estimatedGasUsd: 5, // borrow tx gas
        estimatedFeeUsd: flashFeeUsd,
        estimatedSlippageUsd: 0,
      },
      {
        type: 'bridge',
        chainId: sourceChain,
        token,
        amount: borrowAmount,
        estimatedGasUsd: bridgeOutQuote.estimatedGasUsd,
        estimatedFeeUsd: bridgeOutQuote.estimatedFeeUsd,
        estimatedSlippageUsd: bridgeOutQuote.estimatedSlippageUsd,
      },
      {
        type: 'swap',
        chainId: destChain,
        token,
        amount: borrowAmount,
        estimatedGasUsd: 3, // swap tx gas
        estimatedFeeUsd: 0,
        estimatedSlippageUsd: maxBorrowUsd * 0.005,
      },
      {
        type: 'bridge',
        chainId: destChain,
        token,
        amount: borrowAmount,
        estimatedGasUsd: bridgeBackQuote.estimatedGasUsd,
        estimatedFeeUsd: bridgeBackQuote.estimatedFeeUsd,
        estimatedSlippageUsd: bridgeBackQuote.estimatedSlippageUsd,
      },
      {
        type: 'repay',
        chainId: sourceChain,
        token,
        amount: borrowAmount,
        estimatedGasUsd: 5, // repay tx gas
        estimatedFeeUsd: 0,
        estimatedSlippageUsd: 0,
      },
    ];

    return {
      id: nextLoopId(),
      legs,
      sourceChain,
      destChain,
      borrowToken: token,
      borrowAmount,
      expectedGrossProfit: grossProfitUsd,
      expectedNetProfit: netProfitUsd,
      flashLoanProvider: provider.provider,
      createdAt: Date.now(),
    };
  }

  // --- Profitability calculation (AC #2) ---

  async calculateProfitability(loop: ArbitrageLoop): Promise<ProfitabilityResult> {
    // Sum costs from legs
    const borrowLeg = loop.legs.find((l) => l.type === 'borrow');
    const bridgeOutLeg = loop.legs[1]; // bridge out
    const swapLeg = loop.legs.find((l) => l.type === 'swap');
    const bridgeBackLeg = loop.legs[3]; // bridge back
    const repayLeg = loop.legs.find((l) => l.type === 'repay');

    const flashLoanFeeUsd = borrowLeg?.estimatedFeeUsd ?? 0;
    const gasChainAUsd = (borrowLeg?.estimatedGasUsd ?? 0) + (repayLeg?.estimatedGasUsd ?? 0);
    const gasChainBUsd = swapLeg?.estimatedGasUsd ?? 0;
    const bridgeFeeOutUsd = bridgeOutLeg?.estimatedFeeUsd ?? 0;
    const bridgeFeeBackUsd = bridgeBackLeg?.estimatedFeeUsd ?? 0;
    const slippageOutUsd = bridgeOutLeg?.estimatedSlippageUsd ?? 0;
    const slippageBackUsd = bridgeBackLeg?.estimatedSlippageUsd ?? 0;
    const swapSlippageUsd = swapLeg?.estimatedSlippageUsd ?? 0;

    const totalCostsUsd =
      flashLoanFeeUsd +
      gasChainAUsd +
      gasChainBUsd +
      bridgeFeeOutUsd +
      bridgeFeeBackUsd +
      slippageOutUsd +
      slippageBackUsd +
      swapSlippageUsd;

    const grossProfitUsd = loop.expectedGrossProfit;
    const netProfitUsd = grossProfitUsd - totalCostsUsd;

    const result: ProfitabilityResult = {
      profitable: netProfitUsd > this.config.minProfitUsd,
      grossProfitUsd,
      flashLoanFeeUsd,
      gasChainAUsd,
      gasChainBUsd,
      bridgeFeeOutUsd,
      bridgeFeeBackUsd,
      slippageOutUsd,
      slippageBackUsd,
      swapSlippageUsd,
      totalCostsUsd,
      netProfitUsd,
    };

    this.logger.debug(
      { loopId: loop.id, ...result },
      'Profitability analysis complete',
    );

    return result;
  }

  // --- Safety checks (AC #8) ---

  canExecute(loop: ArbitrageLoop): { allowed: boolean; reason?: string } {
    // Max loan cap
    const borrowUsd = loop.expectedGrossProfit + loop.expectedNetProfit; // approximate
    if (borrowUsd > this.config.maxLoanUsd) {
      return { allowed: false, reason: `Borrow amount $${borrowUsd.toFixed(2)} exceeds max loan cap $${this.config.maxLoanUsd}` };
    }

    // Max concurrent loops
    if (this.activeLoops.size >= this.config.maxConcurrentLoops) {
      return { allowed: false, reason: `Max concurrent loops (${this.config.maxConcurrentLoops}) reached` };
    }

    // Circuit breaker
    if (Date.now() < this.pausedUntil) {
      return { allowed: false, reason: 'Flash strategies paused by circuit breaker' };
    }

    return { allowed: true };
  }

  // --- Multi-step execution (AC #4) ---

  async executeLoop(loop: ArbitrageLoop): Promise<FlashLoopReport> {
    const now = Date.now();
    const state: LoopExecutionState = {
      loopId: loop.id,
      status: 'pending',
      currentLeg: 0,
      startedAt: now,
      deadlineAt: now + this.config.timeLimitMs,
      borrowedAmount: loop.borrowAmount,
      borrowedToken: loop.borrowToken,
      borrowChain: loop.sourceChain,
      flashLoanProvider: loop.flashLoanProvider,
      currentTokenAmount: loop.borrowAmount,
      currentTokenChain: loop.sourceChain,
      txHashes: [],
      gasSpent: 0,
      feesSpent: 0,
    };

    this.activeLoops.set(loop.id, state);

    try {
      // Step 1: Borrow
      state.status = 'borrowing';
      this.logger.info({ loopId: loop.id, step: 'borrow' }, 'Starting borrow');

      const provider = this.config.flashLoanProviders.find(
        (p) => p.provider === loop.flashLoanProvider,
      );
      if (!provider) {
        throw new FlashOrchestratorError('Flash loan provider not found', {
          provider: loop.flashLoanProvider,
        });
      }

      const borrowTxHash = await this.flashExecutor.borrow(
        provider,
        loop.borrowToken,
        loop.borrowAmount,
      );
      state.txHashes.push(borrowTxHash);
      state.gasSpent += loop.legs[0]?.estimatedGasUsd ?? 0;
      state.feesSpent += loop.legs[0]?.estimatedFeeUsd ?? 0;
      state.currentLeg = 1; // borrow complete, next is bridge-out

      // Check time before bridge (slow step)
      if (this.isTimeBarrierTriggered(loop.id)) {
        return this.emergencyRepay(state);
      }

      // Step 2: Bridge out
      state.status = 'bridging-out';
      this.logTimeRemaining(loop.id);

      const bridgeOutResult = await this.bridgeExecutor.executeBridge(
        loop.sourceChain,
        loop.destChain,
        loop.borrowToken,
        state.currentTokenAmount,
      );
      state.txHashes.push(bridgeOutResult.txHash);
      state.gasSpent += loop.legs[1]?.estimatedGasUsd ?? 0;
      state.feesSpent += loop.legs[1]?.estimatedFeeUsd ?? 0;

      // Handle bridge terminal status
      if (bridgeOutResult.status === 'FAILED') {
        this.logger.warn({ loopId: loop.id }, 'Bridge out FAILED — emergency repay');
        return this.emergencyRepay(state);
      }
      if (bridgeOutResult.status === 'REFUNDED') {
        this.logger.warn({ loopId: loop.id }, 'Bridge out REFUNDED — repaying immediately');
        state.currentTokenAmount = bridgeOutResult.receivedAmount;
        state.currentTokenChain = loop.sourceChain;
        return this.emergencyRepay(state);
      }

      state.currentTokenAmount = bridgeOutResult.receivedAmount;
      state.currentTokenChain = loop.destChain;
      state.currentLeg = 2; // bridge-out complete, next is swap

      // Check time before swap
      if (this.isTimeBarrierTriggered(loop.id)) {
        return this.emergencyRepay(state);
      }

      // Step 3: Swap on dest chain
      state.status = 'swapping';

      const swapResult = await this.swapExecutor.executeSwap(
        loop.destChain,
        loop.borrowToken,
        loop.borrowToken, // same token, different price
        state.currentTokenAmount,
      );
      state.txHashes.push(swapResult.txHash);
      state.currentTokenAmount = swapResult.receivedAmount;
      state.gasSpent += loop.legs[2]?.estimatedGasUsd ?? 0;
      state.currentLeg = 3; // swap complete, next is bridge-back

      // Check time before bridge back (slow step)
      if (this.isTimeBarrierTriggered(loop.id)) {
        return this.emergencyRepay(state);
      }

      // Step 4: Bridge back
      state.status = 'bridging-back';
      this.logTimeRemaining(loop.id);

      const bridgeBackResult = await this.bridgeExecutor.executeBridge(
        loop.destChain,
        loop.sourceChain,
        loop.borrowToken,
        state.currentTokenAmount,
      );
      state.txHashes.push(bridgeBackResult.txHash);
      state.gasSpent += loop.legs[3]?.estimatedGasUsd ?? 0;
      state.feesSpent += loop.legs[3]?.estimatedFeeUsd ?? 0;

      // Handle bridge back terminal status
      if (bridgeBackResult.status === 'FAILED') {
        this.logger.warn({ loopId: loop.id }, 'Bridge back FAILED — emergency repay');
        return this.emergencyRepay(state);
      }
      if (bridgeBackResult.status === 'REFUNDED') {
        // Tokens refunded to dest chain — need to bridge again or accept loss
        this.logger.warn({ loopId: loop.id }, 'Bridge back REFUNDED — emergency repay');
        state.currentTokenAmount = bridgeBackResult.receivedAmount;
        return this.emergencyRepay(state);
      }

      state.currentTokenAmount = bridgeBackResult.receivedAmount;
      state.currentTokenChain = loop.sourceChain;
      state.currentLeg = 4; // bridge-back complete, next is repay

      // Step 5: Repay
      state.status = 'repaying';

      const fee = FlashExecutor.calculateFee(loop.flashLoanProvider, loop.borrowAmount);
      const repayTxHash = await this.flashExecutor.repay(
        provider,
        loop.borrowToken,
        loop.borrowAmount,
        fee,
      );
      state.txHashes.push(repayTxHash);
      state.gasSpent += loop.legs[4]?.estimatedGasUsd ?? 0;

      state.status = 'completed';

      // Calculate actual profit
      const totalRepaid = loop.borrowAmount + fee;
      const profit = state.currentTokenAmount > totalRepaid;
      const outcome = profit ? 'profit' : 'loss';

      return this.generateReport(state, outcome);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.error({ loopId: loop.id, error: reason, currentLeg: state.currentLeg }, 'Loop execution failed');

      // If we've already borrowed (currentLeg >= 1), attempt emergency repay to recover funds
      if (state.currentLeg >= 1) {
        this.logger.warn({ loopId: loop.id }, 'Attempting emergency repay after execution failure');
        return this.emergencyRepay(state);
      }

      // Borrow itself failed — nothing to repay
      state.status = 'failed';
      return this.generateReport(state, 'loss');
    }
  }

  // --- Time-bounded execution (AC #5) ---

  getRemainingTime(loopId: string): number {
    const state = this.activeLoops.get(loopId);
    if (!state) return 0;
    return Math.max(0, state.deadlineAt - Date.now());
  }

  isTimeBarrierTriggered(loopId: string): boolean {
    const state = this.activeLoops.get(loopId);
    if (!state) return false;

    const remaining = state.deadlineAt - Date.now();
    if (remaining <= 0) return true;

    // Estimate time needed for remaining steps (legs after current)
    const currentLeg = state.currentLeg;
    let estimatedTimeNeeded = 0;

    // Only count legs we haven't started yet
    if (currentLeg < 1) estimatedTimeNeeded += FLASH_DEFAULTS.BRIDGE_TIME_ESTIMATE_MS; // bridge out
    if (currentLeg < 2) estimatedTimeNeeded += FLASH_DEFAULTS.SWAP_TIME_ESTIMATE_MS; // swap
    if (currentLeg < 3) estimatedTimeNeeded += FLASH_DEFAULTS.BRIDGE_TIME_ESTIMATE_MS; // bridge back
    if (currentLeg < 4) estimatedTimeNeeded += FLASH_DEFAULTS.REPAY_TIME_ESTIMATE_MS; // repay

    return remaining < estimatedTimeNeeded;
  }

  private logTimeRemaining(loopId: string): void {
    const remaining = this.getRemainingTime(loopId);
    const remainingMin = Math.round(remaining / 60_000);

    if (remaining < 600_000) {
      this.logger.warn({ loopId, remainingMs: remaining, remainingMin }, 'Less than 10 minutes remaining');
    } else {
      this.logger.info({ loopId, remainingMs: remaining, remainingMin }, 'Time remaining');
    }
  }

  // --- Emergency repayment (AC #6) ---

  async emergencyRepay(loopState: LoopExecutionState): Promise<FlashLoopReport> {
    this.logger.warn(
      { loopId: loopState.loopId, currentChain: loopState.currentTokenChain as number },
      'Emergency repayment triggered',
    );

    loopState.status = 'emergency-repay';

    try {
      const provider = this.config.flashLoanProviders.find(
        (p) => (p.chainId as number) === (loopState.borrowChain as number),
      );

      if (!provider) {
        loopState.status = 'failed';
        return this.generateReport(loopState, 'emergency-repay');
      }

      // If tokens are on dest chain, bridge back with fastest option
      if ((loopState.currentTokenChain as number) !== (loopState.borrowChain as number)) {
        const bridgeResult = await this.bridgeExecutor.executeBridge(
          loopState.currentTokenChain,
          loopState.borrowChain,
          loopState.borrowedToken,
          loopState.currentTokenAmount,
          { order: 'FASTEST', slippage: FLASH_DEFAULTS.EMERGENCY_SLIPPAGE },
        );
        loopState.txHashes.push(bridgeResult.txHash);
        loopState.currentTokenAmount = bridgeResult.receivedAmount;
        loopState.currentTokenChain = loopState.borrowChain;
      }

      // Repay
      const fee = FlashExecutor.calculateFee(
        provider.provider,
        loopState.borrowedAmount,
      );
      const repayTxHash = await this.flashExecutor.repay(
        provider,
        loopState.borrowedToken,
        loopState.borrowedAmount,
        fee,
      );
      loopState.txHashes.push(repayTxHash);

      return this.generateReport(loopState, 'emergency-repay');
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.error(
        { loopId: loopState.loopId, error: reason },
        'Emergency repayment FAILED — critical',
      );
      loopState.status = 'failed';
      return this.generateReport(loopState, 'emergency-repay');
    }
  }

  // --- Report generation (AC #7) ---

  generateReport(
    loopState: LoopExecutionState,
    outcome: 'profit' | 'loss' | 'emergency-repay',
  ): FlashLoopReport {
    const durationMs = Date.now() - loopState.startedAt;

    // Calculate actual profit from token amounts (current - borrowed - fee)
    const provider = loopState.flashLoanProvider ?? 'aave-v3';
    const fee = loopState.borrowedAmount > 0n
      ? FlashExecutor.calculateFee(provider, loopState.borrowedAmount)
      : 0n;
    const totalRepayment = loopState.borrowedAmount + fee;
    // Token-level profit (positive = profit, negative = loss)
    const tokenDelta = loopState.currentTokenAmount - totalRepayment;
    // Convert to USD-approx: use gasSpent + feesSpent as cost proxy
    // The tokenDelta is in token units; we'll report costs separately
    const grossProfitFromExecution = tokenDelta > 0n
      ? Number(tokenDelta) / 1e18 // rough USD (assumes ~$1 per token unit, actual depends on price)
      : -(Number(-tokenDelta) / 1e18);

    const report: FlashLoopReport = {
      loopId: loopState.loopId,
      outcome,
      grossProfit: grossProfitFromExecution,
      flashLoanFee: loopState.feesSpent,
      totalGasCosts: loopState.gasSpent,
      totalBridgeFees: loopState.feesSpent,
      totalSlippage: 0,
      netProfit: grossProfitFromExecution - loopState.gasSpent - loopState.feesSpent,
      durationMs,
      legs: loopState.txHashes.map((txHash, i) => ({
        type: ['borrow', 'bridge-out', 'swap', 'bridge-back', 'repay'][i] ?? 'unknown',
        txHash,
        status: i < loopState.currentLeg ? 'completed' : loopState.status,
      })),
      reason: this.buildReasonString(loopState, outcome, durationMs),
    };

    this.logger.info(
      {
        loopId: report.loopId,
        outcome: report.outcome,
        netProfit: report.netProfit,
        durationMs: report.durationMs,
      },
      'Flash loop report generated',
    );

    return report;
  }

  private buildReasonString(
    state: LoopExecutionState,
    outcome: 'profit' | 'loss' | 'emergency-repay',
    durationMs: number,
  ): string {
    const durationSec = Math.round(durationMs / 1000);

    if (outcome === 'emergency-repay') {
      return `Emergency repayment triggered after ${durationSec}s. ` +
        `Borrowed ${state.borrowedAmount.toString()} tokens on chain ${state.borrowChain as number}. ` +
        `Tokens were on chain ${state.currentTokenChain as number} when time barrier hit. ` +
        `${state.txHashes.length} transactions executed.`;
    }

    if (outcome === 'profit') {
      return `Arbitrage loop completed successfully in ${durationSec}s. ` +
        `Borrowed on chain ${state.borrowChain as number}, ` +
        `${state.txHashes.length} transactions executed. ` +
        `Gas: $${state.gasSpent.toFixed(2)}, Fees: $${state.feesSpent.toFixed(2)}.`;
    }

    return `Arbitrage loop completed with loss in ${durationSec}s. ` +
      `Status: ${state.status}. ${state.txHashes.length} transactions executed.`;
  }

  // --- Loop lifecycle ---

  private finalizeLoop(loopId: string, report: FlashLoopReport): void {
    this.activeLoops.delete(loopId);
    this.completedReports.push(report);

    // Update circuit breaker
    if (report.outcome === 'loss' || report.outcome === 'emergency-repay') {
      this.consecutiveLosses++;
      if (this.consecutiveLosses >= FLASH_DEFAULTS.CIRCUIT_BREAKER_THRESHOLD) {
        this.pausedUntil = Date.now() + FLASH_DEFAULTS.CIRCUIT_BREAKER_PAUSE_MS;
        this.logger.warn(
          { consecutiveLosses: this.consecutiveLosses, pausedUntil: this.pausedUntil },
          'Circuit breaker activated — flash strategies paused for 1 hour',
        );
      }
    } else {
      this.consecutiveLosses = 0;
    }
  }

  // --- Accessors ---

  getActiveLoops(): LoopExecutionState[] {
    return Array.from(this.activeLoops.values());
  }

  getCompletedReports(): FlashLoopReport[] {
    return [...this.completedReports];
  }

  getConsecutiveLosses(): number {
    return this.consecutiveLosses;
  }

  isPaused(): boolean {
    return Date.now() < this.pausedUntil;
  }

  // For testing: set paused state
  setPausedUntil(ts: number): void {
    this.pausedUntil = ts;
  }
}
