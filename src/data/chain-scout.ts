// ChainScout — Predictive Chain Migration Service (Story 8.4)
// Monitors chain ecosystem health, generates migration plans, and triggers exits

import { randomUUID } from 'node:crypto';
import { RunnableBase } from '../core/runnable-base.js';
import { Store } from '../core/store.js';
import { chainId, tokenAddress } from '../core/types.js';
import type { LiFiConnectorInterface } from '../connectors/types.js';
import type {
  ChainMetrics,
  ChainHealthScore,
  HealthScoreComponents,
  MigrationPlan,
  AirdropIndicator,
  ChainScoutConfig,
  TvlHistoryEntry,
  TargetProtocol,
  RiskLevel,
} from './chain-health-types.js';
import {
  HEALTH_SCORE_WEIGHTS,
  DEFAULT_CHAIN_SCOUT_CONFIG,
} from './chain-health-types.js';

// USDC contract addresses per chain (used for bridge cost estimation and migration execution)
const USDC_ADDRESSES: Readonly<Record<number, string>> = {
  1: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',       // Ethereum
  42161: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',   // Arbitrum
  8453: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',    // Base
  10: '0x0b2c639c533813f4aa9d7837caf62653d097ff85',      // Optimism
  137: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359',     // Polygon
};

export class ChainScout extends RunnableBase {
  private readonly config: ChainScoutConfig;
  private readonly connector: LiFiConnectorInterface;
  private readonly store: Store;

  // Internal state
  private readonly chainMetrics: Map<number, ChainMetrics> = new Map();
  private readonly healthScores: Map<number, ChainHealthScore> = new Map();
  private readonly migrationPlans: Map<string, MigrationPlan> = new Map();

  // Protocol count history: key = chainId, value = array of { timestamp, count }
  private readonly protocolCountHistory: Map<number, Array<{ timestamp: number; count: number }>> = new Map();

  constructor(
    config: Partial<ChainScoutConfig> = {},
    connector: LiFiConnectorInterface,
    store: Store,
  ) {
    const merged: ChainScoutConfig = { ...DEFAULT_CHAIN_SCOUT_CONFIG, ...config };
    super(merged.updateIntervalMs, 'chain-scout');
    this.config = merged;
    this.connector = connector;
    this.store = store;
  }

  // --- RunnableBase lifecycle ---

  async controlTask(): Promise<void> {
    // Step 1: Fetch and update metrics for all monitored chains
    await this.updateAllChainMetrics();

    // Step 2: Compute health scores for all chains
    this.computeAllHealthScores();

    // Step 3: Check migration triggers
    this.checkMigrationTriggers();

    // Step 4: Check exit triggers
    this.checkExitTriggers();

    // Step 5: Check time-limit barrier expiry
    this.checkTimeLimitExpiry();
  }

  async onStop(): Promise<void> {
    this.logger.info('ChainScout stopped');
  }

  // --- Step 1: Fetch chain metrics ---

  private async updateAllChainMetrics(): Promise<void> {
    // Get list of chains to monitor from connector
    let chainIds: number[];
    try {
      const chains = await this.connector.getChains();
      chainIds = chains.map((c) => c.id);
    } catch {
      // Fallback to established chains + any chains we already track
      chainIds = [
        ...this.config.establishedChains,
        ...Array.from(this.chainMetrics.keys()),
      ];
      chainIds = [...new Set(chainIds)];
    }

    const results = await Promise.allSettled(
      chainIds.map((id) => this.updateChainMetrics(id)),
    );

    for (const result of results) {
      if (result.status === 'rejected') {
        this.logger.warn(
          { error: (result.reason as Error).message },
          'Failed to update chain metrics',
        );
      }
    }
  }

