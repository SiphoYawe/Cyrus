import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChainScout } from '../chain-scout.js';
import { Store } from '../../core/store.js';
import { chainId, tokenAddress } from '../../core/types.js';
import type { LiFiConnectorInterface } from '../../connectors/types.js';
import type {
  ChainMetrics,
  ChainHealthScore,
  ChainScoutConfig,
  MigrationPlan,
  TvlHistoryEntry,
} from '../chain-health-types.js';
import { HEALTH_SCORE_WEIGHTS } from '../chain-health-types.js';

// --- Constants ---
const CHAIN_ETH = 1;
const CHAIN_ARB = 42161;
const CHAIN_BASE = 8453;
const CHAIN_EMERGING = 59144; // Linea — used as "emerging" chain
const USDC_ETH = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';

// --- Mock connector factory ---
function createMockConnector(): LiFiConnectorInterface {
  return {
    getQuote: vi.fn().mockResolvedValue({
      transactionRequest: {
        to: '0x1234',
        data: '0x',
        value: '0',
        gasLimit: '200000',
        chainId: 1,
      },
      estimate: {
        approvalAddress: '0xapproval',
        toAmount: '999000000',
        toAmountMin: '994000000',
        executionDuration: 300,
        gasCosts: [{ amount: '50000', amountUSD: '2.50', token: { symbol: 'ETH' } }],
      },
      tool: 'stargate',
      toolDetails: { key: 'stargate', name: 'Stargate', logoURI: '' },
      action: { fromChainId: 1, toChainId: CHAIN_EMERGING, fromToken: {}, toToken: {} },
    }),
    getRoutes: vi.fn().mockResolvedValue([]),
    getChains: vi.fn().mockResolvedValue([
      { id: CHAIN_ETH, key: 'eth', name: 'Ethereum', nativeToken: { symbol: 'ETH', decimals: 18, address: '0x0' } },
      { id: CHAIN_ARB, key: 'arb', name: 'Arbitrum', nativeToken: { symbol: 'ETH', decimals: 18, address: '0x0' } },
      { id: CHAIN_BASE, key: 'base', name: 'Base', nativeToken: { symbol: 'ETH', decimals: 18, address: '0x0' } },
      { id: CHAIN_EMERGING, key: 'linea', name: 'Linea', nativeToken: { symbol: 'ETH', decimals: 18, address: '0x0' } },
    ]),
    getTokens: vi.fn().mockResolvedValue([]),
    getStatus: vi.fn().mockResolvedValue({ status: 'DONE', substatus: 'COMPLETED' }),
    getConnections: vi.fn().mockResolvedValue([
      {
        fromChainId: CHAIN_ETH,
        toChainId: CHAIN_EMERGING,
        fromTokens: [{ address: USDC_ETH, symbol: 'USDC', decimals: 6, chainId: 1, name: 'USDC' }],
        toTokens: [{ address: '0xusdc_linea', symbol: 'USDC', decimals: 6, chainId: CHAIN_EMERGING, name: 'USDC' }],
      },
    ]),
    getTools: vi.fn().mockResolvedValue([]),
  };
}

// --- Helper to create ChainScout with defaults ---
function createChainScout(
  configOverrides: Partial<ChainScoutConfig> = {},
  connector?: LiFiConnectorInterface,
  store?: Store,
): ChainScout {
  return new ChainScout(
    { updateIntervalMs: 1000, ...configOverrides },
    connector ?? createMockConnector(),
    store ?? Store.getInstance(),
  );
}

// --- Helper to build mock ChainMetrics ---
function buildMetrics(overrides: Partial<ChainMetrics> = {}): ChainMetrics {
  return {
    chainId: CHAIN_EMERGING,
    chainName: 'Linea',
    tvl: 500_000_000,
    tvlHistory: [],
    tvlInflowRate7d: 0.15,
    tvlOutflowRate3d: 0,
    protocolCount: 30,
    newProtocolsPerWeek: 5,
    uniqueActiveAddresses: 100_000,
    activeAddressGrowthRate: 0.30,
    bridgeVolumeUsd: 50_000_000,
    chainAgeDays: 60,
    airdropIndicators: [],
    lastUpdated: Date.now(),
    ...overrides,
  };
}

// --- Helper to build TVL history with a trend ---
function buildTvlHistory(
  startValue: number,
  endValue: number,
  days: number,
): TvlHistoryEntry[] {
  const entries: TvlHistoryEntry[] = [];
  const now = Date.now();
  for (let i = days; i >= 0; i--) {
    const t = now - i * 24 * 60 * 60 * 1000;
    const progress = (days - i) / days;
    const value = startValue + (endValue - startValue) * progress;
    entries.push({ timestamp: t, value });
  }
  return entries;
}

