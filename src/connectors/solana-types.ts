// Solana-specific type definitions

import type { ChainId, TokenAddress } from '../core/types.js';

// Solana chain ID used by LI.FI
export const SOLANA_CHAIN_ID = 1151111081099710;

// Wrapped SOL mint address (used as composite key for native SOL balance)
export const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112';

// System program (native SOL)
export const SOLANA_NATIVE_MINT = '11111111111111111111111111111111';

// Confirmation commitment levels — string literal union, not enum
export type SolanaCommitment = 'processed' | 'confirmed' | 'finalized';

// Balance for a single SOL/SPL token
export interface SolanaBalance {
  readonly mint: string;
  readonly amount: bigint;
  readonly decimals: number;
  readonly uiAmount: number;
}

// Solana transaction record
export interface SolanaTransaction {
  readonly signature: string;
  readonly slot: number;
  readonly blockTime: number | null;
  readonly err: unknown | null;
  readonly memo: string | null;
}

// Jupiter quote response
export interface JupiterQuote {
  readonly inputMint: string;
  readonly outputMint: string;
  readonly inAmount: bigint;
  readonly outAmount: bigint;
  readonly priceImpactPct: number;
  readonly routePlan: JupiterRoutePlan[];
  readonly otherAmountThreshold: bigint;
  readonly swapMode: 'ExactIn' | 'ExactOut';
}

// Jupiter route plan step
export interface JupiterRoutePlan {
  readonly swapInfo: {
    readonly ammKey: string;
    readonly label: string;
    readonly inputMint: string;
    readonly outputMint: string;
    readonly inAmount: bigint;
    readonly outAmount: bigint;
    readonly feeAmount: bigint;
    readonly feeMint: string;
  };
  readonly percent: number;
}

// Jupiter swap execution result
export interface JupiterSwapResult {
  readonly signature: string;
  readonly confirmed: boolean;
  readonly inputAmount: bigint;
  readonly outputAmount: bigint;
}

// SolanaConnector config
export interface SolanaConnectorConfig {
  readonly rpcUrl: string;
  readonly commitment: SolanaCommitment;
  readonly keypairSecret: string;
  readonly jupiterApiUrl: string;
}

// Bridge params for Solana cross-chain operations
export interface SolanaBridgeParams {
  readonly fromChainId: ChainId | number;
  readonly toChainId: ChainId | number;
  readonly fromToken: TokenAddress | string;
  readonly toToken: TokenAddress | string;
  readonly fromAddress: string;
  readonly toAddress: string;
  readonly amount: bigint;
  readonly slippage?: number;
}

// Default config values
export const SOLANA_DEFAULTS = {
  RPC_URL: 'https://api.mainnet-beta.solana.com',
  COMMITMENT: 'confirmed' as SolanaCommitment,
  JUPITER_API_URL: 'https://quote-api.jup.ag/v6',
  SLIPPAGE_BPS: 50, // 0.5% = 50 basis points
  CONFIRMATION_TIMEOUT_MS: 60_000, // 60s for confirmed
  FINALIZED_TIMEOUT_MS: 120_000, // 120s for finalized
} as const;