  private async updateChainMetrics(id: number): Promise<void> {
    const existing = this.chainMetrics.get(id);
    const metrics = await this.fetchChainMetrics(id);

    // Update TVL history
    this.updateTvlHistory(metrics, metrics.tvl);

    // Compute rolling TVL rates
    metrics.tvlInflowRate7d = this.computeTvlInflowRate(metrics.tvlHistory, 7);
    metrics.tvlOutflowRate3d = this.computeTvlOutflowRate(metrics.tvlHistory, 3);

    // Update protocol count history
    const protocolCount = await this.fetchProtocolCount(id);
    metrics.protocolCount = protocolCount;
    metrics.newProtocolsPerWeek = this.computeNewProtocolsPerWeek(id, protocolCount);

    // Track protocol count
    const countHistory = this.protocolCountHistory.get(id) ?? [];
    countHistory.push({ timestamp: Date.now(), count: protocolCount });
    // Prune entries older than 30 days
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const prunedHistory = countHistory.filter((e) => e.timestamp >= thirtyDaysAgo);
    this.protocolCountHistory.set(id, prunedHistory);

    // Detect airdrop indicators
    metrics.airdropIndicators = await this.detectAirdropIndicators(id);

    // Fetch bridge volume via LI.FI connections
    metrics.bridgeVolumeUsd = await this.fetchBridgeVolume(id);

    metrics.lastUpdated = Date.now();
    this.chainMetrics.set(id, metrics);
  }

  // --- Data fetching methods (mockable in tests) ---

  async fetchChainMetrics(chainIdValue: number): Promise<ChainMetrics> {
    // In production, this would call DeFiLlama or similar APIs
    // For now, return existing metrics or a default placeholder
    const existing = this.chainMetrics.get(chainIdValue);
    if (existing) {
      return { ...existing };
    }

    return {
      chainId: chainIdValue,
      chainName: this.getChainName(chainIdValue),
      tvl: 0,
      tvlHistory: [],
      tvlInflowRate7d: 0,
      tvlOutflowRate3d: 0,
      protocolCount: 0,
      newProtocolsPerWeek: 0,
      uniqueActiveAddresses: 0,
      activeAddressGrowthRate: 0,
      bridgeVolumeUsd: 0,
      chainAgeDays: 365,
      airdropIndicators: [],
      lastUpdated: Date.now(),
    };
  }

  async fetchProtocolCount(_chainIdValue: number): Promise<number> {
    // In production, this would call DeFiLlama protocols endpoint
    // Returns placeholder data — scoring logic is what matters
    return 0;
  }

  async detectAirdropIndicators(_chainIdValue: number): Promise<AirdropIndicator[]> {
    // In production, would scan for governance token launches, TGEs, points programs
    return [];
  }

  async fetchBridgeVolume(chainIdValue: number): Promise<number> {
    // Try to get bridge volume from LI.FI connections endpoint
    try {
      // Query connections from established chains to this chain
      let totalVolume = 0;
      for (const srcChain of this.config.establishedChains) {
        if (srcChain === chainIdValue) continue;
        const connections = await this.connector.getConnections(srcChain, chainIdValue);
        // Sum token count as a proxy for bridge activity
        for (const conn of connections) {
          totalVolume += conn.fromTokens.length * 1000; // Placeholder scaling
        }
      }
      return totalVolume;
    } catch {
      return 0;
    }
  }

  // --- TVL tracking helpers ---

  updateTvlHistory(metrics: ChainMetrics, latestTvl: number): void {
    const now = Date.now();
    metrics.tvlHistory.push({ timestamp: now, value: latestTvl });

    // Prune entries older than 30 days
    const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;
    metrics.tvlHistory = metrics.tvlHistory.filter((e) => e.timestamp >= thirtyDaysAgo);
  }

  computeTvlInflowRate(history: TvlHistoryEntry[], windowDays: number): number {
    if (history.length < 2) return 0;

    const now = Date.now();
    const windowMs = windowDays * 24 * 60 * 60 * 1000;
    const windowStart = now - windowMs;

    // Find the earliest entry within the window
    const entriesInWindow = history.filter((e) => e.timestamp >= windowStart);
    if (entriesInWindow.length < 2) return 0;

    // Sort by timestamp ascending
    const sorted = [...entriesInWindow].sort((a, b) => a.timestamp - b.timestamp);
    const earliest = sorted[0]!;
    const latest = sorted[sorted.length - 1]!;

    if (earliest.value === 0) return 0;

    const rate = (latest.value - earliest.value) / earliest.value;
    return rate;
  }

