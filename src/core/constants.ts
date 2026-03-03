import { chainId, tokenAddress } from './types.js';
import type { ChainId, TokenAddress } from './types.js';

// Chain IDs
export const CHAINS = {
  ETHEREUM: chainId(1),
  ARBITRUM: chainId(42161),
  OPTIMISM: chainId(10),
  POLYGON: chainId(137),
  BASE: chainId(8453),
  BSC: chainId(56),
  SOLANA: chainId(1151111081099710),
} as const;

// Native token address — skip approval for this
export const NATIVE_ADDRESS: TokenAddress = tokenAddress(
  '0x0000000000000000000000000000000000000000'
);

// Well-known token addresses per chain
export const USDC_ADDRESSES: Record<number, TokenAddress> = {
  [CHAINS.ETHEREUM]: tokenAddress('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'),
  [CHAINS.ARBITRUM]: tokenAddress('0xaf88d065e77c8cc2239327c5edb3a432268e5831'),
  [CHAINS.OPTIMISM]: tokenAddress('0x0b2c639c533813f4aa9d7837caf62653d097ff85'),
  [CHAINS.POLYGON]: tokenAddress('0x3c499c542cef5e3811e1192ce70d8cc03d5c3359'),
  [CHAINS.BASE]: tokenAddress('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'),
  [CHAINS.BSC]: tokenAddress('0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d'),
};

export const USDT_ADDRESSES: Record<number, TokenAddress> = {
  [CHAINS.ETHEREUM]: tokenAddress('0xdac17f958d2ee523a2206206994597c13d831ec7'),
  [CHAINS.ARBITRUM]: tokenAddress('0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9'),
  [CHAINS.OPTIMISM]: tokenAddress('0x94b008aa00579c1307b0ef2c499ad98a8ce58e58'),
  [CHAINS.POLYGON]: tokenAddress('0xc2132d05d31c914a87c6611c10748aeb04b58e8f'),
  [CHAINS.BSC]: tokenAddress('0x55d398326f99059ff775485246999027b3197955'),
};

export const WETH_ADDRESSES: Record<number, TokenAddress> = {
  [CHAINS.ETHEREUM]: tokenAddress('0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'),
  [CHAINS.ARBITRUM]: tokenAddress('0x82af49447d8a07e3bd95bd0d56f35241523fbab1'),
  [CHAINS.OPTIMISM]: tokenAddress('0x4200000000000000000000000000000000000006'),
  [CHAINS.BASE]: tokenAddress('0x4200000000000000000000000000000000000006'),
};

// LI.FI API
export const LIFI_BASE_URL = 'https://li.quest/v1';
export const LIFI_INTEGRATOR = 'cyrus-agent';

// Defaults
export const DEFAULT_SLIPPAGE = 0.005; // 0.5%
export const DEFAULT_TICK_INTERVAL_MS = 30_000; // 30 seconds
export const DEFAULT_MAX_GAS_COST_USD = 50;
export const DEFAULT_MAX_CONCURRENT_TRANSFERS = 20;
export const DEFAULT_STATUS_POLL_MAX_DURATION_MS = 30 * 60 * 1000; // 30 minutes

// Status polling backoff tiers
export const STATUS_POLL_BACKOFF = {
  TIER_1: { maxAttempt: 6, delayMs: 10_000 },
  TIER_2: { maxAttempt: 12, delayMs: 30_000 },
  TIER_3: { maxAttempt: 24, delayMs: 60_000 },
  TIER_4: { delayMs: 120_000 },
} as const;

// Retry defaults
export const DEFAULT_MAX_RETRIES = 3;
export const DEFAULT_RETRY_BASE_DELAY_MS = 1000;
export const MAX_RETRY_DELAY_MS = 30_000;

// Price cache
export const PRICE_CACHE_TTL_MS = 30_000; // 30 seconds
export const CHAIN_TOKEN_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// Persistence
export const ACTIVITY_LOG_RETENTION_DAYS = 90;
export const DB_FILE_NAME = 'cyrus.db';
