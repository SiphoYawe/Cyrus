// Simulated connector for testing and dry-run mode — returns configurable mock data

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
import { createLogger } from '../utils/logger.js';

const logger = createLogger('simulated-connector');

export interface SimulatedConnectorConfig {
  readonly defaultQuote?: Partial<QuoteResult>;
  readonly defaultRoutes?: Partial<RouteResult>[];
  readonly chains?: LiFiChain[];
  readonly tokens?: LiFiToken[];
  readonly status?: Partial<LiFiStatusResponse>;
  readonly connections?: LiFiConnection[];
  readonly tools?: LiFiTool[];
  readonly delayMs?: number;
  readonly errorToThrow?: Error;
}

// Default mock data

const DEFAULT_QUOTE: QuoteResult = {
  transactionRequest: {
    to: '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE',
    data: '0xabcdef',
    value: '0',
    gasLimit: '250000',
    chainId: 1,
  },
  estimate: {
    approvalAddress: '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE',
    toAmount: '999000000',
    toAmountMin: '994000000',
    executionDuration: 180,
    gasCosts: [
      {
        amount: '5000000000000000',
        amountUSD: '12.50',
        token: { symbol: 'ETH' },
      },
    ],
  },
  tool: 'stargate',
  toolDetails: {
    key: 'stargate',
    name: 'Stargate',
    logoURI: 'https://example.com/stargate.png',
  },
  action: {
    fromChainId: 1,
    toChainId: 42161,
    fromToken: {},
    toToken: {},
  },
  includedSteps: [],
};

const DEFAULT_ROUTE: RouteResult = {
  id: 'route-mock-001',
  steps: [],
  toAmountMin: '994000000',
  toAmount: '999000000',
  gasCostUSD: '12.50',
  tags: ['RECOMMENDED'],
};

const DEFAULT_CHAINS: LiFiChain[] = [
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

const DEFAULT_TOKENS: LiFiToken[] = [
  {
    address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    symbol: 'USDC',
    decimals: 6,
    chainId: 1,
    name: 'USD Coin',
    priceUSD: '1.00',
  },
  {
    address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
    symbol: 'WETH',
    decimals: 18,
    chainId: 1,
    name: 'Wrapped Ether',
    priceUSD: '2500.00',
  },
];

const DEFAULT_STATUS: LiFiStatusResponse = {
  status: 'DONE',
  substatus: 'COMPLETED',
  sending: {
    txHash: '0xabc123',
    amount: '1000000000',
    chainId: 1,
  },
  receiving: {
    txHash: '0xdef456',
    amount: '999000000',
    chainId: 42161,
  },
  tool: 'stargate',
  bridge: 'stargate',
};

const DEFAULT_TOOLS: LiFiTool[] = [
  { key: 'stargate', name: 'Stargate', type: 'bridge' },
  { key: 'uniswap', name: 'Uniswap', type: 'exchange' },
];

function deepMerge<T>(target: T, source: Partial<T>): T {
  const result = { ...target };
  for (const key of Object.keys(source) as Array<keyof T>) {
    const sourceVal = source[key];
    if (sourceVal !== undefined) {
      (result as Record<string, unknown>)[key as string] = sourceVal;
    }
  }
  return result;
}

export class SimulatedConnector implements LiFiConnectorInterface {
  private config: SimulatedConnectorConfig;

  constructor(config: SimulatedConnectorConfig = {}) {
    this.config = config;
  }

  /** Update configuration at runtime — useful for injecting errors mid-test */
  configure(config: Partial<SimulatedConnectorConfig>): void {
    this.config = { ...this.config, ...config };
  }

  private async maybeDelay(): Promise<void> {
    if (this.config.delayMs && this.config.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.config.delayMs));
    }
  }

  private maybeThrow(): void {
    if (this.config.errorToThrow) {
      throw this.config.errorToThrow;
    }
  }

  async getQuote(params: QuoteParams): Promise<QuoteResult> {
    logger.debug({ params }, 'Simulated getQuote');
    await this.maybeDelay();
    this.maybeThrow();

    const quote = this.config.defaultQuote
      ? deepMerge(DEFAULT_QUOTE, this.config.defaultQuote)
      : DEFAULT_QUOTE;

    return {
      ...quote,
      action: {
        ...quote.action,
        fromChainId: params.fromChain as number,
        toChainId: params.toChain as number,
      },
    };
  }

  async getRoutes(params: RouteParams): Promise<RouteResult[]> {
    logger.debug({ params }, 'Simulated getRoutes');
    await this.maybeDelay();
    this.maybeThrow();

    if (this.config.defaultRoutes) {
      return this.config.defaultRoutes.map((r) => deepMerge(DEFAULT_ROUTE, r));
    }

    return [DEFAULT_ROUTE];
  }

  async getChains(): Promise<LiFiChain[]> {
    logger.debug('Simulated getChains');
    await this.maybeDelay();
    this.maybeThrow();

    return this.config.chains ?? DEFAULT_CHAINS;
  }

  async getTokens(_chainId?: number): Promise<LiFiToken[]> {
    logger.debug({ chainId: _chainId }, 'Simulated getTokens');
    await this.maybeDelay();
    this.maybeThrow();

    const tokens = this.config.tokens ?? DEFAULT_TOKENS;

    if (_chainId !== undefined) {
      return tokens.filter((t) => t.chainId === _chainId);
    }
    return tokens;
  }

  async getStatus(
    txHash: string,
    bridge: string,
    fromChain: number,
    toChain: number
  ): Promise<LiFiStatusResponse> {
    logger.debug({ txHash, bridge, fromChain, toChain }, 'Simulated getStatus');
    await this.maybeDelay();
    this.maybeThrow();

    const status = this.config.status
      ? deepMerge(DEFAULT_STATUS, this.config.status)
      : DEFAULT_STATUS;

    return status;
  }

  async getConnections(fromChain: number, toChain: number): Promise<LiFiConnection[]> {
    logger.debug({ fromChain, toChain }, 'Simulated getConnections');
    await this.maybeDelay();
    this.maybeThrow();

    return this.config.connections ?? [
      {
        fromChainId: fromChain,
        toChainId: toChain,
        fromTokens: DEFAULT_TOKENS,
        toTokens: DEFAULT_TOKENS,
      },
    ];
  }

  async getTools(): Promise<LiFiTool[]> {
    logger.debug('Simulated getTools');
    await this.maybeDelay();
    this.maybeThrow();

    return this.config.tools ?? DEFAULT_TOOLS;
  }
}
