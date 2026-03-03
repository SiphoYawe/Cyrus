// Vault token registry and protocol info for Composer integration
// Maps known vault/staking/lending token addresses to their protocol metadata
// Used to validate and identify Composer-eligible operations

import type { ChainId, TokenAddress } from '../core/types.js';
import { chainId, tokenAddress } from '../core/types.js';
import { CHAINS } from '../core/constants.js';

export const SUPPORTED_PROTOCOLS = [
  'aave-v3',
  'morpho',
  'euler',
  'pendle',
  'lido',
  'etherfi',
  'ethena',
] as const;

export type SupportedProtocol = (typeof SUPPORTED_PROTOCOLS)[number];

export interface ProtocolInfo {
  readonly protocol: SupportedProtocol;
  readonly chainId: ChainId;
  readonly description: string;
}

// Registry key: lowercase `${chainId}-${tokenAddress}`
function registryKey(chain: ChainId, token: TokenAddress): string {
  return `${chain}-${token.toLowerCase()}`;
}

// Known vault token addresses from LI.FI Composer docs
// Real examples for each supported protocol
const REGISTRY_ENTRIES: ReadonlyArray<
  readonly [ChainId, TokenAddress, SupportedProtocol, string]
> = [
  // --- Morpho ---
  // Morpho vault on Base (from Composer quickstart docs)
  [
    CHAINS.BASE,
    tokenAddress('0x7bfa7c4f149e7415b73bdedfe609237e29cbf34a'),
    'morpho',
    'Morpho USDC vault on Base',
  ],

  // --- Lido ---
  // wstETH on Ethereum (from staking recipes)
  [
    CHAINS.ETHEREUM,
    tokenAddress('0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0'),
    'lido',
    'Lido wstETH on Ethereum',
  ],

  // --- Aave V3 ---
  // aUSDC on Ethereum mainnet
  [
    CHAINS.ETHEREUM,
    tokenAddress('0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c'),
    'aave-v3',
    'Aave V3 aEthUSDC on Ethereum',
  ],
  // aUSDC on Arbitrum
  [
    CHAINS.ARBITRUM,
    tokenAddress('0x724dc807b04555b71ed48a6896b6f41593b8c637'),
    'aave-v3',
    'Aave V3 aArbUSDCn on Arbitrum',
  ],
  // aUSDC on Optimism
  [
    CHAINS.OPTIMISM,
    tokenAddress('0x625e7708f30ca75bfd92586e17077590c60eb4cd'),
    'aave-v3',
    'Aave V3 aOptUSDC on Optimism',
  ],

  // --- Ethena ---
  // sUSDe on Ethereum (staked USDe)
  [
    CHAINS.ETHEREUM,
    tokenAddress('0x9d39a5de30e57443bff2a8307a4256c8797a3497'),
    'ethena',
    'Ethena sUSDe on Ethereum',
  ],

  // --- Euler ---
  // Euler USDC vault on Ethereum
  [
    CHAINS.ETHEREUM,
    tokenAddress('0x797dd80692c3b2dadadbcc6120e7aad7311dc60a'),
    'euler',
    'Euler USDC vault on Ethereum',
  ],

  // --- EtherFi ---
  // eETH on Ethereum
  [
    CHAINS.ETHEREUM,
    tokenAddress('0x35fa164735182de50811e8e2e824cfb9b6118ac2'),
    'etherfi',
    'EtherFi eETH on Ethereum',
  ],

  // --- Pendle ---
  // Pendle PT-stETH on Ethereum (example market)
  [
    CHAINS.ETHEREUM,
    tokenAddress('0xc69ad9bab1dee23f4605a82b3354f8e40d665f49'),
    'pendle',
    'Pendle PT-stETH on Ethereum',
  ],
] as const;

// Build the registry map
const registry = new Map<string, ProtocolInfo>();
for (const [chain, token, protocol, description] of REGISTRY_ENTRIES) {
  registry.set(registryKey(chain, token), { protocol, chainId: chain, description });
}

/**
 * Immutable map of known vault token addresses to protocol info.
 * Keyed by `${chainId}-${lowercaseTokenAddress}`.
 */
export const VAULT_TOKEN_REGISTRY: ReadonlyMap<string, ProtocolInfo> = registry;

/**
 * Check if a token address is a known vault token on the given chain.
 */
export function isVaultToken(token: TokenAddress, chain: ChainId): boolean {
  return registry.has(registryKey(chain, token));
}

/**
 * Get protocol info for a known vault token address on the given chain.
 * Returns undefined if the token is not in the registry.
 */
export function getProtocolInfo(
  token: TokenAddress,
  chain: ChainId,
): ProtocolInfo | undefined {
  return registry.get(registryKey(chain, token));
}

/**
 * Check if a protocol name is in the supported protocols list.
 */
export function isSupportedProtocol(protocol: string): protocol is SupportedProtocol {
  return (SUPPORTED_PROTOCOLS as readonly string[]).includes(protocol);
}
