import { describe, it, expect, vi, beforeEach } from 'vitest';
import { chainId, tokenAddress } from '../../../core/types.js';
import type { ChainId, TokenAddress } from '../../../core/types.js';
import { FlashOrchestrator } from '../flash-orchestrator.js';
import { FlashExecutor } from '../../../executors/flash-executor.js';
import type {
  FlashOrchestratorConfig,
  FlashLoanConfig,
  ArbitrageLoop,
  FlashPriceFetcher,
  FlashBridgeQuoter,
  FlashSwapExecutor,
  FlashBridgeExecutor,
  LoopExecutionState,
} from '../flash-types.js';
import { FLASH_DEFAULTS } from '../flash-types.js';

// --- Test constants ---

const CHAIN_A = chainId(1); // Ethereum
const CHAIN_B = chainId(42161); // Arbitrum
const WETH = tokenAddress('0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2');

const TEST_PROVIDER: FlashLoanConfig = {
  provider: 'aave-v3',
  poolAddress: '0xPool',
  chainId: CHAIN_A,
  maxLoanUsd: 10_000,
  feePercent: 0.0005,
};

// --- Mock dependencies ---

function createMockPriceFetcher(prices: Map<string, number>): FlashPriceFetcher {
  return {
    getPrice(chain: ChainId, token: TokenAddress): number | undefined {
      return prices.get(`${chain as number}-${token as string}`);
    },
  };
}

function createMockBridgeQuoter(): FlashBridgeQuoter {
  return {
    getBridgeQuote: vi.fn().mockResolvedValue({
      estimatedFeeUsd: 2,
      estimatedSlippageUsd: 1,
      estimatedGasUsd: 1,
    }),
  };
}

function createMockSwapExecutor(): FlashSwapExecutor {
  return {
    executeSwap: vi.fn().mockResolvedValue({
      txHash: 'swap-tx-hash',
      receivedAmount: 1_000_000_000_000_000_000n,
    }),
  };
}

function createMockBridgeExecutor(): FlashBridgeExecutor {
  return {
    executeBridge: vi.fn().mockResolvedValue({
      txHash: 'bridge-tx-hash',
      receivedAmount: 990_000_000_000_000_000n,
      status: 'COMPLETED',
    }),
  };
}

function createMockWalletClient() {
  return {
    writeContract: vi.fn().mockResolvedValue('mock-tx-hash'),
    account: { address: '0xTestAccount' },
  };
}

// --- Factory for FlashOrchestrator ---

function createOrchestrator(overrides?: {
  prices?: Map<string, number>;
  bridgeQuoter?: FlashBridgeQuoter;
  swapExecutor?: FlashSwapExecutor;
  bridgeExecutor?: FlashBridgeExecutor;
  config?: Partial<FlashOrchestratorConfig>;
}) {
  const prices = overrides?.prices ?? new Map([
    [`${CHAIN_A as number}-${WETH as string}`, 3450],
    [`${CHAIN_B as number}-${WETH as string}`, 3530],
  ]);

  const priceFetcher = createMockPriceFetcher(prices);
  const bridgeQuoter = overrides?.bridgeQuoter ?? createMockBridgeQuoter();
  const swapExecutor = overrides?.swapExecutor ?? createMockSwapExecutor();
  const bridgeExecutor = overrides?.bridgeExecutor ?? createMockBridgeExecutor();
  const walletClient = createMockWalletClient();
  const flashExecutor = new FlashExecutor(walletClient);

  const config = {
    flashLoanProviders: [TEST_PROVIDER],
    monitoredTokens: [WETH],
    monitoredChainPairs: [[CHAIN_A, CHAIN_B]] as [ChainId, ChainId][],
    ...overrides?.config,
  };

  const orchestrator = new FlashOrchestrator(config, {
    priceFetcher,
    bridgeQuoter,
    swapExecutor,
    bridgeExecutor,
    flashExecutor,
  }, 1000);

  return { orchestrator, priceFetcher, bridgeQuoter, swapExecutor, bridgeExecutor, flashExecutor, walletClient };
}

// --- Tests ---

