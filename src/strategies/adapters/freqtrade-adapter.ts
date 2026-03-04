import { CrossChainStrategy } from '../cross-chain-strategy.js';
import type {
  StrategySignal,
  ExecutionPlan,
  StrategyContext,
  ChainId,
  TokenInfo,
  Position,
} from '../../core/types.js';
import { chainId, tokenAddress } from '../../core/types.js';
import type {
  SwapAction,
  BridgeAction,
  ExecutorAction,
} from '../../core/action-types.js';
import { CHAINS, USDC_ADDRESSES } from '../../core/constants.js';

// ---------------------------------------------------------------------------
// DataFrame types
// ---------------------------------------------------------------------------

export interface DataFrameRow {
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
  [key: string]: number | boolean | null;
}

export type DataFrame = DataFrameRow[];

// ---------------------------------------------------------------------------
// Freqtrade-compatible risk config
// ---------------------------------------------------------------------------

export interface FreqtradeRiskConfig {
  readonly stoploss: number; // negative, e.g. -0.10
  readonly minimal_roi: Readonly<Record<string, number>>; // e.g. { "0": 0.04, "30": 0.02 }
  readonly trailing_stop: boolean;
  readonly trailing_stop_positive?: number;
  readonly trailing_stop_positive_offset?: number;
  readonly trailing_only_offset_is_reached?: boolean;
}

// ---------------------------------------------------------------------------
// Signal column names (Freqtrade convention)
// ---------------------------------------------------------------------------

const ENTER_LONG = 'enter_long' as const;
const ENTER_SHORT = 'enter_short' as const;
const EXIT_LONG = 'exit_long' as const;
const EXIT_SHORT = 'exit_short' as const;

// ---------------------------------------------------------------------------
// Action ID generator
// ---------------------------------------------------------------------------

let actionCounter = 0;
function nextActionId(prefix: string): string {
  actionCounter += 1;
  return `${prefix}-${Date.now()}-${actionCounter}`;
}

/** Reset the action counter — for test determinism. */
export function resetActionCounter(): void {
  actionCounter = 0;
}

// ---------------------------------------------------------------------------
// FreqtradeAdapter
// ---------------------------------------------------------------------------

/**
 * Abstract adapter that lets Freqtrade-style strategies work inside CYRUS.
 *
 * Subclasses implement the standard Freqtrade populate_* chain:
 *   1. populateIndicators — add indicator columns to dataframe
 *   2. populateEntryTrend — set enter_long / enter_short flags
 *   3. populateExitTrend  — set exit_long / exit_short flags
 *
 * The adapter translates Freqtrade risk parameters and signals into
 * CYRUS StrategySignal / ExecutionPlan objects.
 */
export abstract class FreqtradeAdapter extends CrossChainStrategy {
  // --- Injected market data ---
  private ohlcvData: DataFrame = [];
  private tradeToken: TokenInfo | null = null;
  private tradeChain: ChainId = CHAINS.ETHEREUM;

  // --- Abstract populate methods (Freqtrade pattern) ---

  abstract populateIndicators(dataframe: DataFrame): DataFrame;
  abstract populateEntryTrend(dataframe: DataFrame): DataFrame;
  abstract populateExitTrend(dataframe: DataFrame): DataFrame;

  // --- Data injection ---

  /** Inject OHLCV candle data for the strategy to analyze. */
  setOhlcvData(data: DataFrame): void {
    this.ohlcvData = data;
  }

  /** Set the target token and chain for trading. */
  setTradeToken(token: TokenInfo, chain: ChainId): void {
    this.tradeToken = token;
    this.tradeChain = chain;
  }

  /** Get the currently injected OHLCV data (for testing). */
  getOhlcvData(): DataFrame {
    return this.ohlcvData;
  }

  /** Get the currently set trade token (for testing). */
  getTradeToken(): TokenInfo | null {
    return this.tradeToken;
  }

  /** Get the currently set trade chain (for testing). */
  getTradeChain(): ChainId {
    return this.tradeChain;
  }

  // --- Freqtrade risk config accessor ---

  /** Return this strategy's risk parameters as a FreqtradeRiskConfig. */
  getFreqtradeRiskConfig(): FreqtradeRiskConfig {
    // Map CYRUS minimalRoi (number keys) to Freqtrade minimal_roi (string keys)
    const minimalRoiStringKeys: Record<string, number> = {};
    for (const [key, value] of Object.entries(this.minimalRoi)) {
      minimalRoiStringKeys[String(key)] = value;
    }

    return {
      stoploss: this.stoploss,
      minimal_roi: minimalRoiStringKeys,
      trailing_stop: this.trailingStop,
      trailing_stop_positive: this.trailingStopPositive,
    };
  }

  // --- Core strategy implementation ---

