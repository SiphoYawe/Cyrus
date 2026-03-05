// PearProtocolConnector — pair trading on Hyperliquid via Pear Protocol
// Pear Protocol enables pair trades by simultaneously opening long/short positions
// on correlated assets on Hyperliquid's perps exchange.

import { createLogger } from '../utils/logger.js';

const logger = createLogger('pear-protocol-connector');

const DEFAULT_API_URL = 'https://api.pear.garden';
const HYPERLIQUID_INFO_URL = 'https://api.hyperliquid.xyz/info';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PearPair {
  readonly id: string;
  readonly symbolA: string;
  readonly symbolB: string;
  readonly spreadMean: number;
  readonly spreadStdDev: number;
  readonly currentSpread: number;
  readonly correlation: number;
}

export interface PearPosition {
  readonly id: string;
  readonly pairId: string;
  readonly longSymbol: string;
  readonly shortSymbol: string;
  readonly longSize: string;
  readonly shortSize: string;
  readonly entrySpread: number;
  readonly currentSpread: number;
  readonly unrealizedPnl: string;
  readonly marginUsed: string;
  readonly openTimestamp: number;
}

export interface SpreadData {
  readonly currentSpread: number;
  readonly historicalMean: number;
  readonly standardDeviation: number;
  readonly zScore: number;
  readonly correlation: number;
  readonly dataPoints: number;
}

export interface PearMargin {
  readonly available: number;
  readonly used: number;
  readonly total: number;
  readonly utilizationPercent: number;
}

export interface PearOrderResult {
  readonly status: 'ok' | 'error';
  readonly positionId?: string;
  readonly error?: string;
}

export interface PearProtocolConnectorConfig {
  readonly apiUrl?: string;
  readonly apiKey?: string;
  readonly walletAddress?: string;
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface PearProtocolConnectorInterface {
  queryPairs(): Promise<PearPair[]>;
  queryPositions(): Promise<PearPosition[]>;
  querySpreadData(pairId: string): Promise<SpreadData>;
  queryMargin(): Promise<PearMargin>;
  openPairTrade(
    pairId: string,
    longSize: string,
    shortSize: string,
    leverage: number,
  ): Promise<PearOrderResult>;
  closePairTrade(positionId: string): Promise<PearOrderResult>;
}

// ---------------------------------------------------------------------------
// Supported pair definitions for Hyperliquid-based pair trading
// ---------------------------------------------------------------------------

const SUPPORTED_PAIRS: Array<{ id: string; symbolA: string; symbolB: string }> = [
  { id: 'ETH-BTC', symbolA: 'ETH', symbolB: 'BTC' },
  { id: 'SOL-ETH', symbolA: 'SOL', symbolB: 'ETH' },
  { id: 'ARB-OP', symbolA: 'ARB', symbolB: 'OP' },
  { id: 'DOGE-SHIB', symbolA: 'DOGE', symbolB: 'SHIB' },
  { id: 'AVAX-SOL', symbolA: 'AVAX', symbolB: 'SOL' },
  { id: 'LINK-UNI', symbolA: 'LINK', symbolB: 'UNI' },
];

// ---------------------------------------------------------------------------
// Connector
// ---------------------------------------------------------------------------

export class PearProtocolConnector implements PearProtocolConnectorInterface {
  private readonly config: Required<Pick<PearProtocolConnectorConfig, 'apiUrl'>> & PearProtocolConnectorConfig;
  private connected = false;
  private readonly openPositions = new Map<string, PearPosition>();
  private readonly spreadHistory = new Map<string, number[]>(); // pairId -> spread history

  constructor(config?: PearProtocolConnectorConfig) {
    this.config = {
      apiUrl: config?.apiUrl ?? DEFAULT_API_URL,
      apiKey: config?.apiKey,
      walletAddress: config?.walletAddress,
    };
  }

