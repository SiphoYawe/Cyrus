// Simulated LI.FI connector for backtesting — uses historical prices for deterministic quotes

import { createLogger } from '../utils/logger.js';
import type { HistoricalDataLoader } from '../backtest/historical-data-loader.js';
import type { FeeModel, TradeRecord } from '../backtest/types.js';
import type {
  LiFiConnectorInterface,
  QuoteParams,
  QuoteResult,
  RouteParams,
  RouteResult,
  LiFiChain,
  LiFiToken,
  LiFiStatusResponse,
  LiFiConnection,
  LiFiTool,
} from './types.js';

const logger = createLogger('simulated-lifi-connector');

/** Simple deterministic PRNG (mulberry32) for reproducible slippage */
function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Internal tracking for in-flight simulated transfers.
 */
interface PendingTransfer {
  readonly txHash: string;
  readonly fromChain: number;
  readonly toChain: number;
  readonly fromToken: string;
  readonly toToken: string;
  readonly fromAmount: bigint;
  readonly toAmount: bigint;
  readonly submittedAt: number;
  readonly bridgeDelayMs: number;
}

export interface SimulatedLiFiConnectorConfig {
  readonly slippage: number;
  readonly bridgeDelayMs: number;
  readonly feeModel: FeeModel;
  readonly seed?: number;
}

/**
 * SimulatedLiFiConnector for backtesting.
 *
 * Unlike the dry-run SimulatedConnector which returns configurable mock data,
 * this connector uses HistoricalDataLoader to produce price-based quotes
 * and simulates trade execution with realistic fee modeling.
 *
 * Implements the same LiFiConnectorInterface for seamless dependency injection.
 */
export class SimulatedLiFiConnector implements LiFiConnectorInterface {
  private readonly dataLoader: HistoricalDataLoader;
  private readonly feeModel: FeeModel;
  private readonly slippage: number;
  private readonly bridgeDelayMs: number;
  private readonly rng: () => number;
  private currentTimestamp: number = 0;
  private readonly tradeLog: TradeRecord[] = [];
  private readonly pendingTransfers: Map<string, PendingTransfer> = new Map();
  private tradeCounter = 0;

  constructor(
    dataLoader: HistoricalDataLoader,
    config: SimulatedLiFiConnectorConfig,
  ) {
    this.dataLoader = dataLoader;
    this.feeModel = config.feeModel;
    this.slippage = config.slippage;
    this.bridgeDelayMs = config.bridgeDelayMs;
    this.rng = mulberry32(config.seed ?? 42);
  }

  // --- Time control ---

  getCurrentTimestamp(): number {
    return this.currentTimestamp;
  }

  setCurrentTimestamp(ts: number): void {
    this.currentTimestamp = ts;
  }

  advanceTo(timestamp: number): void {
    this.currentTimestamp = timestamp;
  }

  // --- LiFiConnectorInterface implementation ---

  async getQuote(params: QuoteParams): Promise<QuoteResult> {
    logger.debug({ params, timestamp: this.currentTimestamp }, 'Simulated getQuote');

    const fromPrice = this.dataLoader.getPrice(
      params.fromToken as string,
      params.fromChain as number,
      this.currentTimestamp,
    );
    const toPrice = this.dataLoader.getPrice(
      params.toToken as string,
      params.toChain as number,
      this.currentTimestamp,
    );

    if (fromPrice === undefined || toPrice === undefined) {
      throw new Error(
        `No historical price data for quote: fromToken=${params.fromToken as string} ` +
        `(price=${fromPrice}), toToken=${params.toToken as string} (price=${toPrice}) ` +
        `at timestamp=${this.currentTimestamp}`,
      );
    }

    const fromAmount = BigInt(params.fromAmount);

    // Compute price ratio and toAmount
    const priceRatio = fromPrice / toPrice;

    // Apply slippage — deterministic from PRNG, bounded by [-slippage, +slippage]
    const slippageFactor = 1 - this.computeSlippage();

    // Apply fees
    const bridgeFee = params.fromChain !== params.toChain ? this.feeModel.bridgeFeePercent : 0;
    const dexFee = this.feeModel.dexFeePercent;
    const totalFeePercent = bridgeFee + dexFee;
    const feeMultiplier = 1 - totalFeePercent;

    // Final toAmount: fromAmount * priceRatio * slippage * fees
    const toAmountRaw = Number(fromAmount) * priceRatio * slippageFactor * feeMultiplier;
    const toAmount = BigInt(Math.floor(toAmountRaw));
    const toAmountMin = BigInt(Math.floor(toAmountRaw * (1 - this.slippage)));

    const gasEstimateUsd = this.feeModel.gasEstimateUsd;

    const txHash = this.generateTxHash();

    const quote: QuoteResult = {
      transactionRequest: {
        to: '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE',
        data: `0xsimulated_${txHash}`,
        value: '0',
        gasLimit: '250000',
        chainId: params.fromChain as number,
      },
      estimate: {
        approvalAddress: '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE',
        toAmount: toAmount.toString(),
        toAmountMin: toAmountMin.toString(),
        executionDuration: Math.ceil(this.bridgeDelayMs / 1000),
        gasCosts: [
          {
            amount: '0',
            amountUSD: gasEstimateUsd.toFixed(2),
            token: { symbol: 'ETH' },
          },
        ],
      },
      tool: 'simulated-bridge',
      toolDetails: {
        key: 'simulated-bridge',
        name: 'Simulated Bridge',
        logoURI: '',
      },
      action: {
        fromChainId: params.fromChain as number,
        toChainId: params.toChain as number,
        fromToken: { address: params.fromToken, chainId: params.fromChain },
        toToken: { address: params.toToken, chainId: params.toChain },
      },
      includedSteps: [],
    };

    return quote;
  }