  private computeTvlOutflowRate(history: TvlHistoryEntry[], windowDays: number): number {
    // Outflow rate is the negative of inflow — we want a positive number representing outflow
    const inflowRate = this.computeTvlInflowRate(history, windowDays);
    return inflowRate < 0 ? Math.abs(inflowRate) : 0;
  }

  computeNewProtocolsPerWeek(chainIdValue: number, currentCount: number): number {
    const history = this.protocolCountHistory.get(chainIdValue);
    if (!history || history.length === 0) return 0;

    // Find entry from approximately 7 days ago
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const oldEntries = history.filter((e) => e.timestamp <= sevenDaysAgo);
    if (oldEntries.length === 0) return 0;

    // Take the most recent old entry
    const oldEntry = oldEntries[oldEntries.length - 1]!;
    return Math.max(0, currentCount - oldEntry.count);
  }

  // --- Step 2: Scoring algorithm ---

  private computeAllHealthScores(): void {
    for (const [id, metrics] of this.chainMetrics) {
      const score = this.scoreChain(metrics);
      this.healthScores.set(id, score);
    }
  }

  scoreChain(metrics: ChainMetrics): ChainHealthScore {
    const components = this.computeScoreComponents(metrics);
    const overallScore = this.computeWeightedScore(components);

    const isEstablished = this.config.establishedChains.includes(metrics.chainId);
    const isEmerging = !isEstablished && overallScore >= this.config.deploymentScoreThreshold;

    let riskLevel: RiskLevel;
    if (metrics.chainAgeDays < 90) {
      riskLevel = 'high';
    } else if (metrics.chainAgeDays < 365) {
      riskLevel = 'medium';
    } else {
      riskLevel = 'low';
    }

    const cyrusExposurePercent = this.computeExposurePercent(metrics.chainId);

    return {
      chainId: metrics.chainId,
      chainName: metrics.chainName,
      overallScore,
      components,
      riskLevel,
      isEmerging,
      cyrusExposurePercent,
      lastScored: Date.now(),
    };
  }

  private computeScoreComponents(metrics: ChainMetrics): HealthScoreComponents {
    // TVL growth: 0% = 0, 20%+ = 100, linear interpolation
    const tvlGrowth = Math.min(100, Math.max(0, (metrics.tvlInflowRate7d / 0.20) * 100));

    // Protocol diversity: 0 protocols = 0, 50+ = 100
    const protocolDiversity = Math.min(100, Math.max(0, (metrics.protocolCount / 50) * 100));

    // Developer activity: 0% growth = 0, 50%+ = 100
    const developerActivity = Math.min(100, Math.max(0, (metrics.activeAddressGrowthRate / 0.50) * 100));

    // Bridge volume: relative to median across all tracked chains
    const bridgeVolume = this.normalizeBridgeVolume(metrics.bridgeVolumeUsd);

    // Chain age factor: newer chains score higher for opportunity
    // < 90 days = 100, 90-365 = 50, 365+ = 25
    let chainAgeFactor: number;
    if (metrics.chainAgeDays < 90) {
      chainAgeFactor = 100;
    } else if (metrics.chainAgeDays < 365) {
      chainAgeFactor = 50;
    } else {
      chainAgeFactor = 25;
    }

    return {
      tvlGrowth,
      protocolDiversity,
      developerActivity,
      bridgeVolume,
      chainAgeFactor,
    };
  }

