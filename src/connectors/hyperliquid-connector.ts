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

  constructor(config: HyperliquidConnectorConfig) {
    this.config = {
      walletAddress: config.walletAddress,
      apiUrl: config.apiUrl ?? DEFAULT_API_URL,
      wsUrl: config.wsUrl ?? 'wss://api.hyperliquid.xyz/ws',
      reconnectDelayMs: config.reconnectDelayMs ?? 5000,
      maxReconnectAttempts: config.maxReconnectAttempts ?? 10,
    };
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
    // In real implementation, this would use the exchange API with EIP-712 signing
    // For now, return a simulated result structure
    return {
      status: 'ok',
      orderId: Date.now(),
      filledSize: size,
      avgPrice: '0',
    };
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
    return {
      status: 'ok',
      orderId: Date.now(),
      filledSize: '0',
    };
  }

  async cancelOrder(symbol: string, orderId: number): Promise<boolean> {
    logger.info({ symbol, orderId }, 'Cancelling order');
    return true;
  }

  async closePosition(symbol: string): Promise<HyperliquidOrderResult> {
    logger.info({ symbol }, 'Closing position');
    return {
      status: 'ok',
      orderId: Date.now(),
      filledSize: '0',
    };
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
    return true;
  }

  async withdrawFromMargin(amount: string): Promise<boolean> {
    logger.info({ amount }, 'Withdrawing from Hyperliquid margin');
    return true;
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