  async getRoutes(params: RouteParams): Promise<RouteResult[]> {
    logger.debug({ params }, 'Simulated getRoutes');

    const fromPrice = this.dataLoader.getPrice(
      params.fromTokenAddress,
      params.fromChainId,
      this.currentTimestamp,
    );
    const toPrice = this.dataLoader.getPrice(
      params.toTokenAddress,
      params.toChainId,
      this.currentTimestamp,
    );

    if (fromPrice === undefined || toPrice === undefined) {
      return [];
    }

    const fromAmount = BigInt(params.fromAmount);
    const priceRatio = fromPrice / toPrice;
    const toAmountRaw = Number(fromAmount) * priceRatio * (1 - this.feeModel.dexFeePercent);
    const toAmount = BigInt(Math.floor(toAmountRaw));
    const toAmountMin = BigInt(Math.floor(toAmountRaw * (1 - this.slippage)));

    const route: RouteResult = {
      id: `sim-route-${this.currentTimestamp}-${Math.floor(this.rng() * 1e8)}`,
      steps: [],
      toAmountMin: toAmountMin.toString(),
      toAmount: toAmount.toString(),
      gasCostUSD: this.feeModel.gasEstimateUsd.toFixed(2),
      tags: ['SIMULATED'],
    };

    return [route];
  }

  async getChains(): Promise<LiFiChain[]> {
    return [
      {
        id: 1,
        key: 'eth',
        name: 'Ethereum',
        nativeToken: { symbol: 'ETH', decimals: 18, address: '0x0000000000000000000000000000000000000000' },
      },
      {
        id: 42161,
        key: 'arb',
        name: 'Arbitrum',
        nativeToken: { symbol: 'ETH', decimals: 18, address: '0x0000000000000000000000000000000000000000' },
      },
      {
        id: 10,
        key: 'opt',
        name: 'Optimism',
        nativeToken: { symbol: 'ETH', decimals: 18, address: '0x0000000000000000000000000000000000000000' },
      },
    ];
  }

  async getTokens(_chainId?: number): Promise<LiFiToken[]> {
    return [
      {
        address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        symbol: 'USDC',
        decimals: 6,
        chainId: _chainId ?? 1,
        name: 'USD Coin',
        priceUSD: '1.00',
      },
    ];
  }

  async getStatus(
    txHash: string,
    _bridge: string,
    _fromChain: number,
    _toChain: number,
  ): Promise<LiFiStatusResponse> {
    logger.debug({ txHash, timestamp: this.currentTimestamp }, 'Simulated getStatus');

    const pending = this.pendingTransfers.get(txHash);
    if (!pending) {
      return { status: 'DONE', substatus: 'COMPLETED' };
    }

    const elapsed = this.currentTimestamp - pending.submittedAt;
    if (elapsed >= pending.bridgeDelayMs) {
      // Transfer complete — remove from pending
      this.pendingTransfers.delete(txHash);

      return {
        status: 'DONE',
        substatus: 'COMPLETED',
        sending: {
          txHash,
          amount: pending.fromAmount.toString(),
          chainId: pending.fromChain,
        },
        receiving: {
          txHash: `${txHash}-recv`,
          amount: pending.toAmount.toString(),
          chainId: pending.toChain,
        },
        tool: 'simulated-bridge',
        bridge: 'simulated-bridge',
      };
    }

    return {
      status: 'PENDING',
      sending: {
        txHash,
        amount: pending.fromAmount.toString(),
        chainId: pending.fromChain,
      },
      tool: 'simulated-bridge',
      bridge: 'simulated-bridge',
    };
  }