  private computeWeightedScore(components: HealthScoreComponents): number {
    const score =
      components.tvlGrowth * HEALTH_SCORE_WEIGHTS.tvlGrowth +
      components.protocolDiversity * HEALTH_SCORE_WEIGHTS.protocolDiversity +
      components.developerActivity * HEALTH_SCORE_WEIGHTS.developerActivity +
      components.bridgeVolume * HEALTH_SCORE_WEIGHTS.bridgeVolume +
      components.chainAgeFactor * HEALTH_SCORE_WEIGHTS.chainAgeFactor;

    return Math.min(100, Math.max(0, Math.round(score * 100) / 100));
  }

  private normalizeBridgeVolume(volumeUsd: number): number {
    // Get all bridge volumes across tracked chains
    const allVolumes: number[] = [];
    for (const metrics of this.chainMetrics.values()) {
      if (metrics.bridgeVolumeUsd > 0) {
        allVolumes.push(metrics.bridgeVolumeUsd);
      }
    }

    if (allVolumes.length === 0 || volumeUsd === 0) return 0;

    // Calculate median
    const sorted = [...allVolumes].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 0
      ? (sorted[mid - 1]! + sorted[mid]!) / 2
      : sorted[mid]!;

    if (median === 0) return 0;

    // Normalize: median = 50, 2x median = 100
    const normalized = (volumeUsd / median) * 50;
    return Math.min(100, Math.max(0, normalized));
  }

  private computeExposurePercent(chainIdValue: number): number {
    const positions = this.store.getAllPositions();
    const balances = this.store.getAllBalances();

    // Total portfolio value
    let totalValue = 0;
    let chainValue = 0;

    for (const pos of positions) {
      const value = pos.currentPrice * Number(pos.amount) / (10 ** 18); // Approximate
      totalValue += value;
      if ((pos.chainId as number) === chainIdValue) {
        chainValue += value;
      }
    }

    for (const bal of balances) {
      totalValue += bal.usdValue;
      if ((bal.chainId as number) === chainIdValue) {
        chainValue += bal.usdValue;
      }
    }

    if (totalValue === 0) return 0;
    return chainValue / totalValue;
  }

  // --- Step 3: Migration triggers ---

  private checkMigrationTriggers(): void {
    for (const [id, score] of this.healthScores) {
      if (this.shouldMigrate(id, score)) {
        this.logger.info(
          { chainId: id, score: score.overallScore, chainName: score.chainName },
          'Migration trigger detected for emerging chain',
        );
        // In production, this would queue a migration plan for approval
        // For now, log and generate the plan
        this.generateMigrationPlan(id, score).catch((err) => {
          this.logger.error(
            { chainId: id, error: (err as Error).message },
            'Failed to generate migration plan',
          );
        });
      }
    }
  }

  shouldMigrate(chainIdValue: number, score: ChainHealthScore): boolean {
    if (!score.isEmerging) return false;
    if (score.overallScore < this.config.deploymentScoreThreshold) return false;
    if (score.cyrusExposurePercent >= this.config.capitalMigrationPercent) return false;

    // Check if there is already an active or executing migration plan for this chain
    for (const plan of this.migrationPlans.values()) {
      if (
        plan.destinationChainId === chainIdValue &&
        (plan.status === 'pending' || plan.status === 'executing' || plan.status === 'active')
      ) {
        return false;
      }
    }

    return true;
  }