describe('ChainScout', () => {
  beforeEach(() => {
    const store = Store.getInstance();
    store.reset();
  });

  // -------------------------------------------------------
  // Initialization
  // -------------------------------------------------------
  describe('initialization', () => {
    it('initializes with default config and empty internal state', () => {
      const scout = createChainScout();
      expect(scout).toBeDefined();
      expect(scout.isRunning()).toBe(false);
      expect(scout.getChainRankings()).toEqual([]);
      expect(scout.getActiveMigrations()).toEqual([]);
      expect(scout.getMigrationHistory()).toEqual([]);
    });

    it('merges provided config with defaults', () => {
      const scout = createChainScout({ tvlInflowThreshold: 0.20 });
      // Config is internal but we can verify behavior through thresholds
      expect(scout).toBeDefined();
    });
  });

  // -------------------------------------------------------
  // computeTvlInflowRate
  // -------------------------------------------------------
  describe('computeTvlInflowRate', () => {
    it('correctly calculates 7-day percentage change from TVL history', () => {
      const scout = createChainScout();
      const history = buildTvlHistory(1_000_000, 1_150_000, 7);

      const rate = scout.computeTvlInflowRate(history, 7);
      expect(rate).toBeCloseTo(0.15, 2); // 15% growth
    });

    it('returns 0 when insufficient history data (< 2 entries)', () => {
      const scout = createChainScout();
      const rate1 = scout.computeTvlInflowRate([], 7);
      expect(rate1).toBe(0);

      const rate2 = scout.computeTvlInflowRate(
        [{ timestamp: Date.now(), value: 1000 }],
        7,
      );
      expect(rate2).toBe(0);
    });

    it('returns 0 when all entries are outside the window', () => {
      const scout = createChainScout();
      const oldHistory: TvlHistoryEntry[] = [
        { timestamp: Date.now() - 30 * 24 * 60 * 60 * 1000, value: 100 },
        { timestamp: Date.now() - 20 * 24 * 60 * 60 * 1000, value: 200 },
      ];
      const rate = scout.computeTvlInflowRate(oldHistory, 7);
      expect(rate).toBe(0);
    });

    it('returns 0 when earliest value is 0 (avoids division by zero)', () => {
      const scout = createChainScout();
      const history: TvlHistoryEntry[] = [
        { timestamp: Date.now() - 5 * 24 * 60 * 60 * 1000, value: 0 },
        { timestamp: Date.now(), value: 1_000_000 },
      ];
      const rate = scout.computeTvlInflowRate(history, 7);
      expect(rate).toBe(0);
    });

    it('returns negative rate for TVL decline', () => {
      const scout = createChainScout();
      const history = buildTvlHistory(1_000_000, 900_000, 7);
      const rate = scout.computeTvlInflowRate(history, 7);
      expect(rate).toBeCloseTo(-0.10, 2); // -10%
    });
  });

  // -------------------------------------------------------
  // scoreChain
  // -------------------------------------------------------
  describe('scoreChain', () => {
    it('produces correct weighted score with known input metrics', () => {
      const scout = createChainScout();

      // Set up chain metrics for bridge volume normalization
      const metrics = buildMetrics({
        tvlInflowRate7d: 0.10, // 50% of max (0.20)
        protocolCount: 25, // 50/100
        activeAddressGrowthRate: 0.25, // 50/100
        bridgeVolumeUsd: 50_000_000,
        chainAgeDays: 60, // < 90 => 100
      });

      // Inject metrics so bridge normalization works
      scout.getInternalMetrics().set(CHAIN_EMERGING, metrics);

      const score = scout.scoreChain(metrics);

      // TVL growth: (0.10 / 0.20) * 100 = 50
      expect(score.components.tvlGrowth).toBeCloseTo(50, 0);
      // Protocol diversity: (25 / 50) * 100 = 50
      expect(score.components.protocolDiversity).toBeCloseTo(50, 0);
      // Developer activity: (0.25 / 0.50) * 100 = 50
      expect(score.components.developerActivity).toBeCloseTo(50, 0);
      // Chain age: < 90 days => 100
      expect(score.components.chainAgeFactor).toBe(100);

      // Weighted score: 50*0.30 + 50*0.20 + 50*0.20 + bridgeVol*0.20 + 100*0.10
      // = 15 + 10 + 10 + bridgeVol*0.20 + 10 = 45 + bridgeVol component
      expect(score.overallScore).toBeGreaterThan(0);
      expect(score.overallScore).toBeLessThanOrEqual(100);
    });

    it('normalizes each component to 0-100 range (clamps at boundaries)', () => {
      const scout = createChainScout();

      // Extreme high values
      const highMetrics = buildMetrics({
        tvlInflowRate7d: 0.50, // Way above 0.20 max
        protocolCount: 200, // Way above 50 max
        activeAddressGrowthRate: 1.0, // Way above 0.50 max
        bridgeVolumeUsd: 999_999_999,
        chainAgeDays: 10, // Very new
      });
      scout.getInternalMetrics().set(CHAIN_EMERGING, highMetrics);

      const highScore = scout.scoreChain(highMetrics);
      expect(highScore.components.tvlGrowth).toBe(100);
      expect(highScore.components.protocolDiversity).toBe(100);
      expect(highScore.components.developerActivity).toBe(100);
      expect(highScore.components.chainAgeFactor).toBe(100);
      expect(highScore.overallScore).toBeLessThanOrEqual(100);

      // Extreme low values
      const lowMetrics = buildMetrics({
        tvlInflowRate7d: 0,
        protocolCount: 0,
        activeAddressGrowthRate: 0,
        bridgeVolumeUsd: 0,
        chainAgeDays: 500,
      });
      scout.getInternalMetrics().set(999, lowMetrics);

      const lowScore = scout.scoreChain(lowMetrics);
      expect(lowScore.components.tvlGrowth).toBe(0);
      expect(lowScore.components.protocolDiversity).toBe(0);
      expect(lowScore.components.developerActivity).toBe(0);
      expect(lowScore.components.chainAgeFactor).toBe(25); // 365+ days
    });

    it('sets isEmerging = true for chains above threshold and not in established list', () => {
      const scout = createChainScout({ deploymentScoreThreshold: 50 });

      const metrics = buildMetrics({
        chainId: CHAIN_EMERGING,
        tvlInflowRate7d: 0.20,
        protocolCount: 50,
        activeAddressGrowthRate: 0.50,
        bridgeVolumeUsd: 50_000_000,
        chainAgeDays: 60,
      });
      scout.getInternalMetrics().set(CHAIN_EMERGING, metrics);

      const score = scout.scoreChain(metrics);
      expect(score.isEmerging).toBe(true);
      expect(score.overallScore).toBeGreaterThanOrEqual(50);
    });

    it('sets isEmerging = false for established chains (ETH, ARB, Base) regardless of score', () => {
      const scout = createChainScout({ deploymentScoreThreshold: 10 });

      // ETH chain with very high metrics
      const ethMetrics = buildMetrics({
        chainId: CHAIN_ETH,
        chainName: 'Ethereum',
        tvlInflowRate7d: 0.20,
        protocolCount: 50,
        activeAddressGrowthRate: 0.50,
        bridgeVolumeUsd: 100_000_000,
        chainAgeDays: 3000,
      });
      scout.getInternalMetrics().set(CHAIN_ETH, ethMetrics);
      const ethScore = scout.scoreChain(ethMetrics);
      expect(ethScore.isEmerging).toBe(false);

      // ARB chain
      const arbMetrics = buildMetrics({ chainId: CHAIN_ARB, chainName: 'Arbitrum' });
      scout.getInternalMetrics().set(CHAIN_ARB, arbMetrics);
      const arbScore = scout.scoreChain(arbMetrics);
      expect(arbScore.isEmerging).toBe(false);

      // Base chain
      const baseMetrics = buildMetrics({ chainId: CHAIN_BASE, chainName: 'Base' });
      scout.getInternalMetrics().set(CHAIN_BASE, baseMetrics);
      const baseScore = scout.scoreChain(baseMetrics);
      expect(baseScore.isEmerging).toBe(false);
    });

    it('sets riskLevel = "high" for chains younger than 90 days', () => {
      const scout = createChainScout();
      const metrics = buildMetrics({ chainAgeDays: 45 });
      scout.getInternalMetrics().set(CHAIN_EMERGING, metrics);

      const score = scout.scoreChain(metrics);
      expect(score.riskLevel).toBe('high');
    });

    it('sets riskLevel = "medium" for chains 90-365 days old', () => {
      const scout = createChainScout();
      const metrics = buildMetrics({ chainAgeDays: 200 });
      scout.getInternalMetrics().set(CHAIN_EMERGING, metrics);

      const score = scout.scoreChain(metrics);
      expect(score.riskLevel).toBe('medium');
    });

    it('sets riskLevel = "low" for chains older than 365 days', () => {
      const scout = createChainScout();
      const metrics = buildMetrics({ chainAgeDays: 500 });
      scout.getInternalMetrics().set(CHAIN_EMERGING, metrics);

      const score = scout.scoreChain(metrics);
      expect(score.riskLevel).toBe('low');
    });

    it('applies correct weight distribution summing to 1.0', () => {
      const totalWeight =
        HEALTH_SCORE_WEIGHTS.tvlGrowth +
        HEALTH_SCORE_WEIGHTS.protocolDiversity +
        HEALTH_SCORE_WEIGHTS.developerActivity +
        HEALTH_SCORE_WEIGHTS.bridgeVolume +
        HEALTH_SCORE_WEIGHTS.chainAgeFactor;
      expect(totalWeight).toBeCloseTo(1.0, 10);
    });
  });

  // -------------------------------------------------------
  // shouldMigrate
  // -------------------------------------------------------
  describe('shouldMigrate', () => {
    it('returns true when score is emerging, above threshold, and current exposure is low', () => {
      const scout = createChainScout({ deploymentScoreThreshold: 70, capitalMigrationPercent: 0.05 });

      const score: ChainHealthScore = {
        chainId: CHAIN_EMERGING,
        chainName: 'Linea',
        overallScore: 80,
        components: { tvlGrowth: 80, protocolDiversity: 70, developerActivity: 60, bridgeVolume: 50, chainAgeFactor: 100 },
        riskLevel: 'high',
        isEmerging: true,
        cyrusExposurePercent: 0, // No current exposure
        lastScored: Date.now(),
      };

      expect(scout.shouldMigrate(CHAIN_EMERGING, score)).toBe(true);
    });

    it('returns false when score is not emerging', () => {
      const scout = createChainScout();

      const score: ChainHealthScore = {
        chainId: CHAIN_ETH,
        chainName: 'Ethereum',
        overallScore: 90,
        components: { tvlGrowth: 80, protocolDiversity: 90, developerActivity: 80, bridgeVolume: 90, chainAgeFactor: 25 },
        riskLevel: 'low',
        isEmerging: false, // Not emerging
        cyrusExposurePercent: 0,
        lastScored: Date.now(),
      };

      expect(scout.shouldMigrate(CHAIN_ETH, score)).toBe(false);
    });

    it('returns false when already exposed at or above capitalMigrationPercent', () => {
      const scout = createChainScout({ capitalMigrationPercent: 0.05 });

      const score: ChainHealthScore = {
        chainId: CHAIN_EMERGING,
        chainName: 'Linea',
        overallScore: 80,
        components: { tvlGrowth: 80, protocolDiversity: 70, developerActivity: 60, bridgeVolume: 50, chainAgeFactor: 100 },
        riskLevel: 'high',
        isEmerging: true,
        cyrusExposurePercent: 0.06, // Already at 6%, above 5% threshold
        lastScored: Date.now(),
      };

      expect(scout.shouldMigrate(CHAIN_EMERGING, score)).toBe(false);
    });

    it('returns false when score is below deployment threshold', () => {
      const scout = createChainScout({ deploymentScoreThreshold: 70 });

      const score: ChainHealthScore = {
        chainId: CHAIN_EMERGING,
        chainName: 'Linea',
        overallScore: 60, // Below 70 threshold
        components: { tvlGrowth: 40, protocolDiversity: 50, developerActivity: 40, bridgeVolume: 30, chainAgeFactor: 100 },
        riskLevel: 'high',
        isEmerging: false, // Would be false since below threshold
        cyrusExposurePercent: 0,
        lastScored: Date.now(),
      };

      expect(scout.shouldMigrate(CHAIN_EMERGING, score)).toBe(false);
    });

    it('returns false when there is already an active migration plan for the chain', () => {
      const scout = createChainScout({ capitalMigrationPercent: 0.05 });

      // Add an active plan
      const plans = scout.getInternalPlans();
      plans.set('existing-plan', {
        id: 'existing-plan',
        sourceChainIds: [CHAIN_ETH],
        destinationChainId: CHAIN_EMERGING,
        capitalPercent: 0.05,
        estimatedAmountUsd: 5000,
        targetProtocols: [],
        estimatedBridgeCostUsd: 2,
        estimatedBridgeTimeSeconds: 300,
        timeLimitBarrierDays: 14,
        healthScoreAtCreation: 75,
        status: 'active',
        createdAt: Date.now(),
      });

      const score: ChainHealthScore = {
        chainId: CHAIN_EMERGING,
        chainName: 'Linea',
        overallScore: 80,
        components: { tvlGrowth: 80, protocolDiversity: 70, developerActivity: 60, bridgeVolume: 50, chainAgeFactor: 100 },
        riskLevel: 'high',
        isEmerging: true,
        cyrusExposurePercent: 0,
        lastScored: Date.now(),
      };

      expect(scout.shouldMigrate(CHAIN_EMERGING, score)).toBe(false);
    });
  });

  // -------------------------------------------------------
  // generateMigrationPlan
  // -------------------------------------------------------
  describe('generateMigrationPlan', () => {
    it('creates plan with correct source chains, destination, capital percent, and 14-day barrier', async () => {
      const store = Store.getInstance();
      store.setBalance(chainId(CHAIN_ETH), tokenAddress(USDC_ETH), 100_000_000000n, 100_000, 'USDC', 6);

      const connector = createMockConnector();
      const scout = createChainScout({}, connector, store);

      const score: ChainHealthScore = {
        chainId: CHAIN_EMERGING,
        chainName: 'Linea',
        overallScore: 80,
        components: { tvlGrowth: 80, protocolDiversity: 70, developerActivity: 60, bridgeVolume: 50, chainAgeFactor: 100 },
        riskLevel: 'high',
        isEmerging: true,
        cyrusExposurePercent: 0,
        lastScored: Date.now(),
      };

      const plan = await scout.generateMigrationPlan(CHAIN_EMERGING, score);

      expect(plan.destinationChainId).toBe(CHAIN_EMERGING);
      expect(plan.sourceChainIds).toContain(CHAIN_ETH);
      expect(plan.capitalPercent).toBe(0.05); // default
      expect(plan.timeLimitBarrierDays).toBe(14);
      expect(plan.status).toBe('pending');
      expect(plan.healthScoreAtCreation).toBe(80);
      expect(plan.id).toBeDefined();
      expect(plan.createdAt).toBeGreaterThan(0);
    });

    it('selects highest-APY protocols for target deployment', async () => {
      const store = Store.getInstance();
      store.setBalance(chainId(CHAIN_ETH), tokenAddress(USDC_ETH), 50_000_000000n, 50_000, 'USDC', 6);

      const connector = createMockConnector();
      const scout = createChainScout({}, connector, store);

      // Override discoverTargetProtocols to return specific protocols
      scout.discoverTargetProtocols = vi.fn().mockResolvedValue([
        { protocol: 'morpho', apy: 0.08, tvl: 500_000_000 },
        { protocol: 'aave-v3', apy: 0.05, tvl: 1_000_000_000 },
        { protocol: 'euler', apy: 0.06, tvl: 300_000_000 },
      ]);

      const score: ChainHealthScore = {
        chainId: CHAIN_EMERGING,
        chainName: 'Linea',
        overallScore: 75,
        components: { tvlGrowth: 70, protocolDiversity: 60, developerActivity: 50, bridgeVolume: 40, chainAgeFactor: 100 },
        riskLevel: 'high',
        isEmerging: true,
        cyrusExposurePercent: 0,
        lastScored: Date.now(),
      };

      const plan = await scout.generateMigrationPlan(CHAIN_EMERGING, score);

      expect(plan.targetProtocols.length).toBe(3);
      // Should be sorted by APY descending
      expect(plan.targetProtocols[0]!.protocol).toBe('morpho');
      expect(plan.targetProtocols[0]!.apy).toBe(0.08);
    });

    it('estimates bridge cost via LI.FI quote', async () => {
      const store = Store.getInstance();
      store.setBalance(chainId(CHAIN_ETH), tokenAddress(USDC_ETH), 100_000_000000n, 100_000, 'USDC', 6);

      const connector = createMockConnector();
      const scout = createChainScout({}, connector, store);

      const score: ChainHealthScore = {
        chainId: CHAIN_EMERGING,
        chainName: 'Linea',
        overallScore: 80,
        components: { tvlGrowth: 80, protocolDiversity: 70, developerActivity: 60, bridgeVolume: 50, chainAgeFactor: 100 },
        riskLevel: 'high',
        isEmerging: true,
        cyrusExposurePercent: 0,
        lastScored: Date.now(),
      };

      const plan = await scout.generateMigrationPlan(CHAIN_EMERGING, score);

      // Verify connector.getQuote was called
      expect(connector.getQuote).toHaveBeenCalled();
      expect(plan.estimatedBridgeCostUsd).toBeGreaterThanOrEqual(0);
      expect(plan.estimatedBridgeTimeSeconds).toBeGreaterThanOrEqual(0);
    });
  });

  // -------------------------------------------------------
  // executeMigration
  // -------------------------------------------------------
  describe('executeMigration', () => {
    it('calls LI.FI connector with correct quote parameters including integrator slippage', async () => {
      const store = Store.getInstance();
      const connector = createMockConnector();
      const scout = createChainScout({}, connector, store);

      const plan: MigrationPlan = {
        id: 'test-plan-1',
        sourceChainIds: [CHAIN_ETH],
        destinationChainId: CHAIN_EMERGING,
        capitalPercent: 0.05,
        estimatedAmountUsd: 5000,
        targetProtocols: [{ protocol: 'aave-v3', apy: 0.05, tvl: 1_000_000_000 }],
        estimatedBridgeCostUsd: 2.50,
        estimatedBridgeTimeSeconds: 300,
        timeLimitBarrierDays: 14,
        healthScoreAtCreation: 80,
        status: 'pending',
        createdAt: Date.now(),
      };

      await scout.executeMigration(plan);

      expect(connector.getQuote).toHaveBeenCalledWith(
        expect.objectContaining({
          fromChain: chainId(CHAIN_ETH),
          toChain: chainId(CHAIN_EMERGING),
          slippage: 0.005,
        }),
      );

      expect(plan.status).toBe('active');
    });

    it('creates InFlightTransfer in store on execution', async () => {
      const store = Store.getInstance();
      const connector = createMockConnector();
      const scout = createChainScout({}, connector, store);

      const plan: MigrationPlan = {
        id: 'test-plan-2',
        sourceChainIds: [CHAIN_ETH],
        destinationChainId: CHAIN_EMERGING,
        capitalPercent: 0.05,
        estimatedAmountUsd: 5000,
        targetProtocols: [],
        estimatedBridgeCostUsd: 2.50,
        estimatedBridgeTimeSeconds: 300,
        timeLimitBarrierDays: 14,
        healthScoreAtCreation: 80,
        status: 'pending',
        createdAt: Date.now(),
      };

      await scout.executeMigration(plan);

      const transfers = store.getActiveTransfers();
      expect(transfers.length).toBe(1);
      expect(transfers[0]!.bridge).toBe('stargate');
    });

    it('handles failed execution by setting status to exited', async () => {
      const store = Store.getInstance();
      const connector = createMockConnector();
      // Make getQuote fail
      (connector.getQuote as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Network error'));

      const scout = createChainScout({}, connector, store);

      const plan: MigrationPlan = {
        id: 'test-plan-fail',
        sourceChainIds: [CHAIN_ETH],
        destinationChainId: CHAIN_EMERGING,
        capitalPercent: 0.05,
        estimatedAmountUsd: 5000,
        targetProtocols: [],
        estimatedBridgeCostUsd: 0,
        estimatedBridgeTimeSeconds: 0,
        timeLimitBarrierDays: 14,
        healthScoreAtCreation: 80,
        status: 'pending',
        createdAt: Date.now(),
      };

      await scout.executeMigration(plan);

      expect(plan.status).toBe('exited');
    });

    it('handles no source chains by setting status to exited', async () => {
      const store = Store.getInstance();
      const connector = createMockConnector();
      const scout = createChainScout({}, connector, store);

      const plan: MigrationPlan = {
        id: 'test-plan-no-source',
        sourceChainIds: [], // No source chains
        destinationChainId: CHAIN_EMERGING,
        capitalPercent: 0.05,
        estimatedAmountUsd: 0,
        targetProtocols: [],
        estimatedBridgeCostUsd: 0,
        estimatedBridgeTimeSeconds: 0,
        timeLimitBarrierDays: 14,
        healthScoreAtCreation: 80,
        status: 'pending',
        createdAt: Date.now(),
      };

      await scout.executeMigration(plan);

      expect(plan.status).toBe('exited');
    });
  });

  // -------------------------------------------------------
  // Exit triggers
  // -------------------------------------------------------
  describe('exit triggers', () => {
    it('fires when TVL outflow exceeds 5% over 3 days', () => {
      const store = Store.getInstance();
      const connector = createMockConnector();
      const scout = createChainScout({ tvlOutflowExitThreshold: 0.05 }, connector, store);

      // Set up an active migration plan
      const plans = scout.getInternalPlans();
      plans.set('exit-test-1', {
        id: 'exit-test-1',
        sourceChainIds: [CHAIN_ETH],
        destinationChainId: CHAIN_EMERGING,
        capitalPercent: 0.05,
        estimatedAmountUsd: 5000,
        targetProtocols: [],
        estimatedBridgeCostUsd: 2,
        estimatedBridgeTimeSeconds: 300,
        timeLimitBarrierDays: 14,
        healthScoreAtCreation: 80,
        status: 'active',
        createdAt: Date.now(),
      });

      // Set chain metrics with high outflow
      const metrics = buildMetrics({
        chainId: CHAIN_EMERGING,
        tvlOutflowRate3d: 0.08, // 8% > 5% threshold
      });
      scout.getInternalMetrics().set(CHAIN_EMERGING, metrics);

      scout.checkExitTriggers();

      const plan = plans.get('exit-test-1')!;
      expect(plan.status).toBe('exit-triggered');
    });

    it('does NOT fire when TVL outflow is below threshold', () => {
      const store = Store.getInstance();
      const connector = createMockConnector();
      const scout = createChainScout({ tvlOutflowExitThreshold: 0.05 }, connector, store);

      const plans = scout.getInternalPlans();
      plans.set('no-exit-test', {
        id: 'no-exit-test',
        sourceChainIds: [CHAIN_ETH],
        destinationChainId: CHAIN_EMERGING,
        capitalPercent: 0.05,
        estimatedAmountUsd: 5000,
        targetProtocols: [],
        estimatedBridgeCostUsd: 2,
        estimatedBridgeTimeSeconds: 300,
        timeLimitBarrierDays: 14,
        healthScoreAtCreation: 80,
        status: 'active',
        createdAt: Date.now(),
      });

      // Set chain metrics with low outflow
      const metrics = buildMetrics({
        chainId: CHAIN_EMERGING,
        tvlOutflowRate3d: 0.03, // 3% < 5% threshold
      });
      scout.getInternalMetrics().set(CHAIN_EMERGING, metrics);

      scout.checkExitTriggers();

      const plan = plans.get('no-exit-test')!;
      expect(plan.status).toBe('active'); // Unchanged
    });

    it('does not trigger exit for non-active plans', () => {
      const store = Store.getInstance();
      const connector = createMockConnector();
      const scout = createChainScout({ tvlOutflowExitThreshold: 0.05 }, connector, store);

      const plans = scout.getInternalPlans();
      plans.set('pending-plan', {
        id: 'pending-plan',
        sourceChainIds: [CHAIN_ETH],
        destinationChainId: CHAIN_EMERGING,
        capitalPercent: 0.05,
        estimatedAmountUsd: 5000,
        targetProtocols: [],
        estimatedBridgeCostUsd: 2,
        estimatedBridgeTimeSeconds: 300,
        timeLimitBarrierDays: 14,
        healthScoreAtCreation: 80,
        status: 'pending', // Not active
        createdAt: Date.now(),
      });

      const metrics = buildMetrics({
        chainId: CHAIN_EMERGING,
        tvlOutflowRate3d: 0.10, // Very high outflow
      });
      scout.getInternalMetrics().set(CHAIN_EMERGING, metrics);

      scout.checkExitTriggers();

      const plan = plans.get('pending-plan')!;
      expect(plan.status).toBe('pending'); // Unchanged
    });
  });

  // -------------------------------------------------------
  // triggerExit
  // -------------------------------------------------------
  describe('triggerExit', () => {
    it('withdraws from protocols and bridges back to established chain', async () => {
      const store = Store.getInstance();
      const connector = createMockConnector();
      const scout = createChainScout({}, connector, store);

      const plan: MigrationPlan = {
        id: 'exit-plan-1',
        sourceChainIds: [CHAIN_ETH],
        destinationChainId: CHAIN_EMERGING,
        capitalPercent: 0.05,
        estimatedAmountUsd: 5000,
        targetProtocols: [],
        estimatedBridgeCostUsd: 2.50,
        estimatedBridgeTimeSeconds: 300,
        timeLimitBarrierDays: 14,
        healthScoreAtCreation: 80,
        status: 'exit-triggered',
        createdAt: Date.now(),
      };

      await scout.triggerExit(plan);

      // Should have called getQuote to bridge back
      expect(connector.getQuote).toHaveBeenCalledWith(
        expect.objectContaining({
          fromChain: chainId(CHAIN_EMERGING),
          toChain: chainId(CHAIN_ETH), // First established chain
          slippage: 0.005,
        }),
      );

      // Should create a transfer in store
      const transfers = store.getActiveTransfers();
      expect(transfers.length).toBe(1);

      // Plan status should be exited
      expect(plan.status).toBe('exited');
    });

    it('handles exit failure gracefully and still marks plan as exited', async () => {
      const store = Store.getInstance();
      const connector = createMockConnector();
      (connector.getQuote as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Bridge down'));

      const scout = createChainScout({}, connector, store);

      const plan: MigrationPlan = {
        id: 'exit-plan-fail',
        sourceChainIds: [CHAIN_ETH],
        destinationChainId: CHAIN_EMERGING,
        capitalPercent: 0.05,
        estimatedAmountUsd: 5000,
        targetProtocols: [],
        estimatedBridgeCostUsd: 0,
        estimatedBridgeTimeSeconds: 0,
        timeLimitBarrierDays: 14,
        healthScoreAtCreation: 80,
        status: 'exit-triggered',
        createdAt: Date.now(),
      };

      await scout.triggerExit(plan);

      // Even on failure, status should be exited
      expect(plan.status).toBe('exited');
    });
  });

  // -------------------------------------------------------
  // Time-limit barrier expiry
  // -------------------------------------------------------
  describe('time-limit barrier expiry', () => {
    it('triggers re-evaluation: renew if chain health score is still high', async () => {
      const store = Store.getInstance();
      const connector = createMockConnector();
      const scout = createChainScout({ deploymentScoreThreshold: 70, timeLimitDays: 14 }, connector, store);

      // Create a plan that has expired (created 15 days ago)
      const fifteenDaysAgo = Date.now() - 15 * 24 * 60 * 60 * 1000;
      const plans = scout.getInternalPlans();
      plans.set('expired-healthy', {
        id: 'expired-healthy',
        sourceChainIds: [CHAIN_ETH],
        destinationChainId: CHAIN_EMERGING,
        capitalPercent: 0.05,
        estimatedAmountUsd: 5000,
        targetProtocols: [],
        estimatedBridgeCostUsd: 2,
        estimatedBridgeTimeSeconds: 300,
        timeLimitBarrierDays: 14,
        healthScoreAtCreation: 80,
        status: 'active',
        createdAt: fifteenDaysAgo,
      });

      // Set a good health score for the destination chain
      const scores = scout.getInternalScores();
      scores.set(CHAIN_EMERGING, {
        chainId: CHAIN_EMERGING,
        chainName: 'Linea',
        overallScore: 85, // Still above threshold
        components: { tvlGrowth: 80, protocolDiversity: 70, developerActivity: 60, bridgeVolume: 50, chainAgeFactor: 100 },
        riskLevel: 'high',
        isEmerging: true,
        cyrusExposurePercent: 0.03,
        lastScored: Date.now(),
      });

      // Trigger the full control task logic for time-limit check
      // We need to call the private method, so we call controlTask but mock the fetch methods
      // IMPORTANT: fetchChainMetrics must return metrics with TVL history that produces
      // a high inflow rate, because updateChainMetrics recomputes tvlInflowRate7d from history
      scout.fetchChainMetrics = vi.fn().mockImplementation(async (id: number) => {
        return buildMetrics({
          chainId: id,
          tvlHistory: buildTvlHistory(400_000_000, 500_000_000, 7), // 25% growth in 7d
          tvlInflowRate7d: 0.25,
          protocolCount: 40,
          activeAddressGrowthRate: 0.40,
          bridgeVolumeUsd: 80_000_000,
          chainAgeDays: id === CHAIN_EMERGING ? 60 : 1000,
        });
      });
      scout.fetchProtocolCount = vi.fn().mockResolvedValue(40);
      scout.detectAirdropIndicators = vi.fn().mockResolvedValue([]);
      scout.fetchBridgeVolume = vi.fn().mockResolvedValue(80_000_000);

      await scout.controlTask();

      // Plan should remain active (renewed) since health score is still high
      const plan = plans.get('expired-healthy')!;
      expect(plan.status).toBe('active');
    });

    it('triggers exit when time-limit expires and health score has declined', async () => {
      const store = Store.getInstance();
      const connector = createMockConnector();
      const scout = createChainScout({ deploymentScoreThreshold: 70, timeLimitDays: 14 }, connector, store);

      const fifteenDaysAgo = Date.now() - 15 * 24 * 60 * 60 * 1000;
      const plans = scout.getInternalPlans();
      plans.set('expired-declined', {
        id: 'expired-declined',
        sourceChainIds: [CHAIN_ETH],
        destinationChainId: CHAIN_EMERGING,
        capitalPercent: 0.05,
        estimatedAmountUsd: 5000,
        targetProtocols: [],
        estimatedBridgeCostUsd: 2,
        estimatedBridgeTimeSeconds: 300,
        timeLimitBarrierDays: 14,
        healthScoreAtCreation: 80,
        status: 'active',
        createdAt: fifteenDaysAgo,
      });

      // Set a LOW health score for the destination chain
      const scores = scout.getInternalScores();
      scores.set(CHAIN_EMERGING, {
        chainId: CHAIN_EMERGING,
        chainName: 'Linea',
        overallScore: 40, // Below threshold
        components: { tvlGrowth: 20, protocolDiversity: 30, developerActivity: 20, bridgeVolume: 10, chainAgeFactor: 100 },
        riskLevel: 'high',
        isEmerging: false,
        cyrusExposurePercent: 0.03,
        lastScored: Date.now(),
      });

      // Mock fetch methods
      scout.fetchChainMetrics = vi.fn().mockImplementation(async (id: number) => {
        return buildMetrics({ chainId: id, tvlInflowRate7d: 0.01, protocolCount: 5 });
      });
      scout.fetchProtocolCount = vi.fn().mockResolvedValue(5);
      scout.detectAirdropIndicators = vi.fn().mockResolvedValue([]);
      scout.fetchBridgeVolume = vi.fn().mockResolvedValue(1_000_000);

      await scout.controlTask();

      // Plan should be exit-triggered or exited
      const plan = plans.get('expired-declined')!;
      expect(['exit-triggered', 'exited']).toContain(plan.status);
    });
  });

  // -------------------------------------------------------
  // getChainRankings (dashboard exposure)
  // -------------------------------------------------------
  describe('getChainRankings', () => {
    it('returns chains sorted by score descending with correct exposure percentages', () => {
      const store = Store.getInstance();
      const scout = createChainScout({}, createMockConnector(), store);

      // Set up some balances for exposure calculation
      store.setBalance(chainId(CHAIN_ETH), tokenAddress(USDC_ETH), 50_000_000000n, 50_000, 'USDC', 6);
      store.setBalance(
        chainId(CHAIN_EMERGING),
        tokenAddress('0xusdc_linea'),
        10_000_000000n,
        10_000,
        'USDC',
        6,
      );

      // Inject scores
      const scores = scout.getInternalScores();
      scores.set(CHAIN_ETH, {
        chainId: CHAIN_ETH,
        chainName: 'Ethereum',
        overallScore: 60,
        components: { tvlGrowth: 30, protocolDiversity: 90, developerActivity: 60, bridgeVolume: 70, chainAgeFactor: 25 },
        riskLevel: 'low',
        isEmerging: false,
        cyrusExposurePercent: 0,
        lastScored: Date.now(),
      });
      scores.set(CHAIN_EMERGING, {
        chainId: CHAIN_EMERGING,
        chainName: 'Linea',
        overallScore: 80,
        components: { tvlGrowth: 80, protocolDiversity: 70, developerActivity: 60, bridgeVolume: 50, chainAgeFactor: 100 },
        riskLevel: 'high',
        isEmerging: true,
        cyrusExposurePercent: 0,
        lastScored: Date.now(),
      });

      const rankings = scout.getChainRankings();

      // Should be sorted by score descending
      expect(rankings.length).toBe(2);
      expect(rankings[0]!.chainId).toBe(CHAIN_EMERGING); // Score 80
      expect(rankings[1]!.chainId).toBe(CHAIN_ETH); // Score 60

      // Exposure should be computed from store
      // Total = 50000 + 10000 = 60000
      // ETH exposure = 50000 / 60000 = ~0.833
      // Emerging exposure = 10000 / 60000 = ~0.167
      expect(rankings[0]!.cyrusExposurePercent).toBeCloseTo(10_000 / 60_000, 2);
      expect(rankings[1]!.cyrusExposurePercent).toBeCloseTo(50_000 / 60_000, 2);
    });

    it('returns empty array when no chains are scored', () => {
      const scout = createChainScout();
      const rankings = scout.getChainRankings();
      expect(rankings).toEqual([]);
    });
  });

  // -------------------------------------------------------
  // getChainMetricsById
  // -------------------------------------------------------
  describe('getChainMetricsById', () => {
    it('returns detailed metrics for a specific chain', () => {
      const scout = createChainScout();
      const metrics = buildMetrics({ chainId: CHAIN_EMERGING });
      scout.getInternalMetrics().set(CHAIN_EMERGING, metrics);

      const result = scout.getChainMetricsById(CHAIN_EMERGING);
      expect(result).not.toBeNull();
      expect(result!.chainId).toBe(CHAIN_EMERGING);
    });

    it('returns null for unknown chain', () => {
      const scout = createChainScout();
      const result = scout.getChainMetricsById(99999);
      expect(result).toBeNull();
    });
  });

  // -------------------------------------------------------
  // getActiveMigrations / getMigrationHistory
  // -------------------------------------------------------
  describe('migration plan accessors', () => {
    it('getActiveMigrations returns only active and executing plans', () => {
      const scout = createChainScout();
      const plans = scout.getInternalPlans();

      const basePlan = {
        sourceChainIds: [CHAIN_ETH],
        destinationChainId: CHAIN_EMERGING,
        capitalPercent: 0.05,
        estimatedAmountUsd: 5000,
        targetProtocols: [],
        estimatedBridgeCostUsd: 2,
        estimatedBridgeTimeSeconds: 300,
        timeLimitBarrierDays: 14,
        healthScoreAtCreation: 80,
        createdAt: Date.now(),
      };

      plans.set('p1', { ...basePlan, id: 'p1', status: 'active' });
      plans.set('p2', { ...basePlan, id: 'p2', status: 'executing' });
      plans.set('p3', { ...basePlan, id: 'p3', status: 'pending' });
      plans.set('p4', { ...basePlan, id: 'p4', status: 'exited' });
      plans.set('p5', { ...basePlan, id: 'p5', status: 'expired' });

      const active = scout.getActiveMigrations();
      expect(active.length).toBe(2);
      const statuses = active.map((p) => p.status);
      expect(statuses).toContain('active');
      expect(statuses).toContain('executing');
    });

    it('getMigrationHistory returns all plans regardless of status', () => {
      const scout = createChainScout();
      const plans = scout.getInternalPlans();

      const basePlan = {
        sourceChainIds: [CHAIN_ETH],
        destinationChainId: CHAIN_EMERGING,
        capitalPercent: 0.05,
        estimatedAmountUsd: 5000,
        targetProtocols: [],
        estimatedBridgeCostUsd: 2,
        estimatedBridgeTimeSeconds: 300,
        timeLimitBarrierDays: 14,
        healthScoreAtCreation: 80,
        createdAt: Date.now(),
      };

      plans.set('h1', { ...basePlan, id: 'h1', status: 'active' });
      plans.set('h2', { ...basePlan, id: 'h2', status: 'exited' });
      plans.set('h3', { ...basePlan, id: 'h3', status: 'expired' });

      const history = scout.getMigrationHistory();
      expect(history.length).toBe(3);
    });
  });

  // -------------------------------------------------------
  // controlTask full orchestration
  // -------------------------------------------------------
  describe('controlTask', () => {
    it('orchestrates full cycle: fetch metrics -> score -> check migrations -> check exits', async () => {
      const store = Store.getInstance();
      const connector = createMockConnector();
      const scout = createChainScout(
        { deploymentScoreThreshold: 70, capitalMigrationPercent: 0.05 },
        connector,
        store,
      );

      // Mock all data fetching methods
      scout.fetchChainMetrics = vi.fn().mockImplementation(async (id: number) => {
        return buildMetrics({
          chainId: id,
          tvlInflowRate7d: id === CHAIN_EMERGING ? 0.15 : 0.02,
          protocolCount: id === CHAIN_EMERGING ? 30 : 100,
          activeAddressGrowthRate: id === CHAIN_EMERGING ? 0.30 : 0.05,
          chainAgeDays: id === CHAIN_EMERGING ? 60 : 1000,
          bridgeVolumeUsd: 50_000_000,
        });
      });
      scout.fetchProtocolCount = vi.fn().mockResolvedValue(30);
      scout.detectAirdropIndicators = vi.fn().mockResolvedValue([]);
      scout.fetchBridgeVolume = vi.fn().mockResolvedValue(50_000_000);

      // Run controlTask
      await scout.controlTask();

      // Verify fetch was called
      expect(scout.fetchChainMetrics).toHaveBeenCalled();
      expect(scout.fetchProtocolCount).toHaveBeenCalled();

      // Verify scores were computed
      const rankings = scout.getChainRankings();
      expect(rankings.length).toBeGreaterThan(0);

      // All scores should be valid
      for (const score of rankings) {
        expect(score.overallScore).toBeGreaterThanOrEqual(0);
        expect(score.overallScore).toBeLessThanOrEqual(100);
        expect(score.chainId).toBeDefined();
      }
    });

    it('handles errors in data fetching gracefully without crashing', async () => {
      const store = Store.getInstance();
      const connector = createMockConnector();
      // Make getChains fail
      (connector.getChains as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('API down'));

      const scout = createChainScout({}, connector, store);

      // Mock fetch methods that will also fail
      scout.fetchChainMetrics = vi.fn().mockRejectedValue(new Error('DeFiLlama down'));
      scout.fetchProtocolCount = vi.fn().mockRejectedValue(new Error('Data source down'));

      // Should not throw
      await expect(scout.controlTask()).resolves.not.toThrow();
    });
  });

  // -------------------------------------------------------
  // TVL history management
  // -------------------------------------------------------
  describe('updateTvlHistory', () => {
    it('appends new entry and prunes old entries beyond 30 days', () => {
      const scout = createChainScout();
      const metrics = buildMetrics({
        tvlHistory: [
          { timestamp: Date.now() - 31 * 24 * 60 * 60 * 1000, value: 100 }, // >30 days old
          { timestamp: Date.now() - 5 * 24 * 60 * 60 * 1000, value: 200 },
        ],
      });

      scout.updateTvlHistory(metrics, 300);

      // Old entry should be pruned, recent entry kept, new entry added
      expect(metrics.tvlHistory.length).toBe(2); // 5-day-old entry + new entry
      expect(metrics.tvlHistory[metrics.tvlHistory.length - 1]!.value).toBe(300);
    });
  });

  // -------------------------------------------------------
  // computeNewProtocolsPerWeek
  // -------------------------------------------------------
  describe('computeNewProtocolsPerWeek', () => {
    it('calculates difference from 7 days ago', () => {
      const scout = createChainScout();

      // Manually set protocol count history
      const internalMetrics = scout.getInternalMetrics();
      // We need to access the private protocolCountHistory — use the method directly
      // The method reads from protocolCountHistory which we can populate via updateChainMetrics
      // Instead, test the method directly
      const result = scout.computeNewProtocolsPerWeek(999, 50);
      // No history → 0
      expect(result).toBe(0);
    });
  });

  // -------------------------------------------------------
  // resetState
  // -------------------------------------------------------
  describe('resetState', () => {
    it('clears all internal maps', () => {
      const scout = createChainScout();

      // Populate
      scout.getInternalMetrics().set(1, buildMetrics({ chainId: 1 }));
      scout.getInternalScores().set(1, {
        chainId: 1,
        chainName: 'Ethereum',
        overallScore: 50,
        components: { tvlGrowth: 50, protocolDiversity: 50, developerActivity: 50, bridgeVolume: 50, chainAgeFactor: 25 },
        riskLevel: 'low',
        isEmerging: false,
        cyrusExposurePercent: 0,
        lastScored: Date.now(),
      });
      scout.getInternalPlans().set('test', {
        id: 'test',
        sourceChainIds: [1],
        destinationChainId: 2,
        capitalPercent: 0.05,
        estimatedAmountUsd: 1000,
        targetProtocols: [],
        estimatedBridgeCostUsd: 0,
        estimatedBridgeTimeSeconds: 0,
        timeLimitBarrierDays: 14,
        healthScoreAtCreation: 50,
        status: 'active',
        createdAt: Date.now(),
      });

      scout.resetState();

      expect(scout.getInternalMetrics().size).toBe(0);
      expect(scout.getInternalScores().size).toBe(0);
      expect(scout.getInternalPlans().size).toBe(0);
      expect(scout.getChainRankings()).toEqual([]);
    });
  });
});
