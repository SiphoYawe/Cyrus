// Barrel exports for connectors module

// Types
export type {
  QuoteParams,
  QuoteResult,
  QuoteTransactionRequest,
  QuoteGasCost,
  QuoteEstimate,
  QuoteToolDetails,
  QuoteAction,
  RouteParams,
  RouteResult,
  LiFiChain,
  LiFiNativeToken,
  LiFiToken,
  LiFiConnection,
  LiFiTool,
  LiFiStatusResponse,
  LiFiConnectorInterface,
} from './types.js';

// Cache
export { TTLCache } from './cache.js';

// Error classification
export { classifyLiFiError, ERROR_KIND } from './error-classifier.js';
export type { ClassifiedError, ErrorKind } from './error-classifier.js';

// HTTP client
export { LiFiHttpClient } from './http-client.js';
export type { LiFiHttpClientOptions } from './http-client.js';

// LI.FI connector
export { LiFiConnector } from './lifi-connector.js';
export type { LiFiConnectorOptions } from './lifi-connector.js';

// Simulated connector
export { SimulatedConnector } from './simulated-connector.js';
export type { SimulatedConnectorConfig } from './simulated-connector.js';

// Status parser
export { parseStatusResponse } from './status-parser.js';
export type { StatusUpdate, StatusTokenInfo, StatusTransferInfo } from './status-parser.js';

// Status poller
export { StatusPoller } from './status-poller.js';
export type { PollParams, StatusPollerOptions } from './status-poller.js';

// Hyperliquid connector
export { HyperliquidConnector } from './hyperliquid-connector.js';
export type {
  HyperliquidConnectorInterface,
} from './hyperliquid-connector.js';

// Hyperliquid types
export type {
  HyperliquidBalance,
  HyperliquidPosition,
  HyperliquidOrder,
  FundingRate,
  FundingRateMap,
  OpenInterest,
  OpenInterestMap,
  OrderBook,
  OrderBookLevel,
  HyperliquidOrderResult,
  HyperliquidFill,
  PerpPosition,
  HyperliquidConnectorConfig,
} from './hyperliquid-types.js';

// Pear Protocol connector
export { PearProtocolConnector } from './pear-protocol-connector.js';
export type {
  PearProtocolConnectorInterface,
  PearProtocolConnectorConfig,
  PearPair,
  PearPosition,
  SpreadData,
  PearMargin,
  PearOrderResult,
} from './pear-protocol-connector.js';

// Solana types
export type {
  SolanaBalance,
  SolanaTransaction,
  SolanaCommitment,
  SolanaConnectorConfig,
  JupiterQuote,
  JupiterRoutePlan,
  JupiterSwapResult,
  SolanaBridgeParams,
} from './solana-types.js';
export {
  SOLANA_CHAIN_ID,
  WRAPPED_SOL_MINT,
  SOLANA_NATIVE_MINT,
  SOLANA_DEFAULTS,
} from './solana-types.js';

// Solana connector
export { SolanaConnector, SolanaConnectorError, SolanaConfirmationTimeoutError } from './solana-connector.js';

// Jupiter client
export { JupiterClient, JupiterClientError } from './jupiter-client.js';

// Wallet manager
export { WalletManager, WalletManagerError } from './wallet-manager.js';
export type { WalletManagerConfig } from './wallet-manager.js';

// Hyperliquid order manager
export { HyperliquidOrderManager } from './hyperliquid-order-manager.js';
export type {
  PerpOrderParams,
  PerpOrderResult,
  PerpOrderCancelResult,
  PerpOrderStatus,
  OrderSide,
  OrderType,
  TimeInForce,
  OrderStatus,
} from './hyperliquid-order-manager.js';