  async generateMigrationPlan(
    destinationChainId: number,
    score: ChainHealthScore,
  ): Promise<MigrationPlan> {
    // Determine source chains with available capital
    const sourceChainIds = this.getSourceChainsWithCapital();

    // Calculate total portfolio value and migration amount
    const totalPortfolioValue = this.computeTotalPortfolioValue();
    const migrationAmountUsd = totalPortfolioValue * this.config.capitalMigrationPercent;

    // Get target yield protocols on destination chain
    const targetProtocols = await this.discoverTargetProtocols(destinationChainId);

    // Estimate bridge cost via LI.FI quote
    let estimatedBridgeCostUsd = 0;
    let estimatedBridgeTimeSeconds = 0;

    if (sourceChainIds.length > 0 && migrationAmountUsd > 0) {
      try {
        const estimate = await this.estimateBridgeCost(
          sourceChainIds[0]!,
          destinationChainId,
          migrationAmountUsd,
        );
        estimatedBridgeCostUsd = estimate.costUsd;
        estimatedBridgeTimeSeconds = estimate.timeSeconds;
      } catch (err) {
        this.logger.warn(
          { error: (err as Error).message },
          'Failed to estimate bridge cost, using defaults',
        );
      }
    }

    const plan: MigrationPlan = {
      id: randomUUID(),
      sourceChainIds,
      destinationChainId,
      capitalPercent: this.config.capitalMigrationPercent,
      estimatedAmountUsd: migrationAmountUsd,
      targetProtocols,
      estimatedBridgeCostUsd,
      estimatedBridgeTimeSeconds,
      timeLimitBarrierDays: this.config.timeLimitDays,
      healthScoreAtCreation: score.overallScore,
      status: 'pending',
      createdAt: Date.now(),
    };

    this.migrationPlans.set(plan.id, plan);
    this.logger.info(
      {
        planId: plan.id,
        destination: destinationChainId,
        amountUsd: migrationAmountUsd,
        protocols: targetProtocols.length,
      },
      'Migration plan generated',
    );

    return plan;
  }

  private getSourceChainsWithCapital(): number[] {
    const balances = this.store.getAllBalances();
    const chainsWithCapital = new Set<number>();

    for (const bal of balances) {
      if (
        this.config.establishedChains.includes(bal.chainId as number) &&
        bal.usdValue > 0
      ) {
        chainsWithCapital.add(bal.chainId as number);
      }
    }

    return Array.from(chainsWithCapital);
  }

  private computeTotalPortfolioValue(): number {
    const balances = this.store.getAllBalances();
    const positions = this.store.getAllPositions();

    let total = 0;
    for (const bal of balances) {
      total += bal.usdValue;
    }
    for (const pos of positions) {
      total += pos.currentPrice * Number(pos.amount) / (10 ** 18);
    }

    return total;
  }

  async discoverTargetProtocols(_destinationChainId: number): Promise<TargetProtocol[]> {
    // In production, query Composer-supported protocols for APYs
    // For now, return well-known protocols as placeholders
    return [
      { protocol: 'aave-v3', apy: 0.05, tvl: 1_000_000_000 },
      { protocol: 'morpho', apy: 0.07, tvl: 500_000_000 },
      { protocol: 'euler', apy: 0.06, tvl: 300_000_000 },
    ].sort((a, b) => b.apy - a.apy);
  }

  private async estimateBridgeCost(
    sourceChainId: number,
    destinationChainId: number,
    amountUsd: number,
  ): Promise<{ costUsd: number; timeSeconds: number }> {
    const fromToken = USDC_ADDRESSES[sourceChainId] ?? USDC_ADDRESSES[1]!;
    const toToken = USDC_ADDRESSES[destinationChainId] ?? USDC_ADDRESSES[1]!;

    // Convert USD amount to USDC smallest units (6 decimals)
    const fromAmount = Math.floor(amountUsd * 1_000_000).toString();

    const quote = await this.connector.getQuote({
      fromChain: chainId(sourceChainId),
      toChain: chainId(destinationChainId),
      fromToken: tokenAddress(fromToken),
      toToken: tokenAddress(toToken),
      fromAmount,
      slippage: 0.005,
    });

    const gasCosts = quote.estimate.gasCosts;
    const totalGasCostUsd = gasCosts.reduce(
      (sum, gc) => sum + parseFloat(gc.amountUSD),
      0,
    );

    return {
      costUsd: totalGasCostUsd,
      timeSeconds: quote.estimate.executionDuration,
    };
  }

  // --- Step 4: Migration execution ---