  /**
   * Fetch mark prices from Hyperliquid for pair spread computation.
   */
  private async fetchHyperliquidPrices(): Promise<Map<string, number>> {
    const prices = new Map<string, number>();

    try {
      const response = await fetch(HYPERLIQUID_INFO_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
      });

      if (!response.ok) return prices;

      const data = (await response.json()) as [
        { universe: { name: string }[] },
        { markPx: string; openInterest: string }[],
      ];

      const [meta, assetCtxs] = data;
      for (let i = 0; i < meta.universe.length; i++) {
        const name = meta.universe[i]!.name;
        const ctx = assetCtxs[i];
        if (ctx) {
          prices.set(name, parseFloat(ctx.markPx));
        }
      }
    } catch (err) {
      logger.warn({ error: (err as Error).message }, 'Hyperliquid price fetch failed');
    }

    return prices;
  }

  /**
   * Compute the price ratio spread for a pair.
   */
  private computeSpread(priceA: number, priceB: number): number {
    if (priceB === 0) return 0;
    return priceA / priceB;
  }

  async queryPairs(): Promise<PearPair[]> {
    logger.info('Querying available pairs from Hyperliquid');

    const prices = await this.fetchHyperliquidPrices();
    const pairs: PearPair[] = [];

    for (const pair of SUPPORTED_PAIRS) {
      const priceA = prices.get(pair.symbolA);
      const priceB = prices.get(pair.symbolB);

      if (priceA === undefined || priceB === undefined || priceA === 0 || priceB === 0) {
        continue;
      }

      const currentSpread = this.computeSpread(priceA, priceB);

      // Update spread history
      const history = this.spreadHistory.get(pair.id) ?? [];
      history.push(currentSpread);
      // Keep last 1000 data points
      if (history.length > 1000) history.splice(0, history.length - 1000);
      this.spreadHistory.set(pair.id, history);

      // Compute statistics from history
      const n = history.length;
      const mean = history.reduce((s, v) => s + v, 0) / n;
      const variance = n > 1
        ? history.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1)
        : 0;
      const stdDev = Math.sqrt(variance);

      // Compute correlation from recent price changes
      const correlation = n > 10 ? this.computePairCorrelation(pair.symbolA, pair.symbolB, prices) : 0.8;

      pairs.push({
        id: pair.id,
        symbolA: pair.symbolA,
        symbolB: pair.symbolB,
        spreadMean: mean,
        spreadStdDev: stdDev,
        currentSpread,
        correlation,
      });
    }

