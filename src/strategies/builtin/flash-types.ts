// Flash strategy types — cross-chain arbitrage using flash loans as capital source

import type { ChainId, TokenAddress } from '../../core/types.js';

// Flash loan provider — string literal union, not enum
export type FlashLoanProvider = 'aave-v3' | 'dydx';

export interface FlashLoanConfig {
  readonly provider: FlashLoanProvider;
  readonly poolAddress: string;
  readonly chainId: ChainId;
  readonly maxLoanUsd: number;
  readonly feePercent: number;
}

export interface ArbitrageLoopLeg {
  readonly type: 'borrow' | 'bridge' | 'swap' | 'repay';
  readonly chainId: ChainId;
  readonly token: TokenAddress;
  readonly amount: bigint;
  readonly estimatedGasUsd: number;
  readonly estimatedFeeUsd: number;
  readonly estimatedSlippageUsd: number;
}

export interface ArbitrageLoop {
  readonly id: string;
  readonly legs: ArbitrageLoopLeg[];
  readonly sourceChain: ChainId;
  readonly destChain: ChainId;
  readonly borrowToken: TokenAddress;
  readonly borrowAmount: bigint;
  readonly expectedGrossProfit: number;
  readonly expectedNetProfit: number;
  readonly flashLoanProvider: FlashLoanProvider;
  readonly createdAt: number;
}

export type LoopExecutionStatus =
  | 'pending'
  | 'borrowing'
  | 'bridging-out'
  | 'swapping'
  | 'bridging-back'
  | 'repaying'
  | 'completed'
  | 'emergency-repay'
  | 'failed';

export interface LoopExecutionState {
  readonly loopId: string;
  status: LoopExecutionStatus;
  currentLeg: number;
  readonly startedAt: number;
  readonly deadlineAt: number;
  readonly borrowedAmount: bigint;
  readonly borrowedToken: TokenAddress;
  readonly borrowChain: ChainId;
  currentTokenAmount: bigint;
  currentTokenChain: ChainId;
  txHashes: string[];
  gasSpent: number;
  feesSpent: number;
}

export interface ProfitabilityResult {
  readonly profitable: boolean;
  readonly grossProfitUsd: number;
  readonly flashLoanFeeUsd: number;
  readonly gasChainAUsd: number;
  readonly gasChainBUsd: number;
  readonly bridgeFeeOutUsd: number;
  readonly bridgeFeeBackUsd: number;
  readonly slippageOutUsd: number;
  readonly slippageBackUsd: number;
  readonly swapSlippageUsd: number;
  readonly totalCostsUsd: number;
  readonly netProfitUsd: number;
}

export interface FlashLoopReport {
  readonly loopId: string;
  readonly outcome: 'profit' | 'loss' | 'emergency-repay';
  readonly grossProfit: number;
  readonly flashLoanFee: number;
  readonly totalGasCosts: number;
  readonly totalBridgeFees: number;
  readonly totalSlippage: number;
  readonly netProfit: number;
  readonly durationMs: number;
  readonly legs: { type: string; txHash: string; status: string }[];
  readonly reason: string;
}

export interface FlashOrchestratorConfig {
  readonly minProfitUsd: number;
  readonly maxLoanUsd: number;
  readonly maxConcurrentLoops: number;
  readonly timeLimitMs: number;
  readonly flashLoanProviders: FlashLoanConfig[];
  readonly monitoredTokens: TokenAddress[];
  readonly monitoredChainPairs: [ChainId, ChainId][];
}

// Dependency interfaces — keeps FlashOrchestrator decoupled from concrete implementations

export interface FlashPriceFetcher {
  getPrice(chainId: ChainId, token: TokenAddress): number | undefined;
}

export interface FlashBridgeQuoter {
  getBridgeQuote(
    fromChain: ChainId,
    toChain: ChainId,
    token: TokenAddress,
    amount: bigint,
  ): Promise<{ estimatedFeeUsd: number; estimatedSlippageUsd: number; estimatedGasUsd: number }>;
}

export interface FlashSwapExecutor {
  executeSwap(
    chainId: ChainId,
    fromToken: TokenAddress,
    toToken: TokenAddress,
    amount: bigint,
  ): Promise<{ txHash: string; receivedAmount: bigint }>;
}

export interface FlashBridgeExecutor {
  executeBridge(
    fromChain: ChainId,
    toChain: ChainId,
    token: TokenAddress,
    amount: bigint,
    options?: { order?: 'FASTEST' | 'CHEAPEST'; slippage?: number },
  ): Promise<{ txHash: string; receivedAmount: bigint; status: 'COMPLETED' | 'PARTIAL' | 'REFUNDED' | 'FAILED' }>;
}

export const FLASH_DEFAULTS = {
  MIN_PROFIT_USD: 10,
  MAX_LOAN_USD: 10_000,
  MAX_CONCURRENT_LOOPS: 1,
  TIME_LIMIT_MS: 1_800_000, // 30 minutes
  MIN_DIFFERENTIAL_PERCENT: 0.01, // 1%
  EMERGENCY_SLIPPAGE: 0.03, // 3%
  CIRCUIT_BREAKER_THRESHOLD: 3, // consecutive losses to trigger pause
  CIRCUIT_BREAKER_PAUSE_MS: 3_600_000, // 1 hour
  BRIDGE_TIME_ESTIMATE_MS: 900_000, // 15 minutes worst case
  SWAP_TIME_ESTIMATE_MS: 120_000, // 2 minutes
  REPAY_TIME_ESTIMATE_MS: 60_000, // 1 minute
} as const;