  shouldExecute(context: StrategyContext): StrategySignal | null {
    if (this.ohlcvData.length === 0) {
      return null;
    }

    // Run Freqtrade populate chain
    let df = this.populateIndicators([...this.ohlcvData]);
    df = this.populateEntryTrend(df);
    df = this.populateExitTrend(df);

    if (df.length === 0) {
      return null;
    }

    // Read the last row for signals (Freqtrade convention)
    const lastRow = df[df.length - 1];

    // Determine trade token — fallback to USDC on trade chain
    const token = this.tradeToken ?? {
      address: USDC_ADDRESSES[this.tradeChain as number] ?? tokenAddress('0x0000000000000000000000000000000000000000'),
      symbol: 'USDC',
      decimals: 6,
    };

    // Base token (what we swap from/to — typically USDC)
    const baseToken: TokenInfo = {
      address: USDC_ADDRESSES[this.tradeChain as number] ?? tokenAddress('0x0000000000000000000000000000000000000000'),
      symbol: 'USDC',
      decimals: 6,
    };

    // Check max positions
    if (context.positions.length >= this.maxPositions) {
      // Only allow exit signals when at max positions
      if (lastRow[EXIT_LONG] === true) {
        return {
          direction: 'exit',
          tokenPair: { from: token, to: baseToken },
          sourceChain: this.tradeChain,
          destChain: this.tradeChain,
          strength: 0.8,
          reason: `${this.name}: exit_long signal at max positions`,
          metadata: { signalSource: 'freqtrade_adapter', lastRow: this.serializeRow(lastRow) },
        };
      }
      if (lastRow[EXIT_SHORT] === true) {
        return {
          direction: 'exit',
          tokenPair: { from: token, to: baseToken },
          sourceChain: this.tradeChain,
          destChain: this.tradeChain,
          strength: 0.8,
          reason: `${this.name}: exit_short signal at max positions`,
          metadata: { signalSource: 'freqtrade_adapter', lastRow: this.serializeRow(lastRow) },
        };
      }
      return null;
    }

    // Priority: exit signals first, then entry signals
    if (lastRow[EXIT_LONG] === true) {
      return {
        direction: 'exit',
        tokenPair: { from: token, to: baseToken },
        sourceChain: this.tradeChain,
        destChain: this.tradeChain,
        strength: 0.8,
        reason: `${this.name}: exit_long signal`,
        metadata: { signalSource: 'freqtrade_adapter', lastRow: this.serializeRow(lastRow) },
      };
    }

    if (lastRow[EXIT_SHORT] === true) {
      return {
        direction: 'exit',
        tokenPair: { from: token, to: baseToken },
        sourceChain: this.tradeChain,
        destChain: this.tradeChain,
        strength: 0.8,
        reason: `${this.name}: exit_short signal`,
        metadata: { signalSource: 'freqtrade_adapter', lastRow: this.serializeRow(lastRow) },
      };
    }

    if (lastRow[ENTER_LONG] === true) {
      return {
        direction: 'long',
        tokenPair: { from: baseToken, to: token },
        sourceChain: this.tradeChain,
        destChain: this.tradeChain,
        strength: 0.7,
        reason: `${this.name}: enter_long signal`,
        metadata: { signalSource: 'freqtrade_adapter', lastRow: this.serializeRow(lastRow) },
      };
    }

    if (lastRow[ENTER_SHORT] === true) {
      return {
        direction: 'short',
        tokenPair: { from: baseToken, to: token },
        sourceChain: this.tradeChain,
        destChain: this.tradeChain,
        strength: 0.7,
        reason: `${this.name}: enter_short signal`,
        metadata: { signalSource: 'freqtrade_adapter', lastRow: this.serializeRow(lastRow) },
      };
    }

    return null;
  }

  buildExecution(signal: StrategySignal, _context: StrategyContext): ExecutionPlan {
    const now = Date.now();
    const strategyId = this.name;
    const amount = 0n; // Amount resolved at execution time by orchestrator

    const actions: ExecutorAction[] = [];

    // If source and dest chains differ, prepend a bridge action
    const isCrossChain = (signal.sourceChain as number) !== (signal.destChain as number);

    if (isCrossChain) {
      const bridgeAction: BridgeAction = {
        id: nextActionId('bridge'),
        type: 'bridge',
        priority: 1,
        createdAt: now,
        strategyId,
        fromChain: signal.sourceChain,
        toChain: signal.destChain,
        fromToken: signal.tokenPair.from.address,
        toToken: signal.tokenPair.from.address,
        amount,
        metadata: {
          step: 'bridge-to-dest',
          adapter: 'freqtrade',
          direction: signal.direction,
        },
      };
      actions.push(bridgeAction);
    }

    // Swap action
    const swapAction: SwapAction = {
      id: nextActionId('swap'),
      type: 'swap',
      priority: isCrossChain ? 2 : 1,
      createdAt: now,
      strategyId,
      fromChain: signal.destChain,
      toChain: signal.destChain,
      fromToken: signal.tokenPair.from.address,
      toToken: signal.tokenPair.to.address,
      amount,
      slippage: 0.005,
      metadata: {
        step: signal.direction === 'exit' ? 'exit-swap' : 'entry-swap',
        adapter: 'freqtrade',
        direction: signal.direction,
        riskConfig: {
          stoploss: Math.abs(this.stoploss),
          minimalRoi: this.minimalRoi,
          trailingStop: this.trailingStop,
          trailingStopPositive: this.trailingStopPositive,
        },
      },
    };
    actions.push(swapAction);

    // Estimate duration: cross-chain adds ~120s
    const estimatedDurationMs = isCrossChain ? 150_000 : 30_000;

    return {
      id: nextActionId('plan'),
      strategyName: this.name,
      actions,
      estimatedCostUsd: isCrossChain ? 5 : 1,
      estimatedDurationMs,
      metadata: {
        adapter: 'freqtrade',
        direction: signal.direction,
        riskConfig: this.getFreqtradeRiskConfig(),
      },
    };
  }

  // --- Optional customStoploss override support ---

  /**
   * Override customStoploss to allow Freqtrade-style dynamic stop-loss.
   * By default returns the static stoploss value.
   * Subclasses can override for dynamic behavior.
   */
  override customStoploss(_position: Position, _currentProfit: number): number {
    return this.stoploss;
  }

  // --- Internal helpers ---

  /** Serialize a DataFrame row for metadata (convert non-JSON-safe values). */
  private serializeRow(row: DataFrameRow): Record<string, unknown> {
    const serialized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      serialized[key] = value;
    }
    return serialized;
  }
}
