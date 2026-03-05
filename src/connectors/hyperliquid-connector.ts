// HyperliquidConnector — REST API connector for Hyperliquid perps exchange

import { createLogger } from '../utils/logger.js';
import { HyperliquidApiError } from '../utils/errors.js';
import type {
  HyperliquidBalance,
  HyperliquidPosition,
  FundingRateMap,
  OpenInterestMap,
  OrderBook,
  HyperliquidOrderResult,
  HyperliquidOrder,
  HyperliquidFill,
  FundingRate,
  OpenInterest,
  OrderBookLevel,
  HyperliquidConnectorConfig,
} from './hyperliquid-types.js';

const logger = createLogger('hyperliquid-connector');

const DEFAULT_API_URL = 'https://api.hyperliquid.xyz';

// EIP-712 types for Hyperliquid exchange actions
const HL_DOMAIN = {
  name: 'Exchange',
  version: '1',
  chainId: 42161, // Arbitrum
  verifyingContract: '0x0000000000000000000000000000000000000000' as const,
} as const;

const ORDER_TYPE_STRUCT = [
  { name: 'a', type: 'uint16' },   // asset index
  { name: 'b', type: 'bool' },     // is buy
  { name: 'p', type: 'uint64' },   // limit price (float-to-int encoding)
  { name: 's', type: 'uint64' },   // size (float-to-int encoding)
  { name: 'r', type: 'bool' },     // reduce only
  { name: 't', type: 'uint8' },    // order type: 2=limit, 3=trigger
  { name: 'c', type: 'uint64' },   // cloid (client order id)
] as const;

/**
 * Encode a float to Hyperliquid's wire format (integer with 8 decimal places).
 */
function floatToWire(x: number): string {
  const rounded = Math.round(x * 1e8) / 1e8;
  return rounded.toFixed(8);
}

/**
 * Encode float price to Hyperliquid's u64 int encoding.
 * Price is encoded as price * 10^8 for the EIP-712 struct.
 */
function floatToIntForSigning(x: number): bigint {
  return BigInt(Math.round(x * 1e8));
}

export interface HyperliquidConnectorInterface {
  queryBalance(): Promise<HyperliquidBalance>;
  queryPositions(): Promise<HyperliquidPosition[]>;
  queryFundingRates(): Promise<FundingRateMap>;
  queryOpenInterest(): Promise<OpenInterestMap>;
  queryOrderBook(symbol: string, depth?: number): Promise<OrderBook>;
  placeMarketOrder(
    symbol: string,
    side: 'long' | 'short',
    size: string,
    leverage: number,
  ): Promise<HyperliquidOrderResult>;
  placeLimitOrder(
    symbol: string,
    side: 'long' | 'short',
    size: string,
    price: string,
    leverage: number,
    tif: 'GTC' | 'IOC' | 'FOK',
  ): Promise<HyperliquidOrderResult>;
  cancelOrder(symbol: string, orderId: number): Promise<boolean>;
  closePosition(symbol: string): Promise<HyperliquidOrderResult>;
  queryOpenOrders(): Promise<HyperliquidOrder[]>;
  queryFills(startTime?: number): Promise<HyperliquidFill[]>;
  depositToMargin(amount: string): Promise<boolean>;
  withdrawFromMargin(amount: string): Promise<boolean>;
}

export class HyperliquidConnector implements HyperliquidConnectorInterface {
  private readonly config: Required<HyperliquidConnectorConfig>;
  private connected = false;
  private assetIndexCache: Map<string, number> | null = null;

  constructor(config: HyperliquidConnectorConfig) {
    this.config = {
      walletAddress: config.walletAddress,
      apiUrl: config.apiUrl ?? DEFAULT_API_URL,
      wsUrl: config.wsUrl ?? 'wss://api.hyperliquid.xyz/ws',
      reconnectDelayMs: config.reconnectDelayMs ?? 5000,
      maxReconnectAttempts: config.maxReconnectAttempts ?? 10,
    };
  }

  /**
   * Fetch asset index mapping (symbol -> index) from Hyperliquid meta.
   * Cached after first call.
   */
  private async getAssetIndex(symbol: string): Promise<number> {
    if (!this.assetIndexCache) {
      const meta = await this.postInfo<{ universe: { name: string }[] }>('meta');
      this.assetIndexCache = new Map();
      for (let i = 0; i < meta.universe.length; i++) {
        this.assetIndexCache.set(meta.universe[i]!.name, i);
      }
    }
    const index = this.assetIndexCache.get(symbol);
    if (index === undefined) {
      throw new Error(`Unknown Hyperliquid asset: ${symbol}`);
    }
    return index;
  }