  async executeMigration(plan: MigrationPlan): Promise<void> {
    this.logger.info(
      { planId: plan.id, destination: plan.destinationChainId },
      'Executing migration plan',
    );

    plan.status = 'executing';

    try {
      // Step 1: Bridge capital from source to destination
      if (plan.sourceChainIds.length === 0) {
        this.logger.warn({ planId: plan.id }, 'No source chains with capital for migration');
        plan.status = 'exited';
        return;
      }

      const sourceChain = plan.sourceChainIds[0]!;

      const fromToken = USDC_ADDRESSES[sourceChain] ?? USDC_ADDRESSES[1]!;
      const toToken = USDC_ADDRESSES[plan.destinationChainId] ?? USDC_ADDRESSES[1]!;
      const fromAmount = Math.floor(plan.estimatedAmountUsd * 1_000_000).toString();

      // Get quote with integrator and slippage
      const quote = await this.connector.getQuote({
        fromChain: chainId(sourceChain),
        toChain: chainId(plan.destinationChainId),
        fromToken: tokenAddress(fromToken),
        toToken: tokenAddress(toToken),
        fromAmount,
        slippage: 0.005,
      });

      // Create transfer in store for tracking
      const transfer = this.store.createTransfer({
        txHash: null,
        fromChain: chainId(sourceChain),
        toChain: chainId(plan.destinationChainId),
        fromToken: tokenAddress(fromToken),
        toToken: tokenAddress(toToken),
        amount: BigInt(fromAmount),
        bridge: quote.tool,
        quoteData: quote,
      });

      this.logger.info(
        { transferId: transfer.id, bridge: quote.tool, planId: plan.id },
        'Bridge transfer created for migration',
      );

      // Poll status (in production, this would use backoff polling)
      // For now, mark as active — real polling is handled by the execution engine
      plan.status = 'active';

      this.logger.info(
        { planId: plan.id, destination: plan.destinationChainId },
        'Migration plan activated',
      );
    } catch (err) {
      this.logger.error(
        { planId: plan.id, error: (err as Error).message },
        'Migration execution failed',
      );
      plan.status = 'exited';
    }
  }

  // --- Step 5: Exit triggers ---

  checkExitTriggers(): void {
    for (const [planId, plan] of this.migrationPlans) {
      if (plan.status !== 'active') continue;

      const metrics = this.chainMetrics.get(plan.destinationChainId);
      if (!metrics) continue;

      // Check TVL outflow threshold
      if (metrics.tvlOutflowRate3d > this.config.tvlOutflowExitThreshold) {
        this.logger.warn(
          {
            planId,
            chainId: plan.destinationChainId,
            tvlOutflow: metrics.tvlOutflowRate3d,
            threshold: this.config.tvlOutflowExitThreshold,
          },
          'Exit trigger: TVL outflow exceeds threshold on destination chain',
        );

        plan.status = 'exit-triggered';
        this.triggerExit(plan).catch((err) => {
          this.logger.error(
            { planId, error: (err as Error).message },
            'Exit execution failed',
          );
        });
      }
    }
  }

  private checkTimeLimitExpiry(): void {
    const now = Date.now();

    for (const [planId, plan] of this.migrationPlans) {
      if (plan.status !== 'active') continue;

      const expiryMs = plan.createdAt + plan.timeLimitBarrierDays * 24 * 60 * 60 * 1000;
      if (now < expiryMs) continue;

      // Time-limit barrier expired — re-evaluate
      const score = this.healthScores.get(plan.destinationChainId);
      if (score && score.overallScore >= this.config.deploymentScoreThreshold) {
        // Health score still high — renew (keep as active, reset timer conceptually)
        this.logger.info(
          { planId, chainId: plan.destinationChainId, score: score.overallScore },
          'Time-limit barrier expired but chain still healthy — renewing',
        );
        // In a full implementation, we would update createdAt for a new barrier period
      } else {
        // Health has declined — trigger exit
        this.logger.warn(
          {
            planId,
            chainId: plan.destinationChainId,
            score: score?.overallScore ?? 0,
          },
          'Time-limit barrier expired and chain health declined — triggering exit',
        );

        plan.status = 'exit-triggered';
        this.triggerExit(plan).catch((err) => {
          this.logger.error(
            { planId, error: (err as Error).message },
            'Time-limit exit execution failed',
          );
        });
      }
    }
  }