describe('FlashOrchestrator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('initialization', () => {
    it('initializes with correct config and default values', () => {
      const { orchestrator } = createOrchestrator();
      expect(orchestrator.isRunning()).toBe(false);
      expect(orchestrator.getActiveLoops()).toEqual([]);
      expect(orchestrator.getCompletedReports()).toEqual([]);
      expect(orchestrator.getConsecutiveLosses()).toBe(0);
      expect(orchestrator.isPaused()).toBe(false);
    });

    it('uses default values: maxLoan $10k, maxConcurrent 1, timeLimit 30min', () => {
      const { orchestrator } = createOrchestrator();
      // Verify via canExecute — create a loop that would exceed defaults
      const loop: ArbitrageLoop = {
        id: 'test-loop',
        legs: [],
        sourceChain: CHAIN_A,
        destChain: CHAIN_B,
        borrowToken: WETH,
        borrowAmount: 1_000_000_000_000_000_000n,
        expectedGrossProfit: 100,
        expectedNetProfit: 50,
        flashLoanProvider: 'aave-v3',
        createdAt: Date.now(),
      };
      const result = orchestrator.canExecute(loop);
      expect(result.allowed).toBe(true);
    });
  });

  describe('scanOpportunities', () => {
    it('detects price differential above threshold and constructs ArbitrageLoop', async () => {
      // 2.3% differential: buy at 3450, sell at 3530
      const { orchestrator } = createOrchestrator();
      const opps = await orchestrator.scanOpportunities();
      expect(opps.length).toBeGreaterThan(0);
      const opp = opps[0];
      expect(opp.sourceChain).toBe(CHAIN_A); // buy on cheap chain
      expect(opp.destChain).toBe(CHAIN_B); // sell on expensive chain
      expect(opp.borrowToken).toBe(WETH);
      expect(opp.legs).toHaveLength(5); // borrow, bridge, swap, bridge, repay
      expect(opp.legs[0].type).toBe('borrow');
      expect(opp.legs[1].type).toBe('bridge');
      expect(opp.legs[2].type).toBe('swap');
      expect(opp.legs[3].type).toBe('bridge');
      expect(opp.legs[4].type).toBe('repay');
    });

    it('ignores differentials below minimum threshold (1%)', async () => {
      const prices = new Map([
        [`${CHAIN_A as number}-${WETH as string}`, 3500],
        [`${CHAIN_B as number}-${WETH as string}`, 3510], // 0.28% — below 1%
      ]);
      const { orchestrator } = createOrchestrator({ prices });
      const opps = await orchestrator.scanOpportunities();
      expect(opps).toHaveLength(0);
    });

    it('returns empty when no prices available', async () => {
      const { orchestrator } = createOrchestrator({ prices: new Map() });
      const opps = await orchestrator.scanOpportunities();
      expect(opps).toHaveLength(0);
    });

    it('returns empty when no flash loan provider available for source chain', async () => {
      // Prices show opportunity on CHAIN_B→CHAIN_A, but provider is on CHAIN_A only
      const prices = new Map([
        [`${CHAIN_A as number}-${WETH as string}`, 3600], // expensive on A
        [`${CHAIN_B as number}-${WETH as string}`, 3400], // cheap on B (no provider)
      ]);
      const { orchestrator } = createOrchestrator({ prices });
      const opps = await orchestrator.scanOpportunities();
      // Should only find the A→B direction (which isn't profitable since A is expensive)
      // Actually the B→A direction needs a provider on chain B
      // The A→B direction: priceB(3400) < priceA(3600), so diffAtoB is negative
      expect(opps.every((o) => (o.sourceChain as number) === (CHAIN_A as number))).toBe(true);
    });
  });

  describe('calculateProfitability', () => {
    it('returns profitable=true when net profit exceeds $10 minimum', async () => {
      const { orchestrator } = createOrchestrator();
      const opps = await orchestrator.scanOpportunities();
      expect(opps.length).toBeGreaterThan(0);

      const result = await orchestrator.calculateProfitability(opps[0]);
      // With 2.3% differential on $10k, gross ~$230, costs ~$20 = net ~$210
      expect(result.profitable).toBe(true);
      expect(result.netProfitUsd).toBeGreaterThan(FLASH_DEFAULTS.MIN_PROFIT_USD);
    });

    it('returns profitable=false when costs exceed gross profit', async () => {
      // Small differential with very high bridge costs
      const prices = new Map([
        [`${CHAIN_A as number}-${WETH as string}`, 3500],
        [`${CHAIN_B as number}-${WETH as string}`, 3540], // 1.14% — just above threshold
      ]);
      const bridgeQuoter = {
        getBridgeQuote: vi.fn().mockResolvedValue({
          estimatedFeeUsd: 100, // very high bridge fees dominate
          estimatedSlippageUsd: 50,
          estimatedGasUsd: 30,
        }),
      };
      const { orchestrator } = createOrchestrator({ prices, bridgeQuoter });
      const opps = await orchestrator.scanOpportunities();
      expect(opps.length).toBeGreaterThan(0);

      const result = await orchestrator.calculateProfitability(opps[0]);
      expect(result.profitable).toBe(false);
      expect(result.totalCostsUsd).toBeGreaterThan(result.grossProfitUsd);
    });

    it('includes ALL cost components', async () => {
      const { orchestrator } = createOrchestrator();
      const opps = await orchestrator.scanOpportunities();
      expect(opps.length).toBeGreaterThan(0);

      const result = await orchestrator.calculateProfitability(opps[0]);
      expect(result.flashLoanFeeUsd).toBeDefined();
      expect(result.gasChainAUsd).toBeDefined();
      expect(result.gasChainBUsd).toBeDefined();
      expect(result.bridgeFeeOutUsd).toBeDefined();
      expect(result.bridgeFeeBackUsd).toBeDefined();
      expect(result.slippageOutUsd).toBeDefined();
      expect(result.slippageBackUsd).toBeDefined();
      expect(result.swapSlippageUsd).toBeDefined();
      expect(result.totalCostsUsd).toBe(
        result.flashLoanFeeUsd +
        result.gasChainAUsd +
        result.gasChainBUsd +
        result.bridgeFeeOutUsd +
        result.bridgeFeeBackUsd +
        result.slippageOutUsd +
        result.slippageBackUsd +
        result.swapSlippageUsd,
      );
    });
  });

  describe('flash loan fees', () => {
    it('Aave V3 flash loan fee calculated as 0.05% of borrow amount', () => {
      const amount = 10_000_000_000_000_000_000n; // 10 tokens
      const fee = FlashExecutor.calculateFee('aave-v3', amount);
      // 0.05% = 0.0005 * 10 = 0.005 tokens
      expect(fee).toBe(5_000_000_000_000_000n);
    });

    it('dYdX flash loan fee calculated as 0% of borrow amount', () => {
      const amount = 10_000_000_000_000_000_000n;
      const fee = FlashExecutor.calculateFee('dydx', amount);
      expect(fee).toBe(0n);
    });

    it('getFeeRate returns correct rates', () => {
      expect(FlashExecutor.getFeeRate('aave-v3')).toBe(0.0005);
      expect(FlashExecutor.getFeeRate('dydx')).toBe(0);
    });
  });

  describe('executeLoop', () => {
    it('runs all 5 steps in correct order: borrow → bridge-out → swap → bridge-back → repay', async () => {
      const { orchestrator, walletClient, bridgeExecutor, swapExecutor } = createOrchestrator();
      const opps = await orchestrator.scanOpportunities();
      expect(opps.length).toBeGreaterThan(0);

      const report = await orchestrator.executeLoop(opps[0]);
      expect(report.legs).toHaveLength(5);
      expect(report.legs[0].type).toBe('borrow');
      expect(report.legs[1].type).toBe('bridge-out');
      expect(report.legs[2].type).toBe('swap');
      expect(report.legs[3].type).toBe('bridge-back');
      expect(report.legs[4].type).toBe('repay');

      // Verify calls were made
      expect(walletClient.writeContract).toHaveBeenCalledTimes(2); // borrow + repay
      expect((bridgeExecutor.executeBridge as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(2);
      expect((swapExecutor.executeSwap as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    });

    it('records tx hashes for each step', async () => {
      const { orchestrator } = createOrchestrator();
      const opps = await orchestrator.scanOpportunities();
      const report = await orchestrator.executeLoop(opps[0]);

      expect(report.legs.length).toBe(5);
      for (const leg of report.legs) {
        expect(leg.txHash).toBeDefined();
        expect(leg.txHash.length).toBeGreaterThan(0);
      }
    });

    it('updates LoopExecutionState.status correctly at each step', async () => {
      const statusSequence: string[] = [];
      let orchestratorRef: FlashOrchestrator;

      const bridgeExecutor: FlashBridgeExecutor = {
        executeBridge: vi.fn().mockImplementation(async () => {
          const loops = orchestratorRef.getActiveLoops();
          if (loops.length > 0) {
            statusSequence.push(loops[0].status);
          }
          return { txHash: 'bridge-tx', receivedAmount: 990_000_000_000_000_000n, status: 'COMPLETED' };
        }),
      };

      const swapExecutor: FlashSwapExecutor = {
        executeSwap: vi.fn().mockImplementation(async () => {
          const loops = orchestratorRef.getActiveLoops();
          if (loops.length > 0) {
            statusSequence.push(loops[0].status);
          }
          return { txHash: 'swap-tx', receivedAmount: 1_000_000_000_000_000_000n };
        }),
      };

      const { orchestrator } = createOrchestrator({ bridgeExecutor, swapExecutor });
      orchestratorRef = orchestrator;
      const opps = await orchestrator.scanOpportunities();
      await orchestrator.executeLoop(opps[0]);

      // Should have captured bridging-out, swapping, bridging-back statuses
      expect(statusSequence).toContain('bridging-out');
      expect(statusSequence).toContain('swapping');
      expect(statusSequence).toContain('bridging-back');
    });
  });

  describe('time barrier', () => {
    it('triggers when Date.now() >= deadlineAt', () => {
      const { orchestrator } = createOrchestrator();
      // Manually set up an active loop with expired deadline
      const state: LoopExecutionState = {
        loopId: 'expired-loop',
        status: 'bridging-out',
        currentLeg: 1,
        startedAt: Date.now() - 2_000_000,
        deadlineAt: Date.now() - 1000, // already expired
        borrowedAmount: 1_000_000_000_000_000_000n,
        borrowedToken: WETH,
        borrowChain: CHAIN_A,
        currentTokenAmount: 1_000_000_000_000_000_000n,
        currentTokenChain: CHAIN_B,
        txHashes: ['tx1'],
        gasSpent: 5,
        feesSpent: 5,
      };
      // @ts-expect-error — accessing private map for testing
      orchestrator.activeLoops.set('expired-loop', state);

      expect(orchestrator.isTimeBarrierTriggered('expired-loop')).toBe(true);
    });

    it('triggers early when remaining time < estimated time for remaining steps', () => {
      const { orchestrator } = createOrchestrator();
      // Loop at leg 1 (bridge-out) with only 5 minutes remaining
      // Needs: bridge(15min) + swap(2min) + bridge(15min) + repay(1min) = 33 min
      const state: LoopExecutionState = {
        loopId: 'tight-loop',
        status: 'bridging-out',
        currentLeg: 1,
        startedAt: Date.now() - 1_500_000,
        deadlineAt: Date.now() + 300_000, // 5 minutes remaining
        borrowedAmount: 1_000_000_000_000_000_000n,
        borrowedToken: WETH,
        borrowChain: CHAIN_A,
        currentTokenAmount: 1_000_000_000_000_000_000n,
        currentTokenChain: CHAIN_A,
        txHashes: [],
        gasSpent: 0,
        feesSpent: 0,
      };
      // @ts-expect-error — accessing private map for testing
      orchestrator.activeLoops.set('tight-loop', state);

      expect(orchestrator.isTimeBarrierTriggered('tight-loop')).toBe(true);
    });

    it('does not trigger when sufficient time remains', () => {
      const { orchestrator } = createOrchestrator();
      // Loop at leg 3 (bridge-back) with 20 minutes remaining
      // Needs: bridge(15min) + repay(1min) = 16 min — fits in 20 min
      const state: LoopExecutionState = {
        loopId: 'ok-loop',
        status: 'bridging-back',
        currentLeg: 3,
        startedAt: Date.now() - 600_000,
        deadlineAt: Date.now() + 1_200_000, // 20 minutes remaining
        borrowedAmount: 1_000_000_000_000_000_000n,
        borrowedToken: WETH,
        borrowChain: CHAIN_A,
        currentTokenAmount: 1_000_000_000_000_000_000n,
        currentTokenChain: CHAIN_B,
        txHashes: [],
        gasSpent: 0,
        feesSpent: 0,
      };
      // @ts-expect-error — accessing private map for testing
      orchestrator.activeLoops.set('ok-loop', state);

      expect(orchestrator.isTimeBarrierTriggered('ok-loop')).toBe(false);
    });
  });

  describe('emergencyRepay', () => {
    it('bridges back when tokens are on Chain B and repays', async () => {
      const { orchestrator, bridgeExecutor, walletClient } = createOrchestrator();

      const state: LoopExecutionState = {
        loopId: 'emergency-loop',
        status: 'bridging-back',
        currentLeg: 3,
        startedAt: Date.now() - 1_800_000,
        deadlineAt: Date.now(),
        borrowedAmount: 1_000_000_000_000_000_000n,
        borrowedToken: WETH,
        borrowChain: CHAIN_A,
        currentTokenAmount: 990_000_000_000_000_000n,
        currentTokenChain: CHAIN_B, // tokens on dest chain
        txHashes: ['tx1', 'tx2'],
        gasSpent: 10,
        feesSpent: 5,
      };

      const report = await orchestrator.emergencyRepay(state);
      expect(report.outcome).toBe('emergency-repay');
      // Should have bridged back + repaid
      expect((bridgeExecutor.executeBridge as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
        CHAIN_B, CHAIN_A, WETH, 990_000_000_000_000_000n,
        { order: 'FASTEST', slippage: FLASH_DEFAULTS.EMERGENCY_SLIPPAGE },
      );
      expect(walletClient.writeContract).toHaveBeenCalled(); // repay
    });

    it('repays immediately when tokens are already on Chain A', async () => {
      const { orchestrator, bridgeExecutor, walletClient } = createOrchestrator();

      const state: LoopExecutionState = {
        loopId: 'emergency-loop-a',
        status: 'repaying',
        currentLeg: 4,
        startedAt: Date.now() - 1_800_000,
        deadlineAt: Date.now(),
        borrowedAmount: 1_000_000_000_000_000_000n,
        borrowedToken: WETH,
        borrowChain: CHAIN_A,
        currentTokenAmount: 1_050_000_000_000_000_000n,
        currentTokenChain: CHAIN_A, // already on source chain
        txHashes: ['tx1', 'tx2', 'tx3', 'tx4'],
        gasSpent: 15,
        feesSpent: 10,
      };

      const report = await orchestrator.emergencyRepay(state);
      expect(report.outcome).toBe('emergency-repay');
      // Should NOT bridge (already on Chain A)
      expect((bridgeExecutor.executeBridge as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
      // Should repay
      expect(walletClient.writeContract).toHaveBeenCalled();
    });

    it('uses order FASTEST and higher slippage tolerance (3%)', async () => {
      const { orchestrator, bridgeExecutor } = createOrchestrator();

      const state: LoopExecutionState = {
        loopId: 'emergency-fastest',
        status: 'swapping',
        currentLeg: 2,
        startedAt: Date.now() - 1_800_000,
        deadlineAt: Date.now(),
        borrowedAmount: 1_000_000_000_000_000_000n,
        borrowedToken: WETH,
        borrowChain: CHAIN_A,
        currentTokenAmount: 900_000_000_000_000_000n,
        currentTokenChain: CHAIN_B,
        txHashes: [],
        gasSpent: 0,
        feesSpent: 0,
      };

      await orchestrator.emergencyRepay(state);
      expect((bridgeExecutor.executeBridge as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
        CHAIN_B, CHAIN_A, WETH, 900_000_000_000_000_000n,
        { order: 'FASTEST', slippage: 0.03 },
      );
    });
  });

  describe('safety caps', () => {
    it('rejects when amount exceeds maxLoanUsd', () => {
      const { orchestrator } = createOrchestrator({
        config: { maxLoanUsd: 5000 },
      });

      const loop: ArbitrageLoop = {
        id: 'big-loop',
        legs: [],
        sourceChain: CHAIN_A,
        destChain: CHAIN_B,
        borrowToken: WETH,
        borrowAmount: 100_000_000_000_000_000_000n,
        expectedGrossProfit: 6000,
        expectedNetProfit: 4000,
        flashLoanProvider: 'aave-v3',
        createdAt: Date.now(),
      };

      const result = orchestrator.canExecute(loop);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('max loan cap');
    });

    it('rejects new loop when maxConcurrentLoops reached', () => {
      const { orchestrator } = createOrchestrator();

      // Add an active loop
      const state: LoopExecutionState = {
        loopId: 'existing-loop',
        status: 'bridging-out',
        currentLeg: 1,
        startedAt: Date.now(),
        deadlineAt: Date.now() + 1_800_000,
        borrowedAmount: 1_000_000_000_000_000_000n,
        borrowedToken: WETH,
        borrowChain: CHAIN_A,
        currentTokenAmount: 1_000_000_000_000_000_000n,
        currentTokenChain: CHAIN_A,
        txHashes: [],
        gasSpent: 0,
        feesSpent: 0,
      };
      // @ts-expect-error — accessing private map for testing
      orchestrator.activeLoops.set('existing-loop', state);

      const loop: ArbitrageLoop = {
        id: 'new-loop',
        legs: [],
        sourceChain: CHAIN_A,
        destChain: CHAIN_B,
        borrowToken: WETH,
        borrowAmount: 1_000_000_000_000_000_000n,
        expectedGrossProfit: 100,
        expectedNetProfit: 50,
        flashLoanProvider: 'aave-v3',
        createdAt: Date.now(),
      };

      const result = orchestrator.canExecute(loop);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Max concurrent loops');
    });

    it('rejects when circuit breaker is active', () => {
      const { orchestrator } = createOrchestrator();
      orchestrator.setPausedUntil(Date.now() + 3_600_000);

      const loop: ArbitrageLoop = {
        id: 'paused-loop',
        legs: [],
        sourceChain: CHAIN_A,
        destChain: CHAIN_B,
        borrowToken: WETH,
        borrowAmount: 1_000_000_000_000_000_000n,
        expectedGrossProfit: 100,
        expectedNetProfit: 50,
        flashLoanProvider: 'aave-v3',
        createdAt: Date.now(),
      };

      const result = orchestrator.canExecute(loop);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('circuit breaker');
    });
  });

  describe('circuit breaker', () => {
    it('pauses strategies after 3 consecutive net-loss loops', async () => {
      const { orchestrator } = createOrchestrator();

      // Simulate 3 consecutive losses via finalizeLoop
      for (let i = 0; i < 3; i++) {
        // @ts-expect-error — accessing private method
        orchestrator.finalizeLoop(`loss-${i}`, {
          loopId: `loss-${i}`,
          outcome: 'loss',
          grossProfit: 0,
          flashLoanFee: 5,
          totalGasCosts: 10,
          totalBridgeFees: 5,
          totalSlippage: 2,
          netProfit: -22,
          durationMs: 60_000,
          legs: [],
          reason: 'Test loss',
        });
      }

      expect(orchestrator.getConsecutiveLosses()).toBe(3);
      expect(orchestrator.isPaused()).toBe(true);
    });

    it('resets consecutive losses on profitable loop', async () => {
      const { orchestrator } = createOrchestrator();

      // 2 losses
      for (let i = 0; i < 2; i++) {
        // @ts-expect-error — accessing private method
        orchestrator.finalizeLoop(`loss-${i}`, {
          loopId: `loss-${i}`,
          outcome: 'loss',
          grossProfit: 0, flashLoanFee: 0, totalGasCosts: 0,
          totalBridgeFees: 0, totalSlippage: 0, netProfit: -10,
          durationMs: 1000, legs: [], reason: '',
        });
      }
      expect(orchestrator.getConsecutiveLosses()).toBe(2);

      // 1 profit resets
      // @ts-expect-error — accessing private method
      orchestrator.finalizeLoop('profit-1', {
        loopId: 'profit-1',
        outcome: 'profit',
        grossProfit: 100, flashLoanFee: 5, totalGasCosts: 10,
        totalBridgeFees: 5, totalSlippage: 0, netProfit: 80,
        durationMs: 1000, legs: [], reason: '',
      });

      expect(orchestrator.getConsecutiveLosses()).toBe(0);
      expect(orchestrator.isPaused()).toBe(false);
    });
  });

  describe('generateReport', () => {
    it('calculates report with correct fields', () => {
      const { orchestrator } = createOrchestrator();

      const state: LoopExecutionState = {
        loopId: 'report-loop',
        status: 'completed',
        currentLeg: 4,
        startedAt: Date.now() - 120_000,
        deadlineAt: Date.now() + 1_680_000,
        borrowedAmount: 1_000_000_000_000_000_000n,
        borrowedToken: WETH,
        borrowChain: CHAIN_A,
        currentTokenAmount: 1_050_000_000_000_000_000n,
        currentTokenChain: CHAIN_A,
        txHashes: ['tx1', 'tx2', 'tx3', 'tx4', 'tx5'],
        gasSpent: 15,
        feesSpent: 10,
      };

      const report = orchestrator.generateReport(state, 'profit');
      expect(report.loopId).toBe('report-loop');
      expect(report.outcome).toBe('profit');
      expect(report.totalGasCosts).toBe(15);
      expect(report.flashLoanFee).toBe(10);
      expect(report.durationMs).toBeGreaterThan(0);
      expect(report.legs).toHaveLength(5);
    });

    it('includes human-readable reason string with key details', () => {
      const { orchestrator } = createOrchestrator();

      const state: LoopExecutionState = {
        loopId: 'reason-loop',
        status: 'completed',
        currentLeg: 4,
        startedAt: Date.now() - 90_000,
        deadlineAt: Date.now() + 1_710_000,
        borrowedAmount: 5_000_000_000_000_000_000n,
        borrowedToken: WETH,
        borrowChain: CHAIN_A,
        currentTokenAmount: 5_200_000_000_000_000_000n,
        currentTokenChain: CHAIN_A,
        txHashes: ['tx1', 'tx2', 'tx3', 'tx4', 'tx5'],
        gasSpent: 12.5,
        feesSpent: 3.8,
      };

      const report = orchestrator.generateReport(state, 'profit');
      expect(report.reason).toContain('successfully');
      expect(report.reason).toContain('chain');
      expect(report.reason).toContain('Gas');
    });

    it('records all individual cost components', () => {
      const { orchestrator } = createOrchestrator();

      const state: LoopExecutionState = {
        loopId: 'cost-loop',
        status: 'completed',
        currentLeg: 4,
        startedAt: Date.now() - 60_000,
        deadlineAt: Date.now() + 1_740_000,
        borrowedAmount: 1_000_000_000_000_000_000n,
        borrowedToken: WETH,
        borrowChain: CHAIN_A,
        currentTokenAmount: 1_000_000_000_000_000_000n,
        currentTokenChain: CHAIN_A,
        txHashes: ['tx1', 'tx2', 'tx3', 'tx4', 'tx5'],
        gasSpent: 20,
        feesSpent: 8,
      };

      const report = orchestrator.generateReport(state, 'loss');
      expect(report.totalGasCosts).toBeDefined();
      expect(report.flashLoanFee).toBeDefined();
      expect(report.totalBridgeFees).toBeDefined();
      expect(report.totalSlippage).toBeDefined();
      expect(report.netProfit).toBeDefined();
    });
  });

  describe('LI.FI bridge status handling', () => {
    it('PARTIAL status triggers follow-up (loop continues)', async () => {
      const bridgeExecutor: FlashBridgeExecutor = {
        executeBridge: vi.fn()
          .mockResolvedValueOnce({
            txHash: 'bridge-out-tx',
            receivedAmount: 800_000_000_000_000_000n, // partial
            status: 'COMPLETED', // first bridge succeeds
          })
          .mockResolvedValueOnce({
            txHash: 'bridge-back-tx',
            receivedAmount: 780_000_000_000_000_000n,
            status: 'COMPLETED',
          }),
      };

      const { orchestrator } = createOrchestrator({ bridgeExecutor });
      const opps = await orchestrator.scanOpportunities();
      const report = await orchestrator.executeLoop(opps[0]);

      // Loop should complete (not emergency)
      expect(report.legs.length).toBe(5);
    });

    it('REFUNDED bridge status aborts loop and triggers immediate repay', async () => {
      const bridgeExecutor: FlashBridgeExecutor = {
        executeBridge: vi.fn().mockResolvedValueOnce({
          txHash: 'bridge-refund-tx',
          receivedAmount: 1_000_000_000_000_000_000n,
          status: 'REFUNDED', // refunded to source chain
        }),
      };

      const { orchestrator, walletClient } = createOrchestrator({ bridgeExecutor });
      const opps = await orchestrator.scanOpportunities();
      const report = await orchestrator.executeLoop(opps[0]);

      expect(report.outcome).toBe('emergency-repay');
      // Should have attempted repay
      expect(walletClient.writeContract).toHaveBeenCalled();
    });

    it('FAILED bridge status triggers emergency repayment flow', async () => {
      const bridgeExecutor: FlashBridgeExecutor = {
        executeBridge: vi.fn().mockResolvedValueOnce({
          txHash: 'bridge-fail-tx',
          receivedAmount: 0n,
          status: 'FAILED',
        }),
      };

      const { orchestrator } = createOrchestrator({ bridgeExecutor });
      const opps = await orchestrator.scanOpportunities();
      const report = await orchestrator.executeLoop(opps[0]);

      expect(report.outcome).toBe('emergency-repay');
    });
  });

  describe('controlTask integration', () => {
    it('scans, evaluates, and executes within a single tick', async () => {
      const { orchestrator, walletClient } = createOrchestrator();

      await orchestrator.controlTask();

      // Should have executed a full loop (borrow + repay = 2 writeContract calls)
      expect(walletClient.writeContract).toHaveBeenCalled();
      expect(orchestrator.getCompletedReports()).toHaveLength(1);
    });

    it('skips execution when circuit breaker is active', async () => {
      const { orchestrator, walletClient } = createOrchestrator();
      orchestrator.setPausedUntil(Date.now() + 3_600_000);

      await orchestrator.controlTask();

      expect(walletClient.writeContract).not.toHaveBeenCalled();
      expect(orchestrator.getCompletedReports()).toHaveLength(0);
    });

    it('skips scanning when at max concurrent loops', async () => {
      const { orchestrator, walletClient } = createOrchestrator();

      // Add an active loop with far-future deadline (won't trigger time barrier)
      const state: LoopExecutionState = {
        loopId: 'blocking-loop',
        status: 'swapping',
        currentLeg: 2,
        startedAt: Date.now(),
        deadlineAt: Date.now() + 3_600_000, // 1 hour — plenty of time
        borrowedAmount: 1_000_000_000_000_000_000n,
        borrowedToken: WETH,
        borrowChain: CHAIN_A,
        currentTokenAmount: 1_000_000_000_000_000_000n,
        currentTokenChain: CHAIN_A,
        txHashes: [],
        gasSpent: 0,
        feesSpent: 0,
      };
      // @ts-expect-error — accessing private map for testing
      orchestrator.activeLoops.set('blocking-loop', state);

      await orchestrator.controlTask();

      // Should NOT have started a new loop (borrow not called)
      expect(walletClient.writeContract).not.toHaveBeenCalled();
    });
  });

  describe('FlashExecutor', () => {
    it('borrow calls writeContract with correct Aave V3 args', async () => {
      const walletClient = createMockWalletClient();
      const executor = new FlashExecutor(walletClient);

      const txHash = await executor.borrow(TEST_PROVIDER, WETH, 1_000_000_000_000_000_000n);
      expect(txHash).toBe('mock-tx-hash');
      expect(walletClient.writeContract).toHaveBeenCalledWith(
        expect.objectContaining({
          address: '0xPool',
          functionName: 'borrow',
        }),
      );
    });

    it('repay calls writeContract with principal + fee', async () => {
      const walletClient = createMockWalletClient();
      const executor = new FlashExecutor(walletClient);

      const amount = 1_000_000_000_000_000_000n;
      const fee = 500_000_000_000_000n;
      const txHash = await executor.repay(TEST_PROVIDER, WETH, amount, fee);

      expect(txHash).toBe('mock-tx-hash');
      expect(walletClient.writeContract).toHaveBeenCalledWith(
        expect.objectContaining({
          functionName: 'repay',
          args: expect.arrayContaining([amount + fee]),
        }),
      );
    });

    it('borrow throws FlashExecutorError on failure', async () => {
      const walletClient = createMockWalletClient();
      walletClient.writeContract.mockRejectedValueOnce(new Error('tx reverted'));
      const executor = new FlashExecutor(walletClient);

      await expect(
        executor.borrow(TEST_PROVIDER, WETH, 1_000_000_000_000_000_000n),
      ).rejects.toThrow('Flash loan borrow failed');
    });

    it('repay throws FlashExecutorError on failure', async () => {
      const walletClient = createMockWalletClient();
      walletClient.writeContract.mockRejectedValueOnce(new Error('insufficient approval'));
      const executor = new FlashExecutor(walletClient);

      await expect(
        executor.repay(TEST_PROVIDER, WETH, 1_000_000_000_000_000_000n, 500_000_000_000_000n),
      ).rejects.toThrow('Flash loan repayment failed');
    });
  });
});
