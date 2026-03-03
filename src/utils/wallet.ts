// Wallet setup utility — creates viem clients from private key + RPC URLs
// Supports multiple chains with cached client instances

import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import * as chains from 'viem/chains';
import type { PublicClient, WalletClient, Chain, Transport } from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';
import { createLogger } from './logger.js';

const logger = createLogger('wallet');

// Map of chain IDs to viem chain definitions
const CHAIN_MAP: Record<number, Chain> = {
  1: chains.mainnet,
  10: chains.optimism,
  56: chains.bsc,
  137: chains.polygon,
  8453: chains.base,
  42161: chains.arbitrum,
};

export interface WalletSetup {
  readonly account: PrivateKeyAccount;
  getWalletClient(chainId: number): WalletClient;
  getPublicClient(chainId: number): PublicClient;
}

export interface WalletConfig {
  readonly privateKey: string;
  readonly chainRpcUrls: Record<number, string>;
}

export function createWalletSetup(config: WalletConfig): WalletSetup {
  const account = privateKeyToAccount(config.privateKey as `0x${string}`);

  logger.info(
    { address: account.address },
    'Wallet account initialized',
  );

  const walletClients = new Map<number, WalletClient>();
  const publicClients = new Map<number, PublicClient>();

  function getChain(chainId: number): Chain {
    const chain = CHAIN_MAP[chainId];
    if (chain) return chain;

    // Fallback: create a minimal chain definition
    return {
      id: chainId,
      name: `Chain ${chainId}`,
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: {
        default: { http: [config.chainRpcUrls[chainId] || ''] },
      },
    } as Chain;
  }

  function getTransport(chainId: number): Transport {
    const rpcUrl = config.chainRpcUrls[chainId];
    if (rpcUrl) {
      return http(rpcUrl);
    }
    return http();
  }

  function getWalletClientFn(chainId: number): WalletClient {
    const existing = walletClients.get(chainId);
    if (existing) return existing;

    const chain = getChain(chainId);
    const transport = getTransport(chainId);

    const client = createWalletClient({
      account,
      chain,
      transport,
    });

    walletClients.set(chainId, client);
    logger.debug({ chainId }, 'Wallet client created for chain');
    return client;
  }

  function getPublicClientFn(chainId: number): PublicClient {
    const existing = publicClients.get(chainId);
    if (existing) return existing;

    const chain = getChain(chainId);
    const transport = getTransport(chainId);

    const client = createPublicClient({
      chain,
      transport,
    });

    publicClients.set(chainId, client as PublicClient);
    logger.debug({ chainId }, 'Public client created for chain');
    return client as PublicClient;
  }

  return {
    account,
    getWalletClient: getWalletClientFn,
    getPublicClient: getPublicClientFn,
  };
}