  async triggerExit(plan: MigrationPlan): Promise<void> {
    this.logger.warn(
      {
        planId: plan.id,
        chainId: plan.destinationChainId,
        amountUsd: plan.estimatedAmountUsd,
        reason: 'ecosystem_health_deterioration',
      },
      'Triggering exit from deteriorating chain',
    );

    try {
      // Bridge capital back to first established chain (prefer Ethereum)
      const targetChain = this.config.establishedChains[0] ?? 1;

      const fromToken = USDC_ADDRESSES[plan.destinationChainId] ?? USDC_ADDRESSES[1]!;
      const toToken = USDC_ADDRESSES[targetChain] ?? USDC_ADDRESSES[1]!;
      const fromAmount = Math.floor(plan.estimatedAmountUsd * 1_000_000).toString();

      const quote = await this.connector.getQuote({
        fromChain: chainId(plan.destinationChainId),
        toChain: chainId(targetChain),
        fromToken: tokenAddress(fromToken),
        toToken: tokenAddress(toToken),
        fromAmount,
        slippage: 0.005,
      });

      // Create exit transfer
      const transfer = this.store.createTransfer({
        txHash: null,
        fromChain: chainId(plan.destinationChainId),
        toChain: chainId(targetChain),
        fromToken: tokenAddress(fromToken),
        toToken: tokenAddress(toToken),
        amount: BigInt(fromAmount),
        bridge: quote.tool,
        quoteData: quote,
      });

      this.logger.warn(
        {
          transferId: transfer.id,
          planId: plan.id,
          fromChain: plan.destinationChainId,
          toChain: targetChain,
        },
        'Exit bridge transfer created',
      );

      plan.status = 'exited';
    } catch (err) {
      this.logger.error(
        { planId: plan.id, error: (err as Error).message },
        'Failed to trigger exit — manual intervention may be required',
      );
      plan.status = 'exited';
    }
  }

  // --- Dashboard data exposure (AC #6) ---

  getChainRankings(): ChainHealthScore[] {
    // Recompute exposure for freshness
    const scores = Array.from(this.healthScores.values()).map((score) => ({
      ...score,
      cyrusExposurePercent: this.computeExposurePercent(score.chainId),
    }));

    // Sort by overall score descending
    scores.sort((a, b) => b.overallScore - a.overallScore);
    return scores;
  }

  getChainMetricsById(chainIdValue: number): ChainMetrics | null {
    return this.chainMetrics.get(chainIdValue) ?? null;
  }

  getActiveMigrations(): MigrationPlan[] {
    return Array.from(this.migrationPlans.values()).filter(
      (plan) => plan.status === 'active' || plan.status === 'executing',
    );
  }

  getMigrationHistory(): MigrationPlan[] {
    return Array.from(this.migrationPlans.values());
  }

  // --- Utility helpers ---

  private getChainName(chainIdValue: number): string {
    const names: Record<number, string> = {
      1: 'Ethereum',
      10: 'Optimism',
      56: 'BSC',
      137: 'Polygon',
      8453: 'Base',
      42161: 'Arbitrum',
      43114: 'Avalanche',
      59144: 'Linea',
      534352: 'Scroll',
      324: 'zkSync Era',
    };
    return names[chainIdValue] ?? `Chain ${chainIdValue}`;
  }

  // --- Test helpers ---

  getInternalMetrics(): Map<number, ChainMetrics> {
    return this.chainMetrics;
  }

  getInternalScores(): Map<number, ChainHealthScore> {
    return this.healthScores;
  }

  getInternalPlans(): Map<string, MigrationPlan> {
    return this.migrationPlans;
  }

  resetState(): void {
    this.chainMetrics.clear();
    this.healthScores.clear();
    this.migrationPlans.clear();
    this.protocolCountHistory.clear();
  }
}