    return pairs;
  }

  private computePairCorrelation(_symbolA: string, _symbolB: string, _prices: Map<string, number>): number {
    // Without historical price series, approximate correlation from spread stability
    // In a full implementation, this would use historical candle data
    return 0.8; // Conservative default
  }

  async queryPositions(): Promise<PearPosition[]> {
    logger.info('Querying open pair positions');

    if (!this.config.walletAddress) return [...this.openPositions.values()];

    // Also check Hyperliquid for actual positions
    try {
      const response = await fetch(HYPERLIQUID_INFO_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'clearinghouseState', user: this.config.walletAddress }),
      });

      if (!response.ok) return [...this.openPositions.values()];

      const data = (await response.json()) as {
        assetPositions: { position: { coin: string; szi: string; entryPx: string; positionValue: string; unrealizedPnl: string; marginUsed: string } }[];
      };

      const hlPositions = (data.assetPositions ?? []).map((ap) => ap.position);
      const prices = await this.fetchHyperliquidPrices();

      // Match HL positions to pair trades by finding long/short pairs
      const updatedPositions: PearPosition[] = [];

      for (const [posId, pearPos] of this.openPositions) {
        const longHl = hlPositions.find((p) => p.coin === pearPos.longSymbol);
        const shortHl = hlPositions.find((p) => p.coin === pearPos.shortSymbol);

        const longPrice = prices.get(pearPos.longSymbol) ?? 0;
        const shortPrice = prices.get(pearPos.shortSymbol) ?? 0;
        const currentSpread = shortPrice > 0 ? longPrice / shortPrice : pearPos.currentSpread;

        const longPnl = longHl ? parseFloat(longHl.unrealizedPnl) : 0;
        const shortPnl = shortHl ? parseFloat(shortHl.unrealizedPnl) : 0;

        updatedPositions.push({
          ...pearPos,
          currentSpread,
          unrealizedPnl: (longPnl + shortPnl).toFixed(2),
          marginUsed: longHl
            ? (parseFloat(longHl.marginUsed) + parseFloat(shortHl?.marginUsed ?? '0')).toFixed(2)
            : pearPos.marginUsed,
        });
      }

      return updatedPositions;
    } catch (err) {
      logger.warn({ error: (err as Error).message }, 'Position query error');
      return [...this.openPositions.values()];
    }
  }

  async querySpreadData(pairId: string): Promise<SpreadData> {
    logger.info({ pairId }, 'Querying spread data');

    const prices = await this.fetchHyperliquidPrices();
    const pair = SUPPORTED_PAIRS.find((p) => p.id === pairId);
    if (!pair) {
      return { currentSpread: 0, historicalMean: 0, standardDeviation: 0, zScore: 0, correlation: 0, dataPoints: 0 };
    }

    const priceA = prices.get(pair.symbolA) ?? 0;
    const priceB = prices.get(pair.symbolB) ?? 0;
    const currentSpread = priceB > 0 ? priceA / priceB : 0;

    const history = this.spreadHistory.get(pairId) ?? [currentSpread];
    const n = history.length;
    const mean = history.reduce((s, v) => s + v, 0) / n;
    const variance = n > 1 ? history.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1) : 0;
    const stdDev = Math.sqrt(variance);
    const zScore = stdDev > 0 ? (currentSpread - mean) / stdDev : 0;

    return {
      currentSpread,
      historicalMean: mean,
      standardDeviation: stdDev,
      zScore,
      correlation: 0.8,
      dataPoints: n,
    };
  }

  async queryMargin(): Promise<PearMargin> {
    logger.info('Querying margin info');

    if (!this.config.walletAddress) {
      return { available: 0, used: 0, total: 0, utilizationPercent: 0 };
    }

    try {
      const response = await fetch(HYPERLIQUID_INFO_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'clearinghouseState', user: this.config.walletAddress }),
      });

      if (!response.ok) {
        return { available: 0, used: 0, total: 0, utilizationPercent: 0 };
      }

      const data = (await response.json()) as {
        marginSummary: {
          totalMarginUsed: string;
          totalRawUsd: string;
          withdrawable: string;
        };
      };

      const used = parseFloat(data.marginSummary?.totalMarginUsed ?? '0');
      const total = parseFloat(data.marginSummary?.totalRawUsd ?? '0');
      const available = parseFloat(data.marginSummary?.withdrawable ?? '0');
      const utilizationPercent = total > 0 ? (used / total) * 100 : 0;

      return { available, used, total, utilizationPercent };
    } catch (err) {
      logger.warn({ error: (err as Error).message }, 'Margin query error');
      return { available: 0, used: 0, total: 0, utilizationPercent: 0 };
    }
  }

  async openPairTrade(
    pairId: string,
    longSize: string,
    shortSize: string,
    leverage: number,
  ): Promise<PearOrderResult> {
    logger.info({ pairId, longSize, shortSize, leverage }, 'Opening pair trade');

    const pair = SUPPORTED_PAIRS.find((p) => p.id === pairId);
    if (!pair) {
      return { status: 'error', error: `Unknown pair: ${pairId}` };
    }

    try {
      // Open long position on symbolA and short position on symbolB
      // Both via Hyperliquid exchange API
      const nonce = Date.now();

      // Fetch asset indices
      const metaResponse = await fetch(HYPERLIQUID_INFO_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'meta' }),
      });

      if (!metaResponse.ok) {
        return { status: 'error', error: 'Failed to fetch Hyperliquid meta' };
      }

      const meta = (await metaResponse.json()) as { universe: { name: string }[] };
      const indexA = meta.universe.findIndex((u) => u.name === pair.symbolA);
      const indexB = meta.universe.findIndex((u) => u.name === pair.symbolB);

      if (indexA === -1 || indexB === -1) {
        return { status: 'error', error: `Assets not found on Hyperliquid: ${pair.symbolA}/${pair.symbolB}` };
      }

      // Fetch current prices for IOC limit prices
      const prices = await this.fetchHyperliquidPrices();
      const priceA = prices.get(pair.symbolA) ?? 0;
      const priceB = prices.get(pair.symbolB) ?? 0;

      if (priceA === 0 || priceB === 0) {
        return { status: 'error', error: 'Cannot fetch prices for pair assets' };
      }

      // Place both orders simultaneously
      const orderAction = {
        type: 'order',
        orders: [
          {
            a: indexA,
            b: true, // buy (long) symbolA
            p: (priceA * 1.02).toFixed(8), // 2% slippage
            s: parseFloat(longSize).toFixed(8),
            r: false,
            t: { limit: { tif: 'Ioc' } },
          },
          {
            a: indexB,
            b: false, // sell (short) symbolB
            p: (priceB * 0.98).toFixed(8), // 2% slippage
            s: parseFloat(shortSize).toFixed(8),
            r: false,
            t: { limit: { tif: 'Ioc' } },
          },
        ],
        grouping: 'na',
      };

      const response = await fetch('https://api.hyperliquid.xyz/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: orderAction, nonce, vaultAddress: null }),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        return { status: 'error', error: `Exchange error: ${errorText}` };
      }

      const positionId = `pear-pos-${nonce}`;
      const currentSpread = this.computeSpread(priceA, priceB);

      // Track the pair position locally
      this.openPositions.set(positionId, {
        id: positionId,
        pairId,
        longSymbol: pair.symbolA,
        shortSymbol: pair.symbolB,
        longSize,
        shortSize,
        entrySpread: currentSpread,
        currentSpread,
        unrealizedPnl: '0',
        marginUsed: '0',
        openTimestamp: Date.now(),
      });

      logger.info({ positionId, pairId, entrySpread: currentSpread }, 'Pair trade opened');
      return { status: 'ok', positionId };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      logger.error({ pairId, error: message }, 'Open pair trade error');
      return { status: 'error', error: message };
    }
  }

  async closePairTrade(positionId: string): Promise<PearOrderResult> {
    logger.info({ positionId }, 'Closing pair trade');

    const position = this.openPositions.get(positionId);
    if (!position) {
      return { status: 'error', error: `Position not found: ${positionId}` };
    }

    try {
      // Close by placing opposing orders on both legs
      const metaResponse = await fetch(HYPERLIQUID_INFO_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'meta' }),
      });

      if (!metaResponse.ok) {
        return { status: 'error', error: 'Failed to fetch Hyperliquid meta' };
      }

      const meta = (await metaResponse.json()) as { universe: { name: string }[] };
      const indexA = meta.universe.findIndex((u) => u.name === position.longSymbol);
      const indexB = meta.universe.findIndex((u) => u.name === position.shortSymbol);

      const prices = await this.fetchHyperliquidPrices();
      const priceA = prices.get(position.longSymbol) ?? 0;
      const priceB = prices.get(position.shortSymbol) ?? 0;

      const nonce = Date.now();
      const closeAction = {
        type: 'order',
        orders: [
          {
            a: indexA,
            b: false, // sell (close long)
            p: (priceA * 0.98).toFixed(8),
            s: parseFloat(position.longSize).toFixed(8),
            r: true, // reduce only
            t: { limit: { tif: 'Ioc' } },
          },
          {
            a: indexB,
            b: true, // buy (close short)
            p: (priceB * 1.02).toFixed(8),
            s: parseFloat(position.shortSize).toFixed(8),
            r: true,
            t: { limit: { tif: 'Ioc' } },
          },
        ],
        grouping: 'na',
      };

      const response = await fetch('https://api.hyperliquid.xyz/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: closeAction, nonce, vaultAddress: null }),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        return { status: 'error', error: `Exchange error: ${errorText}` };
      }

      this.openPositions.delete(positionId);
      logger.info({ positionId }, 'Pair trade closed');
      return { status: 'ok', positionId };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      logger.error({ positionId, error: message }, 'Close pair trade error');
      return { status: 'error', error: message };
    }
  }

  get isConnected(): boolean {
    return this.connected;
  }

  async connect(): Promise<void> {
    this.connected = true;
    logger.info({ apiUrl: this.config.apiUrl }, 'PearProtocolConnector connected');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.openPositions.clear();
    logger.info('PearProtocolConnector disconnected');
  }
}