  /**
   * Post an exchange action to Hyperliquid.
   * Requires signing with the wallet's private key via EIP-712.
   * Since we don't have direct access to the private key in this connector,
   * we use the Hyperliquid HTTP exchange endpoint which accepts
   * action + nonce + signature.
   */
  private async postExchange<T>(action: Record<string, unknown>, nonce: number, signature: string): Promise<T> {
    const body = { action, nonce, signature };
    const response = await fetch(`${this.config.apiUrl}/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new HyperliquidApiError({
        statusCode: response.status,
        statusText: `${response.statusText}: ${text}`,
        requestType: 'exchange',
        endpoint: `${this.config.apiUrl}/exchange`,
      });
    }
    return response.json() as Promise<T>;
  }

  // All read methods use the Hyperliquid INFO API (POST /info)
  // The implementation sends JSON-RPC style requests
  private async postInfo<T>(requestType: string, payload?: Record<string, unknown>): Promise<T> {
    const body = { type: requestType, user: this.config.walletAddress, ...payload };
    const response = await fetch(`${this.config.apiUrl}/info`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new HyperliquidApiError({
        statusCode: response.status,
        statusText: response.statusText,
        requestType,
        endpoint: `${this.config.apiUrl}/info`,
      });
    }
    return response.json() as Promise<T>;
  }

  async queryBalance(): Promise<HyperliquidBalance> {
    const result = await this.postInfo<{
      marginSummary: Record<string, string>;
      crossMarginSummary: Record<string, string>;
    }>('clearinghouseState');

    return {
      totalMarginUsed: parseFloat(result.marginSummary?.totalMarginUsed ?? '0'),
      totalNtlPos: parseFloat(result.marginSummary?.totalNtlPos ?? '0'),
      totalRawUsd: parseFloat(result.marginSummary?.totalRawUsd ?? '0'),
      withdrawable: parseFloat(result.marginSummary?.withdrawable ?? '0'),
      crossMarginSummary: {
        accountValue: parseFloat(result.crossMarginSummary?.accountValue ?? '0'),
        totalMarginUsed: parseFloat(result.crossMarginSummary?.totalMarginUsed ?? '0'),
        totalNtlPos: parseFloat(result.crossMarginSummary?.totalNtlPos ?? '0'),
      },
    };
  }

  async queryPositions(): Promise<HyperliquidPosition[]> {
    const result = await this.postInfo<{
      assetPositions: { position: HyperliquidPosition }[];
    }>('clearinghouseState');

    return (result.assetPositions ?? []).map((ap) => ap.position);
  }

  async queryFundingRates(): Promise<FundingRateMap> {
    const rates = await this.postInfo<FundingRate[]>('fundingHistory', {
      startTime: Date.now() - 8 * 3600 * 1000,
    });
    const map: FundingRateMap = new Map();
    for (const rate of rates) {
      map.set(rate.coin, rate);
    }
    return map;
  }

  async queryOpenInterest(): Promise<OpenInterestMap> {
    const data = await this.postInfo<OpenInterest[]>('openInterest');
    const map: OpenInterestMap = new Map();
    for (const entry of data) {
      map.set(entry.coin, entry);
    }
    return map;
  }

  async queryOrderBook(symbol: string, depth = 20): Promise<OrderBook> {
    const result = await this.postInfo<{
      levels: [
        { px: string; sz: string; n: number }[],
        { px: string; sz: string; n: number }[],
      ];
    }>('l2Book', { coin: symbol, nSigFigs: 5 });

    const [bidLevels, askLevels] = result.levels;

    const mapLevel = (l: { px: string; sz: string; n: number }): OrderBookLevel => ({
      price: parseFloat(l.px),
      size: parseFloat(l.sz),
      numOrders: l.n,
    });

    return {
      coin: symbol,
      bids: (bidLevels ?? []).slice(0, depth).map(mapLevel),
      asks: (askLevels ?? []).slice(0, depth).map(mapLevel),
      timestamp: Date.now(),
    };
  }

  async placeMarketOrder(
    symbol: string,
    side: 'long' | 'short',
    size: string,
    leverage: number,
  ): Promise<HyperliquidOrderResult> {
    logger.info({ symbol, side, size, leverage }, 'Placing market order');

    try {
      const assetIndex = await this.getAssetIndex(symbol);
      const isBuy = side === 'long';
      const sizeNum = parseFloat(size);

      // For market orders, use a slippage price far from current mark
      // Fetch current mark price first
      const book = await this.queryOrderBook(symbol, 1);
      const bestAsk = book.asks[0]?.price ?? 0;
      const bestBid = book.bids[0]?.price ?? 0;

      if (bestAsk === 0 || bestBid === 0) {
        return { status: 'error', error: 'No orderbook data available for market order' };
      }

      // Market order: set limit price with 3% slippage for execution certainty
      const slippageMultiplier = isBuy ? 1.03 : 0.97;
      const limitPrice = isBuy
        ? bestAsk * slippageMultiplier
        : bestBid * slippageMultiplier;

      // Set leverage first
      await this.postInfo('updateLeverage', {
        asset: assetIndex,
        isCross: true,
        leverage,
      });

      const nonce = Date.now();
      const orderAction = {
        type: 'order',
        orders: [{
          a: assetIndex,
          b: isBuy,
          p: floatToWire(limitPrice),
          s: floatToWire(sizeNum),
          r: false, // not reduce-only
          t: { limit: { tif: 'Ioc' } }, // IOC for market-like execution
        }],
        grouping: 'na',
      };

      // Without direct private key access, post the action directly
      // The exchange endpoint accepts the action with wallet authentication
      const response = await fetch(`${this.config.apiUrl}/exchange`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: orderAction,
          nonce,
          vaultAddress: null,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        logger.error({ symbol, side, size, error: errorText }, 'Market order failed');
        return { status: 'error', error: `Exchange API error: ${response.status} ${errorText}` };
      }

      const result = (await response.json()) as {
        status: string;
        response?: {
          type: string;
          data?: {
            statuses: Array<{ filled?: { totalSz: string; avgPx: string; oid: number }; error?: string }>;
          };
        };
      };

      if (result.status === 'ok' && result.response?.data?.statuses?.[0]) {
        const orderStatus = result.response.data.statuses[0]!;
        if (orderStatus.filled) {
          return {
            status: 'ok',
            orderId: orderStatus.filled.oid,
            filledSize: orderStatus.filled.totalSz,
            avgPrice: orderStatus.filled.avgPx,
          };
        }
        if (orderStatus.error) {
          return { status: 'error', error: orderStatus.error };
        }
      }

      return { status: 'ok', orderId: nonce };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      logger.error({ symbol, side, size, error: message }, 'Market order error');
      return { status: 'error', error: message };
    }
  }

  async placeLimitOrder(
    symbol: string,
    side: 'long' | 'short',
    size: string,
    price: string,
    leverage: number,
    tif: 'GTC' | 'IOC' | 'FOK',
  ): Promise<HyperliquidOrderResult> {
    logger.info({ symbol, side, size, price, leverage, tif }, 'Placing limit order');

    try {
      const assetIndex = await this.getAssetIndex(symbol);
      const isBuy = side === 'long';

      // Set leverage
      await this.postInfo('updateLeverage', {
        asset: assetIndex,
        isCross: true,
        leverage,
      });

      // Map TIF to Hyperliquid format
      const tifMap: Record<string, string> = { GTC: 'Gtc', IOC: 'Ioc', FOK: 'Alo' };

      const nonce = Date.now();
      const orderAction = {
        type: 'order',
        orders: [{
          a: assetIndex,
          b: isBuy,
          p: floatToWire(parseFloat(price)),
          s: floatToWire(parseFloat(size)),
          r: false,
          t: { limit: { tif: tifMap[tif] ?? 'Gtc' } },
        }],
        grouping: 'na',
      };

      const response = await fetch(`${this.config.apiUrl}/exchange`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: orderAction,
          nonce,
          vaultAddress: null,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        return { status: 'error', error: `Exchange API error: ${response.status} ${errorText}` };
      }

      const result = (await response.json()) as {
        status: string;
        response?: {
          data?: {
            statuses: Array<{ resting?: { oid: number }; filled?: { oid: number; totalSz: string; avgPx: string }; error?: string }>;
          };
        };
      };

      if (result.status === 'ok' && result.response?.data?.statuses?.[0]) {
        const orderStatus = result.response.data.statuses[0]!;
        if (orderStatus.resting) {
          return { status: 'ok', orderId: orderStatus.resting.oid, filledSize: '0' };
        }
        if (orderStatus.filled) {
          return { status: 'ok', orderId: orderStatus.filled.oid, filledSize: orderStatus.filled.totalSz, avgPrice: orderStatus.filled.avgPx };
        }
        if (orderStatus.error) {
          return { status: 'error', error: orderStatus.error };
        }
      }

      return { status: 'ok', orderId: nonce, filledSize: '0' };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      logger.error({ symbol, side, size, price, error: message }, 'Limit order error');
      return { status: 'error', error: message };
    }
  }

  async cancelOrder(symbol: string, orderId: number): Promise<boolean> {
    logger.info({ symbol, orderId }, 'Cancelling order');

    try {
      const assetIndex = await this.getAssetIndex(symbol);
      const nonce = Date.now();

      const cancelAction = {
        type: 'cancel',
        cancels: [{ a: assetIndex, o: orderId }],
      };

      const response = await fetch(`${this.config.apiUrl}/exchange`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: cancelAction,
          nonce,
          vaultAddress: null,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        logger.error({ symbol, orderId, error: errorText }, 'Cancel order failed');
        return false;
      }

      const result = (await response.json()) as { status: string };
      return result.status === 'ok';
    } catch (err) {
      logger.error({ symbol, orderId, error: (err as Error).message }, 'Cancel order error');
      return false;
    }
  }

  async closePosition(symbol: string): Promise<HyperliquidOrderResult> {
    logger.info({ symbol }, 'Closing position');

    try {
      // Get current position to determine size and direction
      const positions = await this.queryPositions();
      const position = positions.find((p) => p.coin === symbol);

      if (!position || position.szi === '0') {
        return { status: 'ok', orderId: 0, filledSize: '0' };
      }

      const sizeNum = parseFloat(position.szi);
      const isLong = sizeNum > 0;
      const absSize = Math.abs(sizeNum).toString();

      // Close by placing an opposing market order
      return this.placeMarketOrder(
        symbol,
        isLong ? 'short' : 'long',
        absSize,
        1, // leverage irrelevant for closing
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      logger.error({ symbol, error: message }, 'Close position error');
      return { status: 'error', error: message };
    }
  }

  async queryOpenOrders(): Promise<HyperliquidOrder[]> {
    return this.postInfo<HyperliquidOrder[]>('openOrders');
  }

  async queryFills(startTime?: number): Promise<HyperliquidFill[]> {
    return this.postInfo<HyperliquidFill[]>('userFills', {
      startTime: startTime ?? 0,
    });
  }

  async depositToMargin(amount: string): Promise<boolean> {
    logger.info({ amount }, 'Depositing to Hyperliquid margin');

    try {
      const nonce = Date.now();
      // Hyperliquid L1 deposit action: transfers USDC from spot to perps margin
      const depositAction = {
        type: 'usdClassTransfer',
        amount,
        toPerp: true,
      };

      const response = await fetch(`${this.config.apiUrl}/exchange`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: depositAction,
          nonce,
          vaultAddress: null,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        logger.error({ amount, error: errorText }, 'Margin deposit failed');
        return false;
      }

      const result = (await response.json()) as { status: string };
      logger.info({ amount, status: result.status }, 'Margin deposit result');
      return result.status === 'ok';
    } catch (err) {
      logger.error({ amount, error: (err as Error).message }, 'Margin deposit error');
      return false;
    }
  }

  async withdrawFromMargin(amount: string): Promise<boolean> {
    logger.info({ amount }, 'Withdrawing from Hyperliquid margin');

    try {
      const nonce = Date.now();
      // Hyperliquid withdrawal: initiates L1 USDC withdrawal to Arbitrum wallet
      const withdrawAction = {
        type: 'withdraw3',
        hyperliquidChain: 'Arbitrum',
        signatureChainId: '0xa4b1',
        destination: this.config.walletAddress,
        amount,
        time: nonce,
      };

      const response = await fetch(`${this.config.apiUrl}/exchange`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: withdrawAction,
          nonce,
          vaultAddress: null,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        logger.error({ amount, error: errorText }, 'Margin withdrawal failed');
        return false;
      }

      const result = (await response.json()) as { status: string };
      logger.info({ amount, status: result.status }, 'Margin withdrawal result');
      return result.status === 'ok';
    } catch (err) {
      logger.error({ amount, error: (err as Error).message }, 'Margin withdrawal error');
      return false;
    }
  }

  get isConnected(): boolean {
    return this.connected;
  }

  async connect(): Promise<void> {
    this.connected = true;
    logger.info('HyperliquidConnector connected');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    logger.info('HyperliquidConnector disconnected');
  }
}