  async getConnections(fromChain: number, toChain: number): Promise<LiFiConnection[]> {
    return [
      {
        fromChainId: fromChain,
        toChainId: toChain,
        fromTokens: [],
        toTokens: [],
      },
    ];
  }

  async getTools(): Promise<LiFiTool[]> {
    return [
      { key: 'simulated-bridge', name: 'Simulated Bridge', type: 'bridge' },
      { key: 'simulated-dex', name: 'Simulated DEX', type: 'exchange' },
    ];
  }

  // --- Trade execution (simulated) ---

  /**
   * Execute a simulated trade based on a quote.
   * Records the trade in the internal log and creates a pending transfer for cross-chain.
   */
  executeTransaction(
    fromToken: string,
    toToken: string,
    fromChain: number,
    toChain: number,
    fromAmount: bigint,
    toAmount: bigint,
  ): string {
    this.tradeCounter++;
    const txHash = this.generateTxHash();

    const fromPrice = this.dataLoader.getPrice(fromToken, fromChain, this.currentTimestamp) ?? 0;
    const slippageApplied = this.computeSlippage();
    const fillPrice = fromPrice * (1 + slippageApplied);

    // Calculate fees
    const bridgeFee = fromChain !== toChain
      ? BigInt(Math.floor(Number(fromAmount) * this.feeModel.bridgeFeePercent))
      : 0n;
    const dexFee = BigInt(Math.floor(Number(fromAmount) * this.feeModel.dexFeePercent));
    const gasFeeTokens = BigInt(Math.floor(this.feeModel.gasEstimateUsd / Math.max(fromPrice, 0.01)));
    const totalFees = bridgeFee + dexFee + gasFeeTokens;

    const tradeRecord: TradeRecord = {
      id: `trade-${this.tradeCounter}`,
      entryTimestamp: this.currentTimestamp,
      exitTimestamp: 0, // set when position is closed
      fromToken,
      toToken,
      fromChain,
      toChain,
      entryPrice: fromPrice,
      exitPrice: 0, // set when position is closed
      amount: fromAmount,
      fillPrice,
      fees: totalFees,
      pnl: 0n, // computed on close
      pnlPercent: 0, // computed on close
    };

    this.tradeLog.push(tradeRecord);

    // For cross-chain, model bridge delay
    if (fromChain !== toChain) {
      this.pendingTransfers.set(txHash, {
        txHash,
        fromChain,
        toChain,
        fromToken,
        toToken,
        fromAmount,
        toAmount,
        submittedAt: this.currentTimestamp,
        bridgeDelayMs: this.bridgeDelayMs,
      });
    }

    logger.debug(
      {
        tradeId: tradeRecord.id,
        txHash,
        fromToken,
        toToken,
        fromAmount: fromAmount.toString(),
        toAmount: toAmount.toString(),
        fillPrice,
        fees: totalFees.toString(),
      },
      'Simulated trade executed',
    );

    return txHash;
  }

  // --- Trade log access ---

  getTradeLog(): TradeRecord[] {
    return [...this.tradeLog];
  }

  getPendingTransfers(): Map<string, PendingTransfer> {
    return new Map(this.pendingTransfers);
  }

  // --- Internal helpers ---

  /**
   * Compute deterministic slippage bounded by [-slippage, +slippage].
   */
  private computeSlippage(): number {
    const rand = this.rng(); // 0 to 1
    return (rand * 2 - 1) * this.slippage; // maps to [-slippage, +slippage]
  }

  /**
   * Generate a deterministic tx hash.
   */
  private generateTxHash(): string {
    const hash = `0xsim_${this.currentTimestamp}_${this.tradeCounter}_${Math.floor(this.rng() * 1e8)}`;
    return hash;
  }
}
