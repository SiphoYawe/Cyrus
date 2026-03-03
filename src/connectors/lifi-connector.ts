// Main LI.FI connector — orchestrates API calls, caching, and domain mapping

import { LIFI_INTEGRATOR, DEFAULT_SLIPPAGE, CHAIN_TOKEN_CACHE_TTL_MS } from '../core/constants.js';
import { createLogger } from '../utils/logger.js';
import { LiFiHttpClient } from './http-client.js';
import { TTLCache } from './cache.js';
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

const logger = createLogger('lifi-connector');

const CONNECTIONS_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const TOOLS_CACHE_TTL_MS = CHAIN_TOKEN_CACHE_TTL_MS; // 1 hour

export interface LiFiConnectorOptions {
  readonly apiKey?: string;
  readonly httpClient?: LiFiHttpClient;
}

export class LiFiConnector implements LiFiConnectorInterface {
  private readonly httpClient: LiFiHttpClient;
  private readonly chainsCache = new TTLCache<LiFiChain[]>();
  private readonly tokensCache = new TTLCache<LiFiToken[]>();
  private readonly connectionsCache = new TTLCache<LiFiConnection[]>();
  private readonly toolsCache = new TTLCache<LiFiTool[]>();

  constructor(options: LiFiConnectorOptions = {}) {
    this.httpClient = options.httpClient ?? new LiFiHttpClient({ apiKey: options.apiKey });
  }

  async getQuote(params: QuoteParams): Promise<QuoteResult> {
    const slippage = params.slippage ?? DEFAULT_SLIPPAGE;

    logger.info(
      {
        fromChain: params.fromChain,
        toChain: params.toChain,
        fromToken: params.fromToken,
        toToken: params.toToken,
        fromAmount: params.fromAmount,
        slippage,
      },
      'Requesting quote'
    );

    const result = await this.httpClient.get<QuoteResult>('/quote', {
      fromChain: params.fromChain as number,
      toChain: params.toChain as number,
      fromToken: params.fromToken as string,
      toToken: params.toToken as string,
      fromAmount: params.fromAmount,
      slippage,
      integrator: LIFI_INTEGRATOR,
    });

    logger.info(
      {
        tool: result.tool,
        toAmount: result.estimate.toAmount,
        toAmountMin: result.estimate.toAmountMin,
        executionDuration: result.estimate.executionDuration,
      },
      'Quote received'
    );

    return result;
  }

  async getRoutes(params: RouteParams): Promise<RouteResult[]> {
    const slippage = params.slippage ?? DEFAULT_SLIPPAGE;

    logger.info(
      {
        fromChainId: params.fromChainId,
        toChainId: params.toChainId,
        fromTokenAddress: params.fromTokenAddress,
        toTokenAddress: params.toTokenAddress,
        fromAmount: params.fromAmount,
      },
      'Requesting routes'
    );

    const response = await this.httpClient.post<{ routes: RouteResult[] }>('/advanced/routes', {
      fromChainId: params.fromChainId,
      toChainId: params.toChainId,
      fromTokenAddress: params.fromTokenAddress,
      toTokenAddress: params.toTokenAddress,
      fromAmount: params.fromAmount,
      options: {
        slippage,
        order: params.order ?? 'RECOMMENDED',
        integrator: LIFI_INTEGRATOR,
      },
    });

    logger.info({ routeCount: response.routes.length }, 'Routes received');

    return response.routes;
  }

  async getChains(): Promise<LiFiChain[]> {
    const cacheKey = 'chains';
    const cached = this.chainsCache.get(cacheKey);
    if (cached) {
      logger.debug('Returning cached chains');
      return cached;
    }

    logger.debug('Fetching chains from API');
    const response = await this.httpClient.get<{ chains: LiFiChain[] }>('/chains');
    const chains = response.chains;

    this.chainsCache.set(cacheKey, chains, CHAIN_TOKEN_CACHE_TTL_MS);
    logger.info({ chainCount: chains.length }, 'Chains fetched and cached');

    return chains;
  }

  async getTokens(chainId?: number): Promise<LiFiToken[]> {
    const cacheKey = `tokens-${chainId ?? 'all'}`;
    const cached = this.tokensCache.get(cacheKey);
    if (cached) {
      logger.debug({ chainId }, 'Returning cached tokens');
      return cached;
    }

    logger.debug({ chainId }, 'Fetching tokens from API');
    const params: Record<string, string | number | boolean | undefined> = {};
    if (chainId !== undefined) {
      params.chains = chainId;
    }

    const response = await this.httpClient.get<{ tokens: Record<string, LiFiToken[]> }>('/tokens', params);

    // Flatten the tokens map into a single array
    const tokens: LiFiToken[] = [];
    for (const chainTokens of Object.values(response.tokens)) {
      tokens.push(...chainTokens);
    }

    this.tokensCache.set(cacheKey, tokens, CHAIN_TOKEN_CACHE_TTL_MS);
    logger.info({ tokenCount: tokens.length, chainId }, 'Tokens fetched and cached');

    return tokens;
  }

  async getStatus(
    txHash: string,
    bridge: string,
    fromChain: number,
    toChain: number
  ): Promise<LiFiStatusResponse> {
    logger.debug({ txHash, bridge, fromChain, toChain }, 'Checking transfer status');

    const result = await this.httpClient.get<LiFiStatusResponse>('/status', {
      txHash,
      bridge,
      fromChain,
      toChain,
    });

    logger.info(
      { txHash, status: result.status, substatus: result.substatus },
      'Transfer status received'
    );

    return result;
  }

  async getConnections(fromChain: number, toChain: number): Promise<LiFiConnection[]> {
    const cacheKey = `connections-${fromChain}-${toChain}`;
    const cached = this.connectionsCache.get(cacheKey);
    if (cached) {
      logger.debug({ fromChain, toChain }, 'Returning cached connections');
      return cached;
    }

    logger.debug({ fromChain, toChain }, 'Fetching connections from API');
    const response = await this.httpClient.get<{ connections: LiFiConnection[] }>('/connections', {
      fromChain,
      toChain,
    });

    const connections = response.connections;
    this.connectionsCache.set(cacheKey, connections, CONNECTIONS_CACHE_TTL_MS);
    logger.info(
      { fromChain, toChain, connectionCount: connections.length },
      'Connections fetched and cached'
    );

    return connections;
  }

  async getTools(): Promise<LiFiTool[]> {
    const cacheKey = 'tools';
    const cached = this.toolsCache.get(cacheKey);
    if (cached) {
      logger.debug('Returning cached tools');
      return cached;
    }

    logger.debug('Fetching tools from API');
    const response = await this.httpClient.get<{ bridges: LiFiTool[]; exchanges: LiFiTool[] }>('/tools');

    const tools = [...response.bridges, ...response.exchanges];
    this.toolsCache.set(cacheKey, tools, TOOLS_CACHE_TTL_MS);
    logger.info({ toolCount: tools.length }, 'Tools fetched and cached');

    return tools;
  }

  /** Clear all internal caches — useful for tests or forced refresh */
  clearCaches(): void {
    this.chainsCache.clear();
    this.tokensCache.clear();
    this.connectionsCache.clear();
    this.toolsCache.clear();
  }
}
